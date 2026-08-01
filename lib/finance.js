// HAPA driver finance core: references, cash/M-Pesa ride accounting, commission
// reserve, receivables/payables, tips, settlements, monthly statements, session
// hygiene. All money math is integer cents; NUMERIC strings in/out of Postgres.
'use strict';

// ── Money (integer cents; never float as source of truth) ────────────────────
const cents=v=>{const n=Math.round(Number(v)*100);if(!Number.isFinite(n))throw new Error('Bad amount');return n};
const kes=c=>(c/100).toFixed(2); // "1234.50" string for NUMERIC params & display

// ── Config gates (env override → default). Reserve is OFF for money movement
// until legal approval is explicitly granted; accounting still works via
// receivables so nothing is blocked operationally.
const envBool=(k,d)=>{const v=process.env[k];if(v===undefined||v==='')return d;return['1','true','yes','on'].includes(String(v).toLowerCase())};
const envNum=(k,d)=>{const v=Number(process.env[k]);return Number.isFinite(v)?v:d};
function flags(){
 return{
  reserveEnabled:envBool('COMMISSION_RESERVE_ENABLED',true),
  reserveLegalApproved:envBool('COMMISSION_RESERVE_LEGAL_APPROVED',false),
  cashCreditLimit:envNum('CASH_RIDE_CREDIT_LIMIT_KES',500),
  cashMinReserve:envNum('CASH_RIDE_MINIMUM_RESERVE_KES',0),
  staleCloseMinutes:envNum('SESSION_STALE_CLOSE_MINUTES',30),
  maxContinuousHours:envNum('SESSION_MAX_CONTINUOUS_HOURS',12),
  tipWindowHours:envNum('TIP_WINDOW_HOURS',72),
  tipMaxKes:envNum('TIP_MAX_KES',1000),
 };
}
const reserveUsable=f=>f.reserveEnabled&&f.reserveLegalApproved;

// ── References: HAPA-<KIND>-000123, unique per kind via sequence table ───────
const REF_PREFIX={ride:'HAPA-RIDE',quote:'HAPA-QUOTE',receipt:'HAPA-RCP',payment:'HAPA-PAY',cash:'HAPA-CASH',tip:'HAPA-TIP',commission:'HAPA-COM',topup:'HAPA-TOPUP',settlement:'HAPA-SET',payout:'HAPA-PAYOUT',statement:'HAPA-STMT-DRV',adjustment:'HAPA-ADJ',refund:'HAPA-REF',credit_note:'HAPA-CRN',debit_note:'HAPA-DBN',payable:'HAPA-DUE',txn:'HAPA-TXN'};
async function nextRef(db,kind,mid){ // mid: optional middle segment (e.g. "2026-07" for statements)
 const pfx=REF_PREFIX[kind];if(!pfx)throw new Error('Unknown ref kind '+kind);
 const r=await db.query(`INSERT INTO transaction_reference_sequences(kind,next_val) VALUES($1,2)
   ON CONFLICT(kind) DO UPDATE SET next_val=transaction_reference_sequences.next_val+1
   RETURNING next_val-1 AS val`,[kind]);
 const n=String(r.rows[0].val).padStart(6,'0');
 return mid?`${pfx}-${mid}-${n}`:`${pfx}-${n}`;
}

// ── Ledger posting (idempotent by idempotency_key) ───────────────────────────
async function postTxn(db,t){
 const ref=await nextRef(db,'txn');
 const r=await db.query(`INSERT INTO financial_transactions(reference,txn_type,ride_id,driver_user_id,currency,debit_account,credit_account,amount,status,provider_ref,idempotency_key,actor_user_id,meta,effective_at)
  VALUES($1,$2,$3,$4,'KES',$5,$6,$7,'posted',$8,$9,$10,$11,COALESCE($12,NOW()))
  ON CONFLICT(idempotency_key) DO NOTHING RETURNING *`,
  [ref,t.type,t.rideId||null,t.driverId||null,t.debit,t.credit,t.amount,t.providerRef||null,t.idem,t.actorId||null,JSON.stringify(t.meta||{}),t.effectiveAt||null]);
 return r.rows[0]||null; // null = already posted (idempotent replay)
}

// ── Commission reserve ───────────────────────────────────────────────────────
async function lockReserve(db,driverId){
 await db.query(`INSERT INTO driver_commission_reserves(driver_user_id) VALUES($1) ON CONFLICT DO NOTHING`,[driverId]);
 return (await db.query(`SELECT * FROM driver_commission_reserves WHERE driver_user_id=$1 FOR UPDATE`,[driverId])).rows[0];
}
async function reserveEntry(db,driverId,type,amountC,balanceAfterC,extra){
 const ref=extra?.reference||await nextRef(db,type==='topup'?'topup':type==='refund'?'refund':'commission');
 const r=await db.query(`INSERT INTO driver_commission_reserve_entries(driver_user_id,entry_type,status,amount,balance_after,reference,ride_id,provider_ref,idempotency_key,meta)
  VALUES($1,$2,'completed',$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(idempotency_key) DO NOTHING RETURNING *`,
  [driverId,type,kes(amountC),balanceAfterC==null?null:kes(balanceAfterC),ref,extra?.rideId||null,extra?.providerRef||null,extra?.idem||null,JSON.stringify(extra?.meta||{})]);
 return r.rows[0]||null;
}

// ── Ride accounting: called inside finalizeRide's transaction, and by the
// idempotent boot backfill. Cash: driver keeps gross → commission becomes
// "Driver owes HAPA" (less any reserve cover). M-Pesa: HAPA holds gross →
// net becomes "HAPA owes Driver". Never both directions for one ride.
async function applyRideAccounting(db,ride,led,opts){
 const f=opts?.flags||flags();
 const grossC=cents(led.gross_fare),comC=cents(led.commission_amount),netC=cents(led.net_earnings);
 if(comC+netC!==grossC)throw new Error('Ride accounting mismatch: gross != commission + net');
 const method=String(ride.payment_method||'cash'),rid=ride.id,drv=ride.driver_user_id;
 const already=await db.query(`SELECT 1 FROM financial_transactions WHERE idempotency_key=$1`,[`ride-acct:${rid}:main`]);
 if(already.rowCount)return{skipped:true};
 if(method==='cash'){
  await postTxn(db,{type:'cash_ride_collected',rideId:rid,driverId:drv,debit:'driver_cash_in_hand',credit:'ride_revenue',amount:kes(grossC),idem:`ride-acct:${rid}:main`,meta:{note:'Rider paid Driver in cash; HAPA never held these funds'},effectiveAt:ride.completed_at});
  let receivableC=comC,coveredC=0;
  if(reserveUsable(f)&&comC>0){
   const rv=await lockReserve(db,drv);const balC=cents(rv.balance);
   coveredC=Math.min(balC,comC);
   if(coveredC>0){
    const afterC=balC-coveredC;
    await db.query(`UPDATE driver_commission_reserves SET balance=$2,updated_at=NOW() WHERE driver_user_id=$1`,[drv,kes(afterC)]);
    await reserveEntry(db,drv,'commission_debit',coveredC,afterC,{rideId:rid,idem:`ride-acct:${rid}:reserve`,meta:{ride_reference:ride.ride_reference||null}});
    await postTxn(db,{type:'commission_from_reserve',rideId:rid,driverId:drv,debit:'driver_commission_reserve',credit:'hapa_commission_income',amount:kes(coveredC),idem:`ride-acct:${rid}:reserve-txn`,effectiveAt:ride.completed_at});
    receivableC=comC-coveredC;
   }
  }
  if(receivableC>0){
   const ref=await nextRef(db,'commission');
   await db.query(`INSERT INTO driver_receivables(driver_user_id,ride_id,reference,amount,outstanding,status,source,idempotency_key,meta)
    VALUES($1,$2,$3,$4,$4,'open','cash_commission',$5,$6) ON CONFLICT(idempotency_key) DO NOTHING`,
    [drv,rid,ref,kes(receivableC),`ride-acct:${rid}:receivable`,JSON.stringify({gross:kes(grossC),commission:kes(comC),reserve_covered:kes(coveredC)})]);
   await postTxn(db,{type:'commission_receivable',rideId:rid,driverId:drv,debit:'driver_receivable',credit:'hapa_commission_income',amount:kes(receivableC),idem:`ride-acct:${rid}:receivable-txn`,effectiveAt:ride.completed_at});
  }
  return{direction:'driver_owes_hapa',receivable:kes(receivableC),reserveCovered:kes(coveredC)};
 }
 // M-Pesa: HAPA received gross; retain commission; owe driver the net.
 await postTxn(db,{type:'mpesa_ride_received',rideId:rid,driverId:drv,debit:'hapa_mpesa_collection',credit:'ride_revenue',amount:kes(grossC),idem:`ride-acct:${rid}:main`,providerRef:opts?.providerRef||null,effectiveAt:ride.completed_at});
 await postTxn(db,{type:'commission_retained',rideId:rid,driverId:drv,debit:'ride_revenue_clearing',credit:'hapa_commission_income',amount:kes(comC),idem:`ride-acct:${rid}:commission`,effectiveAt:ride.completed_at});
 if(netC>0){
  const ref=await nextRef(db,'payable');
  await db.query(`INSERT INTO driver_payables(driver_user_id,ride_id,reference,amount,outstanding,status,source,idempotency_key,meta)
   VALUES($1,$2,$3,$4,$4,'open','mpesa_fare',$5,$6) ON CONFLICT(idempotency_key) DO NOTHING`,
   [drv,rid,ref,kes(netC),`ride-acct:${rid}:payable`,JSON.stringify({gross:kes(grossC),commission:kes(comC)})]);
  await postTxn(db,{type:'driver_net_payable',rideId:rid,driverId:drv,debit:'ride_revenue_clearing',credit:'driver_payable',amount:kes(netC),idem:`ride-acct:${rid}:payable-txn`,effectiveAt:ride.completed_at});
 }
 return{direction:'hapa_owes_driver',payable:kes(netC)};
}

// ── Tips: separate from fare, 100% to driver, 0% commission ──────────────────
async function confirmMpesaTip(db,tip,providerRef){ // idempotent
 const upd=await db.query(`UPDATE ride_tips SET status='confirmed',verified_by_hapa=true,provider_ref=COALESCE($2,provider_ref),updated_at=NOW() WHERE id=$1 AND status='pending' RETURNING *`,[tip.id,providerRef||null]);
 if(!upd.rowCount)return null;
 const t=upd.rows[0],amtC=cents(t.amount);
 const ref=await nextRef(db,'payable');
 await db.query(`INSERT INTO driver_payables(driver_user_id,ride_id,reference,amount,outstanding,status,source,idempotency_key,meta)
  VALUES($1,$2,$3,$4,$4,'open','mpesa_tip',$5,$6) ON CONFLICT(idempotency_key) DO NOTHING`,
  [t.driver_user_id,t.ride_id,ref,kes(amtC),`tip:${t.id}:payable`,JSON.stringify({tip_reference:t.reference})]);
 await postTxn(db,{type:'mpesa_tip_received',rideId:t.ride_id,driverId:t.driver_user_id,debit:'hapa_mpesa_collection',credit:'driver_payable',amount:kes(amtC),idem:`tip:${t.id}:txn`,providerRef:providerRef||null,meta:{tip_reference:t.reference,commission:'0.00'}});
 return t;
}

// ── Settlements: bidirectional, FIFO allocation, no over-settlement ──────────
async function recordSettlement(db,{driverId,direction,amount,method,externalRef,notes,actorId,idem}){
 const amtC=cents(amount);if(amtC<=0)throw Object.assign(new Error('Settlement amount must be positive'),{code:400});
 if(idem){const dup=await db.query(`SELECT * FROM driver_settlements WHERE idempotency_key=$1`,[idem]);if(dup.rowCount)return{settlement:dup.rows[0],replay:true};}
 const table=direction==='driver_to_hapa'?'driver_receivables':'driver_payables';
 const rows=(await db.query(`SELECT * FROM ${table} WHERE driver_user_id=$1 AND status IN('open','partially_settled') AND outstanding>0 ORDER BY created_at,id FOR UPDATE`,[driverId])).rows;
 const totalC=rows.reduce((s,r)=>s+cents(r.outstanding),0);
 if(amtC>totalC)throw Object.assign(new Error(`Amount exceeds outstanding balance (KES ${kes(totalC)})`),{code:400});
 if(method==='reserve_offset'){
  if(direction!=='driver_to_hapa')throw Object.assign(new Error('Reserve offset only settles Driver owes HAPA'),{code:400});
  const f=flags();if(!reserveUsable(f))throw Object.assign(new Error('Commission Reserve is not enabled for money movement'),{code:400});
  const rv=await lockReserve(db,driverId);const balC=cents(rv.balance);
  if(balC<amtC)throw Object.assign(new Error(`Reserve balance (KES ${kes(balC)}) is below the offset amount`),{code:400});
  const afterC=balC-amtC;
  await db.query(`UPDATE driver_commission_reserves SET balance=$2,updated_at=NOW() WHERE driver_user_id=$1`,[driverId,kes(afterC)]);
  await reserveEntry(db,driverId,'commission_debit',amtC,afterC,{idem:idem?`${idem}:reserve`:null,meta:{reason:'settlement reserve offset'}});
 }
 const ref=await nextRef(db,'settlement');
 const st=(await db.query(`INSERT INTO driver_settlements(reference,driver_user_id,direction,amount,method,external_ref,status,notes,actor_user_id,completed_at,idempotency_key)
  VALUES($1,$2,$3,$4,$5,$6,'completed',$7,$8,NOW(),$9) RETURNING *`,
  [ref,driverId,direction,kes(amtC),method,externalRef||null,String(notes||''),actorId||null,idem||null])).rows[0];
 let leftC=amtC;const items=[];
 for(const r of rows){
  if(leftC<=0)break;
  const outC=cents(r.outstanding),useC=Math.min(outC,leftC);leftC-=useC;
  const newOutC=outC-useC,newStatus=newOutC===0?'settled':'partially_settled';
  await db.query(`UPDATE ${table} SET outstanding=$2,status=$3 WHERE id=$1`,[r.id,kes(newOutC),newStatus]);
  await db.query(`INSERT INTO driver_settlement_items(settlement_id,item_type,item_id,amount) VALUES($1,$2,$3,$4)`,
   [st.id,direction==='driver_to_hapa'?'receivable':'payable',r.id,kes(useC)]);
  items.push({id:r.id,reference:r.reference,applied:kes(useC),remaining:kes(newOutC)});
 }
 const dir=direction==='driver_to_hapa'?{debit:'settlement_in',credit:'driver_receivable'}:{debit:'driver_payable',credit:'settlement_out'};
 await postTxn(db,{type:'settlement_'+direction,driverId,debit:dir.debit,credit:dir.credit,amount:kes(amtC),idem:idem?`${idem}:txn`:`settle:${st.id}`,actorId,meta:{settlement_reference:ref,method}});
 if(direction==='hapa_to_driver'){
  const pref=await nextRef(db,'payout');
  const done=method!=='mpesa'; // real M-Pesa B2C not wired yet: never fake success
  await db.query(`INSERT INTO driver_payouts(reference,driver_user_id,settlement_id,amount,method,provider_ref,status,completed_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,${done?'NOW()':'NULL'})`,
   [pref,driverId,st.id,kes(amtC),method==='mpesa'?'mpesa_b2c':method==='bank_transfer'?'bank_transfer':'manual_external',externalRef||null,done?'completed':'pending']);
 }
 return{settlement:st,items};
}

// ── Balances snapshot for one driver ─────────────────────────────────────────
async function driverBalances(db,driverId){
 const r=(await db.query(`SELECT
  COALESCE((SELECT SUM(outstanding) FROM driver_receivables WHERE driver_user_id=$1 AND status IN('open','partially_settled')),0)::text AS owes_hapa,
  COALESCE((SELECT SUM(outstanding) FROM driver_payables WHERE driver_user_id=$1 AND status IN('open','partially_settled')),0)::text AS hapa_owes,
  COALESCE((SELECT balance FROM driver_commission_reserves WHERE driver_user_id=$1),0)::text AS reserve`,[driverId])).rows[0];
 return{owesHapa:r.owes_hapa,hapaOwes:r.hapa_owes,reserve:r.reserve};
}

// ── Monthly statements (Africa/Nairobi boundaries) ───────────────────────────
const p2=n=>String(n).padStart(2,'0');
function monthBounds(y,m){return{start:new Date(`${y}-${p2(m)}-01T00:00:00+03:00`),end:new Date(`${m===12?y+1:y}-${p2(m===12?1:m+1)}-01T00:00:00+03:00`)}}
async function openingBalances(db,driverId,start){
 const r=(await db.query(`SELECT
  COALESCE((SELECT SUM(CASE WHEN entry_type IN('topup','refund') THEN amount WHEN entry_type='commission_debit' THEN -amount ELSE amount END) FROM driver_commission_reserve_entries WHERE driver_user_id=$1 AND status='completed' AND created_at<$2),0)::text AS reserve,
  (COALESCE((SELECT SUM(amount) FROM driver_receivables WHERE driver_user_id=$1 AND created_at<$2),0)
   -COALESCE((SELECT SUM(si.amount) FROM driver_settlement_items si JOIN driver_settlements s ON s.id=si.settlement_id JOIN driver_receivables dr ON dr.id=si.item_id AND si.item_type='receivable' WHERE dr.driver_user_id=$1 AND dr.created_at<$2 AND s.completed_at<$2 AND s.status='completed'),0))::text AS owes_hapa,
  (COALESCE((SELECT SUM(amount) FROM driver_payables WHERE driver_user_id=$1 AND created_at<$2),0)
   -COALESCE((SELECT SUM(si.amount) FROM driver_settlement_items si JOIN driver_settlements s ON s.id=si.settlement_id JOIN driver_payables dp ON dp.id=si.item_id AND si.item_type='payable' WHERE dp.driver_user_id=$1 AND dp.created_at<$2 AND s.completed_at<$2 AND s.status='completed'),0))::text AS hapa_owes`,
  [driverId,start])).rows[0];
 return{reserve:Number(r.reserve).toFixed(2),driver_owes_hapa:Number(r.owes_hapa).toFixed(2),hapa_owes_driver:Number(r.hapa_owes).toFixed(2)};
}
async function generateStatement(db,driverId,year,month){
 const{start,end}=monthBounds(year,month);
 let st=(await db.query(`SELECT * FROM driver_monthly_statements WHERE driver_user_id=$1 AND period_year=$2 AND period_month=$3`,[driverId,year,month])).rows[0];
 if(st&&st.status==='finalized')return st; // immutable
 if(!st){
  const ref=await nextRef(db,'statement',`${year}-${p2(month)}`);
  st=(await db.query(`INSERT INTO driver_monthly_statements(reference,driver_user_id,period_year,period_month,status)
   VALUES($1,$2,$3,$4,'open') ON CONFLICT(driver_user_id,period_year,period_month) DO UPDATE SET updated_at=NOW() RETURNING *`,
   [ref,driverId,year,month])).rows[0];
 }
 await db.query(`DELETE FROM driver_monthly_statement_items WHERE statement_id=$1`,[st.id]); // regenerate (pre-finalization only)
 const rides=(await db.query(`SELECT r.id,r.ride_reference,r.completed_at,r.payment_method,r.pickup_address AS pickup_label,r.dest_address AS dest_label,r.status,
   l.gross::text AS gross_fare,l.commission::text AS commission_amount,l.net::text AS net_earnings,rc.reference AS receipt_reference,
   (SELECT reference FROM driver_receivables WHERE ride_id=r.id LIMIT 1) AS receivable_reference,
   (SELECT outstanding::text FROM driver_receivables WHERE ride_id=r.id LIMIT 1) AS receivable_outstanding,
   (SELECT reference FROM driver_payables WHERE ride_id=r.id AND source='mpesa_fare' LIMIT 1) AS payable_reference,
   (SELECT amount::text FROM ride_tips WHERE ride_id=r.id AND status IN('confirmed','declared') LIMIT 1) AS tip_amount,
   (SELECT method FROM ride_tips WHERE ride_id=r.id AND status IN('confirmed','declared') LIMIT 1) AS tip_method
  FROM ride_requests r JOIN driver_earnings_ledger l ON l.ride_id=r.id LEFT JOIN ride_receipts rc ON rc.ride_id=r.id
  WHERE r.driver_user_id=$1 AND r.completed_at>=$2 AND r.completed_at<$3 ORDER BY r.completed_at`,[driverId,start,end])).rows;
 const resv=(await db.query(`SELECT * FROM driver_commission_reserve_entries WHERE driver_user_id=$1 AND created_at>=$2 AND created_at<$3 AND status='completed' ORDER BY created_at`,[driverId,start,end])).rows;
 const setts=(await db.query(`SELECT * FROM driver_settlements WHERE driver_user_id=$1 AND completed_at>=$2 AND completed_at<$3 AND status IN('completed','disputed','reversed') ORDER BY completed_at`,[driverId,start,end])).rows;
 for(const r of rides)await db.query(`INSERT INTO driver_monthly_statement_items(statement_id,item_type,ref_id,reference,data) VALUES($1,'ride',$2,$3,$4)`,[st.id,r.id,r.ride_reference||r.receipt_reference,JSON.stringify(r)]);
 for(const e of resv)await db.query(`INSERT INTO driver_monthly_statement_items(statement_id,item_type,ref_id,reference,data) VALUES($1,'reserve_entry',$2,$3,$4)`,[st.id,e.id,e.reference,JSON.stringify(e)]);
 for(const s of setts)await db.query(`INSERT INTO driver_monthly_statement_items(statement_id,item_type,ref_id,reference,data) VALUES($1,'settlement',$2,$3,$4)`,[st.id,s.id,s.reference,JSON.stringify(s)]);
 const sum={rides:rides.length,gross:0,commission:0,net:0,cash_gross:0,cash_net:0,cash_commission:0,mpesa_gross:0,mpesa_net:0,mpesa_commission:0,tips_mpesa:0,tips_cash_declared:0,reserve_topups:0,reserve_debits:0,settled_to_hapa:0,settled_to_driver:0};
 for(const r of rides){
  const g=cents(r.gross_fare),c=cents(r.commission_amount),n=cents(r.net_earnings);
  sum.gross+=g;sum.commission+=c;sum.net+=n;
  if(r.payment_method==='cash'){sum.cash_gross+=g;sum.cash_net+=n;sum.cash_commission+=c}else{sum.mpesa_gross+=g;sum.mpesa_net+=n;sum.mpesa_commission+=c}
  if(r.tip_amount){if(r.tip_method==='mpesa')sum.tips_mpesa+=cents(r.tip_amount);else sum.tips_cash_declared+=cents(r.tip_amount)}
 }
 for(const e of resv){if(e.entry_type==='topup'||e.entry_type==='refund')sum.reserve_topups+=cents(e.amount);else sum.reserve_debits+=cents(e.amount)}
 for(const s of setts){if(s.status!=='completed')continue;if(s.direction==='driver_to_hapa')sum.settled_to_hapa+=cents(s.amount);else sum.settled_to_driver+=cents(s.amount)}
 const summary={};for(const k of Object.keys(sum))summary[k]=k==='rides'?sum[k]:kes(sum[k]);
 const opening=await openingBalances(db,driverId,start);
 const closing=await openingBalances(db,driverId,end);
 const status=st.status==='open'&&new Date()>=end?'ready_for_review':st.status;
 st=(await db.query(`UPDATE driver_monthly_statements SET opening=$2,closing=$3,summary=$4,status=$5,updated_at=NOW() WHERE id=$1 RETURNING *`,
  [st.id,JSON.stringify(opening),JSON.stringify(closing),JSON.stringify(summary),status])).rows[0];
 return st;
}

// ── Availability session hygiene ─────────────────────────────────────────────
// Auto-close sessions with no recent activity, suspended users, or excessive
// continuous time. Valid online time ends at last activity; the idle tail is
// recorded as stale_seconds and excluded from earnings-report durations.
async function autoCloseStaleSessions(q,opts){
 const f=opts?.flags||flags();const audit=opts?.audit;
 const closed=[];
 const stale=(await q(`
  SELECT s.id,s.driver_user_id,s.started_at,
   GREATEST(s.started_at,COALESCE(s.last_seen_at,s.started_at),COALESCE(p.updated_at,s.started_at)) AS last_activity
  FROM driver_availability_sessions s
  LEFT JOIN driver_presence p ON p.driver_user_id=s.driver_user_id
  WHERE s.status IN('online','paused')
   AND GREATEST(s.started_at,COALESCE(s.last_seen_at,s.started_at),COALESCE(p.updated_at,s.started_at))<NOW()-make_interval(mins=>$1)
   AND NOT EXISTS(SELECT 1 FROM ride_requests r WHERE r.driver_user_id=s.driver_user_id AND r.status IN('accepted','arrived','started'))
  FOR UPDATE OF s SKIP LOCKED`,[f.staleCloseMinutes])).rows;
 for(const s of stale){
  await q(`UPDATE driver_availability_sessions SET status='ended',ended_at=$2,
    online_seconds=GREATEST(0,EXTRACT(EPOCH FROM $2::timestamptz-started_at))::int,
    stale_seconds=GREATEST(0,EXTRACT(EPOCH FROM NOW()-$2::timestamptz))::int,
    end_reason='auto_closed_stale',auto_closed=true WHERE id=$1 AND status IN('online','paused')`,[s.id,s.last_activity]);
  await q(`INSERT INTO driver_session_events(session_id,event,reason) VALUES($1,'auto_closed','stale: no activity for ${'>'}${f.staleCloseMinutes} min')`,[s.id]);
  await q(`UPDATE ride_offers SET status='expired',responded_at=NOW() WHERE driver_user_id=$1 AND status='pending'`,[s.driver_user_id]);
  closed.push({sessionId:s.id,driverId:s.driver_user_id,reason:'auto_closed_stale'});
  if(audit)await audit(null,'driver_session.auto_closed_stale','driver_availability_sessions',s.id,{driver_user_id:s.driver_user_id,last_activity:s.last_activity});
 }
 const inactive=(await q(`
  SELECT s.id,s.driver_user_id,u.status AS user_status FROM driver_availability_sessions s JOIN users u ON u.id=s.driver_user_id
  WHERE s.status IN('online','paused') AND u.status<>'active' FOR UPDATE OF s SKIP LOCKED`)).rows;
 for(const s of inactive){
  await q(`UPDATE driver_availability_sessions SET status='ended',ended_at=NOW(),
    online_seconds=GREATEST(0,EXTRACT(EPOCH FROM NOW()-started_at))::int,end_reason='account_inactive',auto_closed=true WHERE id=$1 AND status IN('online','paused')`,[s.id]);
  await q(`INSERT INTO driver_session_events(session_id,event,reason) VALUES($1,'auto_closed',$2)`,[s.id,'account status: '+s.user_status]);
  closed.push({sessionId:s.id,driverId:s.driver_user_id,reason:'account_inactive'});
  if(audit)await audit(null,'driver_session.auto_closed_inactive','driver_availability_sessions',s.id,{driver_user_id:s.driver_user_id,user_status:s.user_status});
 }
 const overtime=(await q(`
  SELECT s.id,s.driver_user_id,s.started_at FROM driver_availability_sessions s
  WHERE s.status IN('online','paused') AND s.started_at<NOW()-make_interval(hours=>$1)
   AND NOT EXISTS(SELECT 1 FROM ride_requests r WHERE r.driver_user_id=s.driver_user_id AND r.status IN('accepted','arrived','started'))
  FOR UPDATE OF s SKIP LOCKED`,[f.maxContinuousHours])).rows;
 for(const s of overtime){
  await q(`UPDATE driver_availability_sessions SET status='ended',ended_at=started_at+make_interval(hours=>$2),
    online_seconds=$2*3600,end_reason='working_hour_limit',auto_closed=true WHERE id=$1 AND status IN('online','paused')`,[s.id,f.maxContinuousHours]);
  await q(`INSERT INTO driver_session_events(session_id,event,reason) VALUES($1,'auto_closed','continuous availability limit reached')`,[s.id]);
  closed.push({sessionId:s.id,driverId:s.driver_user_id,reason:'working_hour_limit'});
  if(audit)await audit(null,'driver_session.working_hour_limit','driver_availability_sessions',s.id,{driver_user_id:s.driver_user_id});
 }
 return closed;
}

// ── Boot backfill: references + historical ride accounting. Idempotent; never
// modifies existing ride/payment/receipt/ledger financial values. ─────────────
async function backfillFinance(pool,log){
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const rides=(await client.query(`SELECT id FROM ride_requests WHERE ride_reference IS NULL ORDER BY created_at`)).rows;
  for(const r of rides)await client.query(`UPDATE ride_requests SET ride_reference=$2 WHERE id=$1 AND ride_reference IS NULL`,[r.id,await nextRef(client,'ride')]);
  const pays=(await client.query(`SELECT id,method,status FROM ride_payments WHERE reference IS NULL ORDER BY created_at`)).rows;
  for(const p of pays){
   await client.query(`UPDATE ride_payments SET reference=$2 WHERE id=$1 AND reference IS NULL`,[p.id,await nextRef(client,'payment')]);
   if(p.method==='cash'&&p.status==='confirmed')
    await client.query(`UPDATE ride_payments SET cash_confirmation_reference=$2 WHERE id=$1 AND cash_confirmation_reference IS NULL`,[p.id,await nextRef(client,'cash')]);
  }
  const quotes=(await client.query(`SELECT fq.id FROM fare_quotes fq WHERE fq.reference IS NULL AND EXISTS(SELECT 1 FROM ride_requests r WHERE r.quote_id=fq.id) ORDER BY fq.created_at`)).rows.slice(0,2000);
  for(const fq of quotes)await client.query(`UPDATE fare_quotes SET reference=$2 WHERE id=$1 AND reference IS NULL`,[fq.id,await nextRef(client,'quote')]);
  // Historical accounting: closed rides with earnings but no financial postings
  const hist=(await client.query(`SELECT r.*,l.gross AS gross_fare,l.commission AS commission_amount,l.net AS net_earnings
   FROM ride_requests r JOIN driver_earnings_ledger l ON l.ride_id=r.id
   WHERE r.status IN('completed','closed') AND NOT EXISTS(SELECT 1 FROM financial_transactions ft WHERE ft.idempotency_key='ride-acct:'||r.id||':main')
   ORDER BY r.completed_at`)).rows;
  for(const r of hist)await applyRideAccounting(client,r,{gross_fare:r.gross_fare,commission_amount:r.commission_amount,net_earnings:r.net_earnings},{flags:{reserveEnabled:false,reserveLegalApproved:false}});
  await client.query('COMMIT');
  if(log&&(rides.length||pays.length||hist.length))log(`finance backfill: refs rides=${rides.length} payments=${pays.length}; historical postings=${hist.length}`);
 }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e}
 finally{client.release()}
}

module.exports={cents,kes,flags,reserveUsable,nextRef,postTxn,lockReserve,reserveEntry,applyRideAccounting,confirmMpesaTip,recordSettlement,driverBalances,monthBounds,openingBalances,generateStatement,autoCloseStaleSessions,backfillFinance,REF_PREFIX};
