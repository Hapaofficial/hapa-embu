// Driver finance: settlements, tips, commission reserve, monthly statements,
// owner financial summary, session hygiene endpoints. Money math lives in
// lib/finance.js (integer cents); this module is auth + validation + views.
const finance=require('../lib/finance');
const mpesa=require('../lib/mpesa');
const {buildStatementPdf,human:humanize}=require('../lib/statement-pdf');

module.exports=function(app,deps){
 const{q,pool,auth,active,owner,audit,writeLimiter}=deps;
 const dvCap=async(req,res,next)=>{
  const u=(await q(`SELECT capabilities FROM users WHERE id=$1`,[req.user.id])).rows[0];
  if(!u||u.capabilities?.driver!==true)return res.status(403).json({error:'Driver capability required'});
  next();
 };
 const cell=v=>{let s=v==null?'':String(v);if(/^[=+\-@]/.test(s))s="'"+s;if(/[",\r\n]/.test(s))s='"'+s.replace(/"/g,'""')+'"';return s};
 const sendCsv=(res,name,lines)=>{res.set('Content-Type','text/csv; charset=utf-8');res.set('Content-Disposition',`attachment; filename="${name}"`);res.send('\uFEFF'+lines.join('\r\n'))};
 const kesF=v=>v==null?'0.00':Number(v).toFixed(2);
 const NRB_D=new Intl.DateTimeFormat('en-KE',{timeZone:'Africa/Nairobi',year:'numeric',month:'2-digit',day:'2-digit'});
 const nrbD=d=>d?NRB_D.format(new Date(d)).split('/').reverse().join('-'):'';

 // ── Boot: idempotent backfill of references + historical accounting (runs
 // from boot() AFTER the schema is applied; never at module load) ────────────
 deps.financeBoot=()=>finance.backfillFinance(pool,m=>console.log(m));
 // ── Stale-session sweeper (background, in addition to on-demand sweeps) ────
 const sweeper=setInterval(()=>finance.autoCloseStaleSessions(q,{audit:(a,act,tt,ti,d)=>audit(a,act,tt,ti,d)}).catch(e=>console.error('stale sweeper:',e.message)),60000);
 sweeper.unref&&sweeper.unref();

 // ── Session hygiene: heartbeat + logout + owner force-offline ──────────────
 app.post('/api/driver/heartbeat',auth,active,dvCap,async(req,res)=>{
  try{
   await q(`UPDATE driver_availability_sessions SET last_seen_at=NOW() WHERE driver_user_id=$1 AND status IN('online','paused')`,[req.user.id]);
   res.json({ok:true});
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });
 app.post('/api/auth/logout',auth,async(req,res)=>{
  try{
   const s=(await q(`UPDATE driver_availability_sessions SET status='ended',ended_at=NOW(),
     online_seconds=EXTRACT(EPOCH FROM NOW()-started_at)::int,
     paused_seconds=paused_seconds+CASE WHEN status='paused' AND last_paused_at IS NOT NULL THEN EXTRACT(EPOCH FROM NOW()-last_paused_at)::int ELSE 0 END,
     last_paused_at=NULL,end_reason='logout' WHERE driver_user_id=$1 AND status IN('online','paused') RETURNING id`,[req.user.id])).rows;
   for(const row of s){
    await q(`INSERT INTO driver_session_events(session_id,event,reason) VALUES($1,'ended','logout')`,[row.id]);
    await q(`UPDATE ride_offers SET status='withdrawn',responded_at=NOW() WHERE driver_user_id=$1 AND status='pending'`,[req.user.id]);
   }
   res.json({ok:true,sessions_closed:s.length});
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });
 app.post('/api/owner/drivers/:id/force-offline',auth,owner,writeLimiter,async(req,res)=>{
  try{
   const reason=String(req.body?.reason||'').trim();
   if(reason.length<5)return res.status(400).json({error:'A reason is required to force a driver offline'});
   const activeRide=(await q(`SELECT 1 FROM ride_requests WHERE driver_user_id::text=$1 AND status IN('driver_assigned','driver_en_route','driver_arrived','pin_verified','in_progress')`,[req.params.id])).rowCount;
   if(activeRide&&req.body?.confirm_active_ride!==true)return res.status(409).json({error:'Driver has an active ride. Confirm again to force offline anyway.',requires_confirmation:true});
   const s=(await q(`UPDATE driver_availability_sessions SET status='ended',ended_at=NOW(),
     online_seconds=EXTRACT(EPOCH FROM NOW()-started_at)::int,end_reason='forced_offline_by_owner' WHERE driver_user_id::text=$1 AND status IN('online','paused') RETURNING id,driver_user_id`,[req.params.id])).rows;
   if(!s.length)return res.status(404).json({error:'Driver is not online'});
   for(const row of s){
    await q(`INSERT INTO driver_session_events(session_id,event,reason) VALUES($1,'forced_offline',$2)`,[row.id,reason.slice(0,300)]);
    await q(`UPDATE ride_offers SET status='withdrawn',responded_at=NOW() WHERE driver_user_id=$1 AND status='pending'`,[row.driver_user_id]);
   }
   await audit(req.user.id,'driver_session.forced_offline','users',req.params.id,reason.slice(0,300));
   res.json({ok:true,sessions_closed:s.length});
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });

 // ── Rider: tip after a completed ride (never merged into the fare) ─────────
 app.post('/api/rides/:id/tip',auth,active,writeLimiter,async(req,res)=>{
  const client=await pool.connect();
  try{
   const f=finance.flags();
   const r=(await q(`SELECT * FROM ride_requests WHERE id::text=$1`,[String(req.params.id)])).rows[0];
   if(!r)return res.status(404).json({error:'Ride not found'});
   if(String(r.rider_id)!==String(req.user.id))return res.status(403).json({error:'Only the rider can tip'});
   if(!['completed','closed'].includes(r.status)||!r.driver_user_id)return res.status(409).json({error:'Tips are only available after the ride is completed'});
   if(r.completed_at&&Date.now()-new Date(r.completed_at).getTime()>f.tipWindowHours*3600000)return res.status(410).json({error:`The tip window (${f.tipWindowHours}h after the ride) has closed`});
   const amount=Number(req.body?.amount);
   if(!Number.isFinite(amount)||amount<=0)return res.status(400).json({error:'Enter a valid tip amount'});
   if(amount>f.tipMaxKes)return res.status(400).json({error:`Maximum tip is KES ${f.tipMaxKes.toFixed(2)}`});
   const method=String(req.body?.method||'');
   if(!['cash','mpesa'].includes(method))return res.status(400).json({error:'Tip method must be cash or mpesa'});
   await client.query('BEGIN');
   const ref=await finance.nextRef(client,'tip');
   let tip;
   try{
    tip=(await client.query(`INSERT INTO ride_tips(ride_id,rider_user_id,driver_user_id,amount,method,status,verified_by_hapa,reference)
     VALUES($1,$2,$3,$4,$5,$6,false,$7) RETURNING *`,
     [r.id,req.user.id,r.driver_user_id,finance.kes(finance.cents(amount)),method,method==='cash'?'declared':'pending',ref])).rows[0];
   }catch(e){
    await client.query('ROLLBACK');
    if(e.code==='23505')return res.status(409).json({error:'A tip has already been added for this ride'});
    throw e;
   }
   let note;
   if(method==='cash'){
    note='Cash tip declared by Rider - given directly to the Driver, not collected or verified by HAPA.';
   }else{
    const st=mpesa.status();
    if(st.mode==='mock'){
     tip=await finance.confirmMpesaTip(client,tip,'MOCK-TIP-'+Date.now().toString(36).toUpperCase())||tip;
     note='MOCK tip payment - simulated, no real money moves. 100% goes to your driver.';
    }else{
     note='M-Pesa tip recorded as pending. It will be confirmed once the payment completes; 100% goes to your driver.';
    }
   }
   await client.query('COMMIT');
   await audit(req.user.id,'ride_tip.created','ride_tips',tip.id,`ride=${r.id} amount=${tip.amount} method=${method} status=${tip.status}`);
   res.status(201).json({tip:{amount:tip.amount,method:tip.method,status:tip.status,reference:tip.reference,verified_by_hapa:tip.verified_by_hapa},note});
  }catch(e){await client.query('ROLLBACK').catch(()=>{});console.error(e);res.status(500).json({error:'Server error'})}
  finally{client.release()}
 });

 // ── Driver: finance overview ────────────────────────────────────────────────
 app.get('/api/driver/finance',auth,active,dvCap,async(req,res)=>{
  try{
   const f=finance.flags();
   const bal=await finance.driverBalances({query:q},req.user.id);
   const receivables=(await q(`SELECT reference,amount::text,outstanding::text,status,created_at,ride_id FROM driver_receivables WHERE driver_user_id=$1 ORDER BY created_at DESC LIMIT 50`,[req.user.id])).rows;
   const payables=(await q(`SELECT reference,amount::text,outstanding::text,status,source,created_at,ride_id FROM driver_payables WHERE driver_user_id=$1 ORDER BY created_at DESC LIMIT 50`,[req.user.id])).rows;
   const reserve=(await q(`SELECT entry_type,status,amount::text,balance_after::text,reference,created_at FROM driver_commission_reserve_entries WHERE driver_user_id=$1 ORDER BY created_at DESC LIMIT 30`,[req.user.id])).rows;
   const settlements=(await q(`SELECT reference,direction,amount::text,method,status,completed_at,notes FROM driver_settlements WHERE driver_user_id=$1 ORDER BY created_at DESC LIMIT 30`,[req.user.id])).rows;
   const tips=(await q(`SELECT COALESCE(SUM(amount) FILTER(WHERE status='confirmed'),0)::text AS mpesa,COALESCE(SUM(amount) FILTER(WHERE status='declared'),0)::text AS cash_declared FROM ride_tips WHERE driver_user_id=$1`,[req.user.id])).rows[0];
   const statements=(await q(`SELECT id,reference,period_year,period_month,status,summary,issued_at FROM driver_monthly_statements WHERE driver_user_id=$1 ORDER BY period_year DESC,period_month DESC LIMIT 24`,[req.user.id])).rows;
   const owesC=finance.cents(bal.owesHapa);
   res.json({balances:{driver_owes_hapa:bal.owesHapa,hapa_owes_driver:bal.hapaOwes,reserve_balance:bal.reserve},
    tips,receivables,payables,reserve_entries:reserve,settlements,statements,
    cash_ride_eligibility:{credit_limit:f.cashCreditLimit.toFixed(2),eligible_for_cash_rides:owesC<=Math.round(f.cashCreditLimit*100),
     amount_to_restore:owesC>Math.round(f.cashCreditLimit*100)?finance.kes(owesC-Math.round(f.cashCreditLimit*100)):'0.00'},
    reserve_status:{enabled:f.reserveEnabled,legal_approved:f.reserveLegalApproved,
     note:finance.reserveUsable(f)?'Commission Reserve is active: cash-ride commission is taken from your reserve first.':'Commission Reserve top-ups are not enabled yet (pending legal review). Cash-ride commission is recorded as "Driver owes HAPA" and settled with the Owner.'}});
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });
 // Reserve top-up (gated; mock M-Pesa only until real Daraja top-ups are wired)
 app.post('/api/driver/reserve/topup',auth,active,dvCap,writeLimiter,async(req,res)=>{
  const client=await pool.connect();
  try{
   const f=finance.flags();
   if(!finance.reserveUsable(f))return res.status(403).json({error:'Commission Reserve top-ups are not enabled yet (pending legal review). Your commission is settled directly with the Owner instead.'});
   const amount=Number(req.body?.amount);
   if(!Number.isFinite(amount)||amount<=0||amount>50000)return res.status(400).json({error:'Enter a valid top-up amount'});
   const st=mpesa.status();
   if(st.mode!=='mock')return res.status(503).json({error:'M-Pesa reserve top-ups are not connected to live Daraja yet'});
   await client.query('BEGIN');
   const rv=await finance.lockReserve(client,req.user.id);
   const afterC=finance.cents(rv.balance)+finance.cents(amount);
   await client.query(`UPDATE driver_commission_reserves SET balance=$2,updated_at=NOW() WHERE driver_user_id=$1`,[req.user.id,finance.kes(afterC)]);
   const entry=await finance.reserveEntry(client,req.user.id,'topup',finance.cents(amount),afterC,{providerRef:'MOCK-TOPUP-'+Date.now().toString(36).toUpperCase(),meta:{mode:'mock'}});
   await finance.postTxn(client,{type:'reserve_topup',driverId:req.user.id,debit:'hapa_mpesa_collection',credit:'driver_commission_reserve',amount:finance.kes(finance.cents(amount)),idem:'topup:'+entry.id});
   await client.query('COMMIT');
   await audit(req.user.id,'reserve.topup','driver_commission_reserve_entries',entry.id,`amount=${amount} mode=mock`);
   res.status(201).json({entry:{reference:entry.reference,amount:entry.amount,balance_after:entry.balance_after},note:'MOCK top-up - simulated, no real money moves.'});
  }catch(e){await client.query('ROLLBACK').catch(()=>{});console.error(e);res.status(500).json({error:'Server error'})}
  finally{client.release()}
 });

 // ── Owner: per-driver drill-down (per-ride payment direction) ───────────────
 async function driverFinanceView(driverId,qs){
  const drv=(await q(`SELECT id,name,email,status FROM users WHERE id::text=$1`,[driverId])).rows[0];
  if(!drv)return null;
  const vals=[drv.id];let range='';
  if(qs.from&&/^\d{4}-\d{2}-\d{2}$/.test(qs.from)){vals.push(qs.from);range+=` AND (COALESCE(r.completed_at,r.created_at) AT TIME ZONE 'Africa/Nairobi')::date>=$${vals.length}::date`;}
  if(qs.to&&/^\d{4}-\d{2}-\d{2}$/.test(qs.to)){vals.push(qs.to);range+=` AND (COALESCE(r.completed_at,r.created_at) AT TIME ZONE 'Africa/Nairobi')::date<=$${vals.length}::date`;}
  const rides=(await q(`SELECT r.id,r.ride_reference,r.status,r.payment_method,r.pickup_address,r.dest_address,r.completed_at,r.created_at,
    l.gross::text,l.commission::text,l.net::text,rc.reference AS receipt_reference,
    (SELECT outstanding::text FROM driver_receivables dr WHERE dr.ride_id=r.id LIMIT 1) AS owes_hapa_outstanding,
    (SELECT reference FROM driver_receivables dr WHERE dr.ride_id=r.id LIMIT 1) AS receivable_reference,
    (SELECT outstanding::text FROM driver_payables dp WHERE dp.ride_id=r.id AND dp.source='mpesa_fare' LIMIT 1) AS hapa_owes_outstanding,
    (SELECT amount::text FROM ride_tips t WHERE t.ride_id=r.id AND t.status IN('confirmed','declared') LIMIT 1) AS tip_amount,
    (SELECT method FROM ride_tips t WHERE t.ride_id=r.id AND t.status IN('confirmed','declared') LIMIT 1) AS tip_method
   FROM ride_requests r JOIN driver_earnings_ledger l ON l.ride_id=r.id LEFT JOIN ride_receipts rc ON rc.ride_id=r.id
   WHERE r.driver_user_id=$1${range} ORDER BY COALESCE(r.completed_at,r.created_at) DESC LIMIT 500`,vals)).rows;
  const bal=await finance.driverBalances({query:q},drv.id);
  const settlements=(await q(`SELECT s.*,(SELECT json_agg(json_build_object('item_type',i.item_type,'amount',i.amount::text)) FROM driver_settlement_items i WHERE i.settlement_id=s.id) AS items FROM driver_settlements s WHERE s.driver_user_id=$1 ORDER BY s.created_at DESC LIMIT 50`,[drv.id])).rows;
  const reserve=(await q(`SELECT entry_type,status,amount::text,balance_after::text,reference,created_at FROM driver_commission_reserve_entries WHERE driver_user_id=$1 ORDER BY created_at DESC LIMIT 50`,[drv.id])).rows;
  const statements=(await q(`SELECT id,reference,period_year,period_month,status,summary,issued_at,finalized_at FROM driver_monthly_statements WHERE driver_user_id=$1 ORDER BY period_year DESC,period_month DESC LIMIT 24`,[drv.id])).rows;
  return{driver:drv,balances:{driver_owes_hapa:bal.owesHapa,hapa_owes_driver:bal.hapaOwes,reserve_balance:bal.reserve},rides,settlements,reserve_entries:reserve,statements,timezone:'Africa/Nairobi'};
 }
 app.get('/api/owner/drivers/:id/finance',auth,owner,async(req,res)=>{
  try{
   const v=await driverFinanceView(String(req.params.id),req.query);
   if(!v)return res.status(404).json({error:'Driver not found'});
   res.json(v);
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });
 app.get('/api/owner/drivers/:id/finance.csv',auth,owner,async(req,res)=>{
  try{
   const v=await driverFinanceView(String(req.params.id),req.query);
   if(!v)return res.status(404).json({error:'Driver not found'});
   const head=['Date (Africa/Nairobi)','Ride reference','Receipt reference','From','To','Payment method','Gross fare (KES)','HAPA commission (KES)','Driver fare earnings (KES)','Driver owes HAPA outstanding (KES)','HAPA owes Driver outstanding (KES)','Tip (KES)','Tip method','Ride status'];
   const lines=[head.map(cell).join(',')];
   for(const r of v.rides)lines.push([nrbD(r.completed_at||r.created_at),r.ride_reference||'',r.receipt_reference||'',r.pickup_address,r.dest_address,r.payment_method,kesF(r.gross),kesF(r.commission),kesF(r.net),kesF(r.owes_hapa_outstanding||0),kesF(r.hapa_owes_outstanding||0),r.tip_amount?kesF(r.tip_amount):'',r.tip_method||'',r.status].map(cell).join(','));
   await audit(req.user.id,'accounting_export','driver_finance',v.driver.id,`rows=${v.rides.length}`);
   sendCsv(res,'hapa-driver-finance.csv',lines);
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });

 // ── Owner: record a settlement (bidirectional, FIFO, no over-settlement) ────
 app.post('/api/owner/drivers/:id/settlements',auth,owner,writeLimiter,async(req,res)=>{
  const client=await pool.connect();
  try{
   const drv=(await q(`SELECT id FROM users WHERE id::text=$1`,[String(req.params.id)])).rows[0];
   if(!drv)return res.status(404).json({error:'Driver not found'});
   const direction=String(req.body?.direction||'');
   if(!['driver_to_hapa','hapa_to_driver'].includes(direction))return res.status(400).json({error:'Invalid settlement direction'});
   const method=String(req.body?.method||'');
   if(!['mpesa','bank_transfer','cash_office','reserve_offset','manual_external'].includes(method))return res.status(400).json({error:'Invalid settlement method'});
   await client.query('BEGIN');
   const out=await finance.recordSettlement(client,{driverId:drv.id,direction,amount:req.body?.amount,method,
    externalRef:String(req.body?.external_ref||'').slice(0,80)||null,notes:String(req.body?.notes||'').slice(0,300),
    actorId:req.user.id,idem:String(req.body?.idempotency_key||'').slice(0,80)||null});
   await client.query('COMMIT');
   await audit(req.user.id,'settlement.recorded','driver_settlements',out.settlement.id,`driver=${drv.id} ${direction} KES ${out.settlement.amount} via ${method}`);
   res.status(201).json(out);
  }catch(e){
   await client.query('ROLLBACK').catch(()=>{});
   if(e.code===400)return res.status(400).json({error:e.message});
   console.error(e);res.status(500).json({error:'Server error'});
  }finally{client.release()}
 });
 // Dispute / reverse (completed settlements stay immutable; reversal restores balances via new entries)
 app.post('/api/owner/settlements/:id/status',auth,owner,writeLimiter,async(req,res)=>{
  const client=await pool.connect();
  try{
   const to=String(req.body?.status||''),reason=String(req.body?.reason||'').trim();
   if(!['disputed','reversed','completed'].includes(to))return res.status(400).json({error:'Invalid status'});
   if(to!=='completed'&&reason.length<5)return res.status(400).json({error:'A reason is required'});
   await client.query('BEGIN');
   const s=(await client.query(`SELECT * FROM driver_settlements WHERE id::text=$1 FOR UPDATE`,[String(req.params.id)])).rows[0];
   if(!s){await client.query('ROLLBACK');return res.status(404).json({error:'Settlement not found'})}
   if(s.status==='reversed'){await client.query('ROLLBACK');return res.status(409).json({error:'Settlement already reversed'})}
   if(to==='reversed'){
    const items=(await client.query(`SELECT * FROM driver_settlement_items WHERE settlement_id=$1`,[s.id])).rows;
    for(const it of items){
     const table=it.item_type==='receivable'?'driver_receivables':'driver_payables';
     await client.query(`UPDATE ${table} SET outstanding=outstanding+$2,status=CASE WHEN outstanding+$2>=amount THEN 'open' ELSE 'partially_settled' END WHERE id=$1`,[it.item_id,it.amount]);
    }
    // Reserve-offset settlements moved money OUT of the driver's reserve;
    // a reversal must put it back, or balances stop reconciling.
    if(s.method==='reserve_offset'){
     const rv=await finance.lockReserve(client,s.driver_user_id);
     const afterC=finance.cents(rv.balance)+finance.cents(s.amount);
     await client.query(`UPDATE driver_commission_reserves SET balance=$2,updated_at=NOW() WHERE driver_user_id=$1`,[s.driver_user_id,finance.kes(afterC)]);
     await finance.reserveEntry(client,s.driver_user_id,'adjustment',finance.cents(s.amount),afterC,{idem:'settle-reverse:'+s.id,meta:{reason:'settlement reversal refund',settlement:s.reference}});
     await finance.postTxn(client,{type:'settlement_reversal',driverId:s.driver_user_id,debit:'hapa_commission',credit:'driver_commission_reserve',amount:s.amount,idem:'settle-reverse-txn:'+s.id});
    }
    const adjRef=await finance.nextRef(client,'adjustment');
    await client.query(`INSERT INTO accounting_adjustments(reference,kind,driver_user_id,related_reference,amount,reason,actor_user_id)
     VALUES($1,'adjustment',$2,$3,$4,$5,$6)`,[adjRef,s.driver_user_id,s.reference,s.amount,('Settlement reversal: '+reason).slice(0,300),req.user.id]);
   }
   const upd=(await client.query(`UPDATE driver_settlements SET status=$2 WHERE id=$1 RETURNING *`,[s.id,to])).rows[0];
   await client.query('COMMIT');
   await audit(req.user.id,'settlement.'+to,'driver_settlements',s.id,reason.slice(0,300));
   res.json({settlement:upd});
  }catch(e){await client.query('ROLLBACK').catch(()=>{});console.error(e);res.status(500).json({error:'Server error'})}
  finally{client.release()}
 });

 // ── Monthly statements ───────────────────────────────────────────────────────
 const validPeriod=(y,m)=>Number.isInteger(y)&&y>=2024&&y<=2100&&Number.isInteger(m)&&m>=1&&m<=12;
 app.post('/api/owner/statements/generate',auth,owner,writeLimiter,async(req,res)=>{
  const client=await pool.connect();
  try{
   const y=Number(req.body?.year),m=Number(req.body?.month);
   if(!validPeriod(y,m))return res.status(400).json({error:'Provide a valid year and month'});
   let driverIds;
   if(req.body?.driver_id){
    const d=(await q(`SELECT id FROM users WHERE id::text=$1`,[String(req.body.driver_id)])).rows[0];
    if(!d)return res.status(404).json({error:'Driver not found'});
    driverIds=[d.id];
   }else{
    const{start,end}=finance.monthBounds(y,m);
    driverIds=(await q(`SELECT DISTINCT driver_user_id FROM ride_requests WHERE driver_user_id IS NOT NULL AND completed_at>=$1 AND completed_at<$2`,[start,end])).rows.map(r=>r.driver_user_id);
   }
   const out=[];
   for(const id of driverIds){
    await client.query('BEGIN');
    try{const st=await finance.generateStatement(client,id,y,m);await client.query('COMMIT');out.push({id:st.id,driver_id:id,reference:st.reference,status:st.status});}
    catch(e){await client.query('ROLLBACK');throw e}
   }
   await audit(req.user.id,'statement.generated','driver_monthly_statements',null,`period=${y}-${m} drivers=${out.length}`);
   res.json({generated:out});
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
  finally{client.release()}
 });
 app.get('/api/owner/statements',auth,owner,async(req,res)=>{
  try{
   const vals=[];let w='';
   const y=Number(req.query.year),m=Number(req.query.month);
   if(Number.isInteger(y)&&y>2000){vals.push(y);w+=` AND s.period_year=$${vals.length}`}
   if(Number.isInteger(m)&&m>=1&&m<=12){vals.push(m);w+=` AND s.period_month=$${vals.length}`}
   const rows=(await q(`SELECT s.id,s.reference,s.driver_user_id,u.name AS driver_name,s.period_year,s.period_month,s.status,s.summary,s.issued_at,s.finalized_at
    FROM driver_monthly_statements s JOIN users u ON u.id=s.driver_user_id WHERE true${w} ORDER BY s.period_year DESC,s.period_month DESC,u.name LIMIT 500`,vals)).rows;
   res.json({statements:rows});
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });
 app.post('/api/owner/statements/:id/finalize',auth,owner,writeLimiter,async(req,res)=>{
  try{
   const st=(await q(`SELECT * FROM driver_monthly_statements WHERE id::text=$1`,[String(req.params.id)])).rows[0];
   if(!st)return res.status(404).json({error:'Statement not found'});
   if(st.status==='finalized')return res.status(409).json({error:'Statement is already finalized'});
   const{end}=finance.monthBounds(st.period_year,st.period_month);
   if(new Date()<end)return res.status(409).json({error:'The statement month has not ended yet'});
   const upd=(await q(`UPDATE driver_monthly_statements SET status='finalized',finalized_at=NOW(),updated_at=NOW() WHERE id=$1 AND status<>'finalized' RETURNING *`,[st.id])).rows[0];
   await audit(req.user.id,'statement.finalized','driver_monthly_statements',st.id,upd.reference);
   res.json({statement:upd});
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });
 app.post('/api/owner/statements/:id/dispute',auth,owner,writeLimiter,async(req,res)=>{
  try{
   const reason=String(req.body?.reason||'').trim();
   if(reason.length<5)return res.status(400).json({error:'A dispute reason is required'});
   const upd=(await q(`UPDATE driver_monthly_statements SET status='disputed',updated_at=NOW() WHERE id::text=$1 AND status<>'finalized' RETURNING *`,[String(req.params.id)])).rows[0];
   if(!upd)return res.status(409).json({error:'Statement not found or already finalized'});
   await audit(req.user.id,'statement.disputed','driver_monthly_statements',upd.id,reason.slice(0,300));
   res.json({statement:upd});
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });
 // Shared statement access (Owner, or the statement's own driver)
 async function loadStatementFor(req,res){
  const st=(await q(`SELECT s.*,u.name AS driver_name FROM driver_monthly_statements s JOIN users u ON u.id=s.driver_user_id WHERE s.id::text=$1`,[String(req.params.id)])).rows[0];
  if(!st){res.status(404).json({error:'Statement not found'});return null}
  if(req.user.role!=='owner'&&String(st.driver_user_id)!==String(req.user.id)){res.status(403).json({error:'Not authorized'});return null}
  return st;
 }
 // NOTE: the .pdf/.csv routes must register BEFORE the bare :id route, or
 // Express matches "/:id" first and treats "<uuid>.pdf" as an unknown id.
 app.get('/api/statements/:id.pdf',auth,active,async(req,res)=>{
  try{
   const st=await loadStatementFor(req,res);if(!st)return;
   const items=(await q(`SELECT item_type,ref_id,reference,data FROM driver_monthly_statement_items WHERE statement_id=$1 ORDER BY created_at,id`,[st.id])).rows;
   const pdf=buildStatementPdf(st,st.driver_name,items,st.meta||{});
   res.set({'Content-Type':'application/pdf','Content-Disposition':`attachment; filename="${String(st.reference).replace(/[^A-Za-z0-9-]/g,'')}.pdf"`,'Cache-Control':'private, no-store'});
   res.send(pdf);
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });
 app.get('/api/statements/:id.csv',auth,active,async(req,res)=>{
  try{
   const st=await loadStatementFor(req,res);if(!st)return;
   const items=(await q(`SELECT item_type,reference,data FROM driver_monthly_statement_items WHERE statement_id=$1 AND item_type='ride' ORDER BY created_at,id`,[st.id])).rows;
   const meta=st.meta||{},opening=st.opening||{},closing=st.closing||{};
   const head=['Statement',st.reference,'Period',`${st.period_year}-${String(st.period_month).padStart(2,'0')}`,'Timezone','Africa/Nairobi','Driver',st.driver_name||'','Status',humanize(st.status)].map(cell).join(',');
   const cols=['Date (Africa/Nairobi)','Ride reference','Receipt reference','From','To','Payment method','Payment status','Vehicle','Distance (km)','Duration (min)','Gross fare (KES)','HAPA commission (KES)','Driver fare earnings (KES)','Tip (KES)','Driver owes HAPA (KES)','HAPA owes Driver (KES)','Settlement status'];
   const lines=[head,
    ['Opening balances','Driver owes HAPA',kesF(opening.driver_owes_hapa),'HAPA owes Driver',kesF(opening.hapa_owes_driver),'Commission Reserve',kesF(opening.reserve)].map(cell).join(','),
    cols.map(cell).join(',')];
   for(const it of items){const d=it.data||{};
    const owes=d.payment_method==='cash'?(d.receivable_amount||d.commission_amount):0,owed=d.payment_method==='cash'?0:(d.payable_amount||d.net_earnings);
    const settle=humanize(d.payment_method==='cash'?(d.receivable_status||'unsettled'):(d.payable_status||'unsettled'));
    lines.push([nrbD(d.completed_at),d.ride_reference||'',d.receipt_reference||'',d.pickup_label||'',d.dest_label||'',d.payment_method,'Paid',d.vehicle_registration||'',d.distance_m?(d.distance_m/1000).toFixed(1):'',d.actual_duration_s!=null?(d.actual_duration_s/60).toFixed(1):'',kesF(d.gross_fare),kesF(d.commission_amount),kesF(d.net_earnings),d.tip_amount?kesF(d.tip_amount):'0.00',kesF(owes),kesF(owed),settle].map(cell).join(','));}
   const sum=st.summary||{};
   lines.push('');
   lines.push(['Summary','Completed rides',sum.rides,'Gross fares',kesF(sum.gross),'Cash collected by Driver',kesF(sum.cash_gross),'M-Pesa collected by HAPA',kesF(sum.mpesa_gross),'Driver fare earnings',kesF(sum.net),'HAPA commission',kesF(sum.commission)].map(cell).join(','));
   lines.push(['','Tips (M-Pesa)',kesF(sum.tips_mpesa),'Cash tips declared by Rider (not verified by HAPA)',kesF(sum.tips_cash_declared),'Settled: Driver to HAPA',kesF(sum.settled_to_hapa),'Settled: HAPA to Driver',kesF(sum.settled_to_driver)].map(cell).join(','));
   lines.push(['Closing balances','Driver owes HAPA',kesF(closing.driver_owes_hapa),'HAPA owes Driver',kesF(closing.hapa_owes_driver),'Commission Reserve',kesF(closing.reserve)].map(cell).join(','));
   lines.push(['','Driver earnings statement - not a tax invoice'].map(cell).join(','));
   if(req.user.role==='owner')await audit(req.user.id,'accounting_export','driver_monthly_statements',st.id,'csv');
   sendCsv(res,String(st.reference).replace(/[^A-Za-z0-9-]/g,'')+'.csv',lines);
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });
 app.get('/api/statements/:id',auth,active,async(req,res)=>{
  try{
   const st=await loadStatementFor(req,res);if(!st)return;
   const items=(await q(`SELECT item_type,ref_id,reference,data FROM driver_monthly_statement_items WHERE statement_id=$1 ORDER BY created_at,id`,[st.id])).rows;
   res.json({statement:st,status_label:humanize(st.status),items,disclaimer:'Driver earnings statement - not a tax invoice.'});
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });
 app.get('/api/driver/statements',auth,active,dvCap,async(req,res)=>{
  try{
   const rows=(await q(`SELECT id,reference,period_year,period_month,status,summary,issued_at,finalized_at FROM driver_monthly_statements WHERE driver_user_id=$1 ORDER BY period_year DESC,period_month DESC LIMIT 36`,[req.user.id])).rows;
   res.json({statements:rows,disclaimer:'Driver earnings statement - not a tax invoice.'});
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });

 // ── Owner: platform financial summary ───────────────────────────────────────
 async function platformSummary(qs){
  const vals=[];let range='';
  if(qs.from&&/^\d{4}-\d{2}-\d{2}$/.test(qs.from)){vals.push(qs.from);range+=` AND (COALESCE(r.completed_at,r.created_at) AT TIME ZONE 'Africa/Nairobi')::date>=$${vals.length}::date`;}
  if(qs.to&&/^\d{4}-\d{2}-\d{2}$/.test(qs.to)){vals.push(qs.to);range+=` AND (COALESCE(r.completed_at,r.created_at) AT TIME ZONE 'Africa/Nairobi')::date<=$${vals.length}::date`;}
  const rides=(await q(`SELECT count(*) FILTER(WHERE r.status IN('completed','closed'))::int AS completed_rides,
    count(*) FILTER(WHERE r.status IN('rider_cancelled','driver_cancelled'))::int AS cancellations,
    COALESCE(SUM(l.gross),0)::text AS gross,COALESCE(SUM(l.commission),0)::text AS commission,COALESCE(SUM(l.net),0)::text AS driver_earnings,
    COALESCE(SUM(l.gross) FILTER(WHERE r.payment_method='cash' AND r.status='closed'),0)::text AS cash_collected_by_drivers,
    COALESCE(SUM(l.gross) FILTER(WHERE r.payment_method='mpesa' AND r.status='closed'),0)::text AS mpesa_collected_by_hapa,
    COALESCE(SUM(l.commission) FILTER(WHERE r.payment_method='cash' AND r.status='closed'),0)::text AS commission_from_cash_rides,
    COALESCE(SUM(l.commission) FILTER(WHERE r.payment_method='mpesa' AND r.status='closed'),0)::text AS commission_from_mpesa_rides
   FROM ride_requests r LEFT JOIN driver_earnings_ledger l ON l.ride_id=r.id WHERE r.driver_user_id IS NOT NULL${range}`,vals)).rows[0];
  const bal=(await q(`SELECT
    COALESCE((SELECT SUM(outstanding) FROM driver_receivables WHERE status IN('open','partially_settled')),0)::text AS drivers_owe_hapa,
    COALESCE((SELECT SUM(outstanding) FROM driver_payables WHERE status IN('open','partially_settled')),0)::text AS hapa_owes_drivers,
    COALESCE((SELECT SUM(balance) FROM driver_commission_reserves),0)::text AS reserve_held,
    COALESCE((SELECT SUM(amount) FROM driver_settlements WHERE status='completed' AND direction='driver_to_hapa'),0)::text AS settled_in,
    COALESCE((SELECT SUM(amount) FROM driver_settlements WHERE status='completed' AND direction='hapa_to_driver'),0)::text AS settled_out,
    COALESCE((SELECT SUM(amount) FROM ride_tips WHERE status='confirmed'),0)::text AS tips_mpesa,
    COALESCE((SELECT SUM(amount) FROM ride_tips WHERE status='declared'),0)::text AS tips_cash_declared`)).rows[0];
  return{reporting_period:{from:qs.from||'all time',to:qs.to||'today'},timezone:'Africa/Nairobi',rides,balances:bal,
   note:'Tips are 100% Driver money and are never part of HAPA commission. Cash tips are declared by Riders and are not collected or verified by HAPA.'};
 }
 app.get('/api/owner/finance/summary',auth,owner,async(req,res)=>{
  try{res.json(await platformSummary(req.query))}catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });
 app.get('/api/owner/finance/summary.csv',auth,owner,async(req,res)=>{
  try{
   const s=await platformSummary(req.query);
   const lines=[['HAPA platform financial summary'].map(cell).join(','),
    ['Reporting period',`${s.reporting_period.from} to ${s.reporting_period.to}`,'Timezone','Africa/Nairobi'].map(cell).join(','),'',
    ['Metric','Value'].map(cell).join(',')];
   const rows=[['Completed rides',s.rides.completed_rides],['Cancellations',s.rides.cancellations],
    ['Gross fares (KES)',kesF(s.rides.gross)],['HAPA commission (KES)',kesF(s.rides.commission)],['Driver fare earnings (KES)',kesF(s.rides.driver_earnings)],
    ['Cash collected by Drivers (KES)',kesF(s.rides.cash_collected_by_drivers)],['M-Pesa collected by HAPA (KES)',kesF(s.rides.mpesa_collected_by_hapa)],
    ['Commission from cash rides (KES)',kesF(s.rides.commission_from_cash_rides)],['Commission from M-Pesa rides (KES)',kesF(s.rides.commission_from_mpesa_rides)],
    ['Drivers owe HAPA (KES)',kesF(s.balances.drivers_owe_hapa)],['HAPA owes Drivers (KES)',kesF(s.balances.hapa_owes_drivers)],
    ['Commission Reserve held (KES)',kesF(s.balances.reserve_held)],['Settled: Drivers to HAPA (KES)',kesF(s.balances.settled_in)],['Settled: HAPA to Drivers (KES)',kesF(s.balances.settled_out)],
    ['Tips via M-Pesa (KES)',kesF(s.balances.tips_mpesa)],['Tips in cash - declared, unverified (KES)',kesF(s.balances.tips_cash_declared)]];
   for(const r of rows)lines.push(r.map(cell).join(','));
   await audit(req.user.id,'accounting_export','finance_summary',null,`filters=${JSON.stringify(req.query).slice(0,200)}`);
   sendCsv(res,'hapa-financial-summary.csv',lines);
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });
};
