// Real-time ride-hailing core (Embu pilot, Kenya-wide via geo_areas).
// Server-enforced state machine, sequential timed dispatch, SSE realtime,
// immutable quotes, PIN safety, cash + M-Pesa (Daraja adapter), receipts,
// ledgers, two-way ratings, trip sharing, safety incidents, owner operations.
// All legal/operational limits live in compliance_settings (audited), never in code.
const crypto=require('crypto');
const mpesa=require('../lib/mpesa');
const {buildReceiptPdf}=require('../lib/receipt-pdf');

module.exports=function(app,deps){
 const{q,pool,auth,active,owner,audit,writeLimiter}=deps;
 const SALT=String(process.env.SESSION_SECRET||process.env.JWT_SECRET||'hapa');

 // ── Compliance / operational configuration (seeded once, Owner-editable) ────
 const CFG_DEFAULTS={
  ride_hailing_enabled:{value:true,note:'Master switch for passenger ride-hailing (staging pilot). Production activation additionally requires the ride gates.'},
  boda_passenger_enabled:{value:false,note:'Passenger boda/motorcycle rides stay disabled for the pilot (BODA_PASSENGER_ENABLED).'},
  vehicle_categories:{value:['Passenger Car'],note:'Ride categories enabled for the pilot.'},
  commission_max_pct:{value:18,note:'Legal maximum platform commission per trip — NTSA (Transport Network Companies) Regulations, Legal Notice 120 of 2022. Verify against current law before changing.'},
  offer_timeout_s:{value:20,note:'Driver offer countdown before the offer expires and dispatch moves on.'},
  quote_ttl_s:{value:600,note:'Fare quote validity window.'},
  presence_stale_s:{value:90,note:'Driver presence older than this is treated as stale (no offers).'},
  search_max_offers:{value:8,note:'Maximum sequential offers per search before ending with no_driver_available.'},
  pin_max_attempts:{value:5,note:'Maximum ride PIN attempts before the ride is flagged.'},
  waiting_free_min:{value:5,note:'Free waiting minutes at pickup before waiting charges apply.'},
  max_continuous_minutes:{value:480,note:'Maximum continuous online driving time before a mandatory break. Set from current Kenyan transport requirements (verify with NTSA / Traffic Act); configurable, not hardcoded.'},
  required_break_minutes:{value:30,note:'Required rest break after reaching the continuous-service limit.'},
  hours_warn_minutes:{value:420,note:'Warn the driver when continuous online time passes this threshold.'},
  location_interval_active_s:{value:5,note:'Driver location interval during an assigned/active ride.'},
  location_interval_idle_s:{value:30,note:'Driver location interval while online and waiting.'},
  location_retention_days:{value:30,note:'Precise ride location samples older than this are deleted.'},
  share_ttl_after_complete_min:{value:30,note:'Trip-share links expire this long after ride completion.'},
  docs_required:{value:['driving_licence','insurance','ntsa_inspection','psv_badge'],note:'Mandatory driver documents per pilot category. Configurable per service type/zone as requirements evolve.'},
  agreements:{value:{rider_terms:'1.0',driver_agreement:'1.0',pricing_disclosure:'1.0',location_disclosure:'1.0'},note:'Current agreement versions requiring acceptance.'},
  dynamic_pricing_enabled:{value:false,note:'Demand pricing is OFF by default, feature-flagged, capped, and cannot be enabled silently (audited change).'},
  dynamic_pricing_cap_pct:{value:50,note:'Absolute cap on any demand-pricing uplift if ever enabled.'},
 };
 let cfgCache={t:0,map:{}};
 async function seedCompliance(){
  for(const[k,v]of Object.entries(CFG_DEFAULTS))
   await q(`INSERT INTO compliance_settings(key,value,note) VALUES($1,$2,$3) ON CONFLICT(key) DO NOTHING`,[k,JSON.stringify(v.value),v.note]);
 }
 deps.seedCompliance=seedCompliance;
 async function cfg(key){
  if(Date.now()-cfgCache.t>5000){
   cfgCache={t:Date.now(),map:Object.fromEntries((await q(`SELECT key,value FROM compliance_settings`)).rows.map(r=>[r.key,r.value]))};
  }
  return key in cfgCache.map?cfgCache.map[key]:(CFG_DEFAULTS[key]||{}).value;
 }
 async function rideHailingEnabled(){
  if(String(process.env.RIDE_HAILING_ENABLED||'').toLowerCase()==='false')return false;
  return(await cfg('ride_hailing_enabled'))===true;
 }

 // ── Realtime: authenticated SSE with per-user channels ─────────────────────
 const subs=new Map();// userId -> Set(res)
 const ownerSubs=new Set();
 function push(userId,ev){const s=subs.get(String(userId));if(s)for(const r of s){try{r.write(`data: ${JSON.stringify(ev)}\n\n`)}catch(e){}}}
 function pushOwner(ev){for(const r of ownerSubs){try{r.write(`data: ${JSON.stringify(ev)}\n\n`)}catch(e){}}}
 app.get('/api/rides/stream',(req,res,next)=>{if(req.query.token&&!req.headers.authorization)req.headers.authorization='Bearer '+String(req.query.token);next();},auth,active,(req,res)=>{
  res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache',Connection:'keep-alive','X-Accel-Buffering':'no'});
  res.write(`data: ${JSON.stringify({type:'connected',ts:Date.now()})}\n\n`);
  const uid=String(req.user.id);
  if(!subs.has(uid))subs.set(uid,new Set());
  subs.get(uid).add(res);
  const isOwner=req.user.role==='owner';
  if(isOwner)ownerSubs.add(res);
  const hb=setInterval(()=>{try{res.write(': hb\n\n')}catch(e){}},25000);
  req.on('close',()=>{clearInterval(hb);subs.get(uid)?.delete(res);if(isOwner)ownerSubs.delete(res);});
 });

 // ── Shared helpers ──────────────────────────────────────────────────────────
 const KENYA={latMin:-5.2,latMax:5.6,lngMin:33.4,lngMax:42.6};
 const inKenya=(lat,lng)=>Number.isFinite(lat)&&Number.isFinite(lng)&&lat>=KENYA.latMin&&lat<=KENYA.latMax&&lng>=KENYA.lngMin&&lng<=KENYA.lngMax;
 const havM=(a,b,c,d)=>{const R=6371000,r=x=>x*Math.PI/180,dl=r(c-a),dg=r(d-b);const h=Math.sin(dl/2)**2+Math.cos(r(a))*Math.cos(r(c))*Math.sin(dg/2)**2;return Math.round(2*R*Math.asin(Math.sqrt(h)));};
 const pinHash=p=>crypto.createHash('sha256').update(p+SALT).digest('hex');
 const money=v=>Math.round(Number(v)*100)/100;
 const ACTIVE_RIDE=['driver_assigned','driver_en_route','driver_arrived','pin_verified','in_progress'];
 const RIDER_OPEN=['searching','offered',...ACTIVE_RIDE,'payment_pending'];

 async function addEvent(rideId,actorId,type,payload){
  await q(`INSERT INTO ride_events(ride_id,actor_id,event_type,payload) VALUES($1,$2,$3,$4)`,[rideId,actorId,type,JSON.stringify(payload||{})]);
 }
 async function zoneChainActive(zoneId){
  const r=(await q(`WITH RECURSIVE chain AS(SELECT id,parent_id,active FROM geo_areas WHERE id=$1
    UNION ALL SELECT g.id,g.parent_id,g.active FROM geo_areas g JOIN chain c ON g.id=c.parent_id)
    SELECT bool_and(active) AS ok FROM chain`,[zoneId])).rows[0];
  return r&&r.ok===true;
 }
 async function acceptedAgreement(userId,agreement){
  const versions=await cfg('agreements');
  const v=versions&&versions[agreement];if(!v)return true;
  return!!(await q(`SELECT 1 FROM user_agreement_acceptances WHERE user_id=$1 AND agreement=$2 AND version=$3`,[userId,agreement,v])).rowCount;
 }
 // Notify both ride parties + owner ops feed; append recoverable event.
 async function rideEvent(ride,actorId,type,payload,opts){
  await addEvent(ride.id,actorId,type,payload);
  const ev={type,ride_id:ride.id,status:ride.status,...payload,ts:Date.now()};
  push(ride.rider_id,ev);
  if(ride.driver_user_id&&!(opts&&opts.skipDriver))push(ride.driver_user_id,ev);
  pushOwner({...ev,ops:true});
 }

 // ── Agreements ──────────────────────────────────────────────────────────────
 app.get('/api/agreements',auth,active,async(req,res)=>{
  const versions=await cfg('agreements');
  const mine=(await q(`SELECT agreement,version FROM user_agreement_acceptances WHERE user_id=$1`,[req.user.id])).rows;
  res.json({versions,accepted:mine});
 });
 app.post('/api/agreements/accept',auth,active,async(req,res)=>{
  try{
   const versions=await cfg('agreements');
   const a=String(req.body?.agreement||'');
   if(!versions[a])return res.status(400).json({error:'Unknown agreement'});
   await q(`INSERT INTO user_agreement_acceptances(user_id,agreement,version) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[req.user.id,a,versions[a]]);
   res.json({ok:true,agreement:a,version:versions[a]});
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });

 // ── Ride config (authenticated; no secrets — browser Maps key is public-by-design) ─
 app.get('/api/rides/config',auth,active,async(req,res)=>{
  const cats=[...(await cfg('vehicle_categories'))];
  if((await cfg('boda_passenger_enabled'))===true)cats.push('Boda Boda');
  res.json({
   enabled:await rideHailingEnabled(),
   categories:cats,
   maps_browser_key:process.env.GOOGLE_MAPS_BROWSER_KEY||null,
   mock_routing:!process.env.GOOGLE_MAPS_SERVER_KEY,
   mpesa:{mode:mpesa.status().mode,ready:mpesa.status().ready},
   offer_timeout_s:await cfg('offer_timeout_s'),
   location_intervals:{active_s:await cfg('location_interval_active_s'),idle_s:await cfg('location_interval_idle_s')},
   agreements:await cfg('agreements'),
  });
 });

 // ── Driver: vehicles ────────────────────────────────────────────────────────
 const dvCap=async(req,res,next)=>{ // driver capability check
  const u=(await q(`SELECT capabilities FROM users WHERE id=$1`,[req.user.id])).rows[0];
  if(!u||u.capabilities?.driver!==true)return res.status(403).json({error:'Driver capability required'});
  next();
 };
 app.get('/api/me/vehicles',auth,active,dvCap,async(req,res)=>{
  res.json((await q(`SELECT * FROM driver_vehicles WHERE driver_user_id=$1 AND status<>'retired' ORDER BY created_at`,[req.user.id])).rows);
 });
 app.post('/api/me/vehicles',auth,active,dvCap,writeLimiter,async(req,res)=>{
  try{
   const b=req.body||{};
   const cats=[...(await cfg('vehicle_categories'))];if((await cfg('boda_passenger_enabled'))===true)cats.push('Boda Boda');
   const category=String(b.category||'').trim();
   if(!cats.some(c=>c.toLowerCase()===category.toLowerCase()))return res.status(400).json({error:'Vehicle category not enabled for the pilot'});
   const reg=String(b.registration_number||'').trim().toUpperCase().slice(0,15);
   if(!reg)return res.status(400).json({error:'Registration number is required'});
   const r=await q(`INSERT INTO driver_vehicles(driver_user_id,category,make,model,colour,registration_number,year) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [req.user.id,category,String(b.make||'').slice(0,60),String(b.model||'').slice(0,60),String(b.colour||'').slice(0,30),reg,Number(b.year)||null]);
   res.status(201).json(r.rows[0]);
  }catch(e){
   if(e.code==='23505')return res.status(409).json({error:'This registration number is already registered'});
   console.error(e);res.status(500).json({error:'Server error'});
  }
 });
 app.patch('/api/owner/vehicles/:id',auth,owner,async(req,res)=>{
  try{
   const st=String(req.body?.status||'');
   if(!['approved','rejected','retired'].includes(st))return res.status(400).json({error:'Invalid status'});
   const r=await q(`UPDATE driver_vehicles SET status=$2,moderation_note=$3,updated_at=NOW() WHERE id::text=$1 RETURNING *`,[req.params.id,st,String(req.body?.note||'').slice(0,300)]);
   if(!r.rowCount)return res.status(404).json({error:'Vehicle not found'});
   await audit(req.user.id,'vehicle_'+st,'driver_vehicle',req.params.id,'');
   res.json(r.rows[0]);
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });

 // ── Driver: documents (expiry-aware; expired mandatory doc blocks online) ──
 app.get('/api/me/driver-documents',auth,active,dvCap,async(req,res)=>{
  const rows=(await q(`SELECT id,doc_type,status,reference,expires_on,reviewed_at FROM driver_document_status WHERE driver_user_id=$1 ORDER BY doc_type`,[req.user.id])).rows;
  const required=await cfg('docs_required');
  res.json({required,documents:rows,warnings:rows.filter(d=>d.expires_on&&new Date(d.expires_on)<new Date(Date.now()+30*86400000)).map(d=>d.doc_type)});
 });
 app.post('/api/me/driver-documents',auth,active,dvCap,writeLimiter,async(req,res)=>{
  try{
   const b=req.body||{};
   const t=String(b.doc_type||'').trim().slice(0,50);
   if(!t)return res.status(400).json({error:'doc_type is required'});
   const exp=b.expires_on?String(b.expires_on).slice(0,10):null;
   if(exp&&!/^\d{4}-\d{2}-\d{2}$/.test(exp))return res.status(400).json({error:'Invalid expiry date'});
   const r=await q(`INSERT INTO driver_document_status(driver_user_id,doc_type,reference,expires_on) VALUES($1,$2,$3,$4)
    ON CONFLICT(driver_user_id,doc_type) DO UPDATE SET reference=$3,expires_on=$4,status='pending',updated_at=NOW() RETURNING *`,
    [req.user.id,t,String(b.reference||'').slice(0,80),exp]);
   res.status(201).json(r.rows[0]);
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });
 app.patch('/api/owner/driver-documents/:id',auth,owner,async(req,res)=>{
  try{
   const st=String(req.body?.status||'');
   if(!['approved','rejected'].includes(st))return res.status(400).json({error:'Invalid status'});
   const r=await q(`UPDATE driver_document_status SET status=$2,reviewed_by=$3,reviewed_at=NOW(),updated_at=NOW() WHERE id::text=$1 RETURNING *`,[req.params.id,st,req.user.id]);
   if(!r.rowCount)return res.status(404).json({error:'Document not found'});
   await audit(req.user.id,'driver_doc_'+st,'driver_document',req.params.id,'');
   res.json(r.rows[0]);
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });

 // ── Driver: operating zones ─────────────────────────────────────────────────
 app.post('/api/me/operating-zones',auth,active,dvCap,async(req,res)=>{
  try{
   const zone=(await q(`SELECT id,name,level,active FROM geo_areas WHERE id::text=$1 OR slug=$1`,[String(req.body?.zone||'')])).rows[0];
   if(!zone||!['zone','town','county'].includes(zone.level))return res.status(400).json({error:'Service area not found'});
   if(!(await zoneChainActive(zone.id)))return res.status(403).json({error:'This service area is not active on HAPA yet'});
   const r=await q(`INSERT INTO driver_operating_zones(driver_user_id,zone_id) VALUES($1,$2)
    ON CONFLICT(driver_user_id,zone_id) DO UPDATE SET status='approved' RETURNING *`,[req.user.id,zone.id]);
   res.status(201).json(r.rows[0]);
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });

 // ── Driver eligibility (single source of truth) ────────────────────────────
 async function driverEligibility(userId,zoneId,vehicleId){
  const reasons=[];
  const u=(await q(`SELECT status,capabilities FROM users WHERE id=$1`,[userId])).rows[0];
  if(!u||u.status!=='active')reasons.push('Account is not active');
  if(u&&u.capabilities?.driver!==true)reasons.push('Driver capability not approved');
  const prof=(await q(`SELECT status FROM driver_profiles WHERE user_id=$1`,[userId])).rows[0];
  if(!prof||prof.status==='owner_hidden')reasons.push('Driver profile is not eligible');
  const veh=vehicleId?(await q(`SELECT * FROM driver_vehicles WHERE id::text=$1 AND driver_user_id=$2`,[String(vehicleId),userId])).rows[0]:null;
  if(!veh||veh.status!=='approved')reasons.push('An approved vehicle is required');
  if(veh&&veh.category.toLowerCase().includes('boda')&&(await cfg('boda_passenger_enabled'))!==true)reasons.push('Passenger boda rides are not enabled');
  const required=await cfg('docs_required');
  const okDocs=+(await q(`SELECT count(*)::int n FROM driver_document_status WHERE driver_user_id=$1 AND doc_type=ANY($2) AND status='approved' AND (expires_on IS NULL OR expires_on>=CURRENT_DATE)`,[userId,required])).rows[0].n;
  if(okDocs<required.length)reasons.push('Mandatory documents missing or expired');
  const zone=(await q(`SELECT id,active FROM geo_areas WHERE id=$1`,[zoneId])).rows[0];
  if(!zone||!(await zoneChainActive(zone.id)))reasons.push('Selected service area is not active');
  const zoneOk=!!(await q(`SELECT 1 FROM driver_operating_zones WHERE driver_user_id=$1 AND zone_id=$2 AND status='approved'`,[userId,zoneId])).rowCount;
  if(!zoneOk)reasons.push('Not approved for this service area');
  const activeRide=!!(await q(`SELECT 1 FROM ride_requests WHERE driver_user_id=$1 AND status=ANY($2)`,[userId,ACTIVE_RIDE])).rowCount;
  if(activeRide)reasons.push('An active ride is in progress');
  // Working hours: continuous service since last qualifying break
  const maxMin=Number(await cfg('max_continuous_minutes')),brkMin=Number(await cfg('required_break_minutes'));
  const last=(await q(`SELECT ended_at,started_at FROM driver_availability_sessions WHERE driver_user_id=$1 AND status='ended' ORDER BY ended_at DESC LIMIT 1`,[userId])).rows[0];
  if(last&&last.ended_at&&(Date.now()-new Date(last.ended_at).getTime())<brkMin*60000){
   const contMin=(new Date(last.ended_at)-new Date(last.started_at))/60000;
   if(contMin>=maxMin)reasons.push(`Required ${brkMin}-minute break after ${Math.round(maxMin/60)}h continuous service`);
  }
  if(!(await acceptedAgreement(userId,'driver_agreement')))reasons.push('Driver agreement acceptance required');
  return{ok:reasons.length===0,reasons,vehicle:veh};
 }

 // ── Driver: go online / pause / offline ────────────────────────────────────
 app.post('/api/driver/online',auth,active,dvCap,writeLimiter,async(req,res)=>{
  try{
   if(!(await rideHailingEnabled()))return res.status(503).json({error:'Ride-hailing is not enabled'});
   const zone=(await q(`SELECT id FROM geo_areas WHERE id::text=$1 OR slug=$1`,[String(req.body?.zone||'')])).rows[0];
   if(!zone)return res.status(400).json({error:'Service area not found'});
   const el=await driverEligibility(req.user.id,zone.id,String(req.body?.vehicle_id||''));
   if(!el.ok)return res.status(403).json({error:'You cannot go online yet',reasons:el.reasons});
   const r=await q(`INSERT INTO driver_availability_sessions(driver_user_id,zone_id,vehicle_id) VALUES($1,$2,$3) RETURNING *`,[req.user.id,zone.id,req.body.vehicle_id]);
   await q(`INSERT INTO driver_presence(driver_user_id,session_id) VALUES($1,$2)
    ON CONFLICT(driver_user_id) DO UPDATE SET session_id=$2,seq=0,updated_at=NOW()`,[req.user.id,r.rows[0].id]);
   pushOwner({type:'driver_online',driver_id:req.user.id,ts:Date.now()});
   const warnAt=Number(await cfg('hours_warn_minutes'));
   res.status(201).json({session:r.rows[0],hours_warning_after_min:warnAt});
  }catch(e){
   if(e.code==='23505')return res.status(409).json({error:'Already online'});
   console.error(e);res.status(500).json({error:'Server error'});
  }
 });
 async function endOrPause(req,res,newStatus){
  try{
   const s=(await q(`SELECT * FROM driver_availability_sessions WHERE driver_user_id=$1 AND status IN('online','paused')`,[req.user.id])).rows[0];
   if(!s)return res.status(404).json({error:'Not online'});
   if(newStatus==='ended'){
    await q(`UPDATE driver_availability_sessions SET status='ended',ended_at=NOW(),online_seconds=EXTRACT(EPOCH FROM NOW()-started_at)::int WHERE id=$1`,[s.id]);
    await q(`UPDATE driver_presence SET session_id=NULL,updated_at=NOW() WHERE driver_user_id=$1`,[req.user.id]);
    await q(`UPDATE ride_offers SET status='withdrawn',responded_at=NOW() WHERE driver_user_id=$1 AND status='pending'`,[req.user.id]);
    pushOwner({type:'driver_offline',driver_id:req.user.id,ts:Date.now()});
   }else{
    await q(`UPDATE driver_availability_sessions SET status=$2 WHERE id=$1`,[s.id,newStatus]);
   }
   res.json({ok:true,status:newStatus});
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 }
 app.post('/api/driver/offline',auth,active,dvCap,(req,res)=>endOrPause(req,res,'ended'));
 app.post('/api/driver/pause',auth,active,dvCap,(req,res)=>endOrPause(req,res,'paused'));
 app.post('/api/driver/resume',auth,active,dvCap,(req,res)=>endOrPause(req,res,'online'));

 // ── Driver hub (operating screen data) ──────────────────────────────────────
 app.get('/api/driver/hub',auth,active,dvCap,async(req,res)=>{
  try{
   const session=(await q(`SELECT s.*,g.name AS zone_name,v.category,v.make,v.model,v.registration_number FROM driver_availability_sessions s JOIN geo_areas g ON g.id=s.zone_id JOIN driver_vehicles v ON v.id=s.vehicle_id WHERE s.driver_user_id=$1 AND s.status IN('online','paused')`,[req.user.id])).rows[0]||null;
   const offer=(await q(`SELECT o.*,r.pickup_address,r.vehicle_category,r.zone_id,fq.total AS quote_total,fq.distance_m,fq.duration_s FROM ride_offers o JOIN ride_requests r ON r.id=o.ride_id JOIN fare_quotes fq ON fq.id=r.quote_id WHERE o.driver_user_id=$1 AND o.status='pending' AND o.expires_at>NOW()`,[req.user.id])).rows[0]||null;
   const ride=(await q(`SELECT * FROM ride_requests WHERE driver_user_id=$1 AND status=ANY($2)`,[req.user.id,[...ACTIVE_RIDE,'payment_pending']])).rows[0]||null;
   const earnings=(await q(`SELECT COALESCE(SUM(net),0) AS total,COALESCE(SUM(net) FILTER(WHERE created_at::date=CURRENT_DATE),0) AS today,count(*)::int AS trips FROM driver_earnings_ledger WHERE driver_user_id=$1`,[req.user.id])).rows[0];
   const docs=(await q(`SELECT doc_type,status,expires_on FROM driver_document_status WHERE driver_user_id=$1 ORDER BY doc_type`,[req.user.id])).rows;
   const history=(await q(`SELECT r.id,r.status,r.pickup_address,r.dest_address,r.final_fare,r.payment_method,r.completed_at,r.created_at,
     l.gross,l.commission,l.net,l.payout_status,rc.reference AS receipt_reference,
     u.name AS rider_name,v.make||' '||v.model||' · '||v.registration_number AS vehicle_label
    FROM ride_requests r
    LEFT JOIN driver_earnings_ledger l ON l.ride_id=r.id
    LEFT JOIN ride_receipts rc ON rc.ride_id=r.id
    LEFT JOIN users u ON u.id=r.rider_id
    LEFT JOIN driver_vehicles v ON v.id=r.vehicle_id
    WHERE r.driver_user_id=$1 AND r.status IN('completed','closed','rider_cancelled','driver_cancelled')
    ORDER BY COALESCE(r.completed_at,r.created_at) DESC LIMIT 20`,[req.user.id])).rows;
   for(const hr of history)hr.payment_status=paymentStatusOf(hr.status);
   const onlineMin=session?Math.round((Date.now()-new Date(session.started_at))/60000):0;
   res.json({session,offer,ride:ride?await rideView(ride,'driver'):null,earnings,documents:docs,history,
    hours:{online_min:onlineMin,warn_after_min:Number(await cfg('hours_warn_minutes')),max_continuous_min:Number(await cfg('max_continuous_minutes'))},
    required_docs:await cfg('docs_required')});
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });

 // ── Driver location (only while online / on active ride; validated) ────────
 app.post('/api/driver/location',auth,active,dvCap,async(req,res)=>{
  try{
   const b=req.body||{};
   const lat=Number(b.lat),lng=Number(b.lng),seq=Number(b.seq);
   if(!inKenya(lat,lng))return res.status(400).json({error:'Invalid coordinates'});
   if(!Number.isFinite(seq)||seq<0)return res.status(400).json({error:'Invalid sequence'});
   const s=(await q(`SELECT id FROM driver_availability_sessions WHERE driver_user_id=$1 AND status='online'`,[req.user.id])).rows[0];
   const ride=(await q(`SELECT * FROM ride_requests WHERE driver_user_id=$1 AND status=ANY($2)`,[req.user.id,ACTIVE_RIDE])).rows[0];
   if(!s&&!ride)return res.status(409).json({error:'Location updates are only accepted while online or on an active ride'});
   const up=await q(`UPDATE driver_presence SET lat=$2,lng=$3,accuracy_m=$4,heading=$5,speed_mps=$6,seq=$7,updated_at=NOW(),session_id=COALESCE($8,session_id)
    WHERE driver_user_id=$1 AND seq<$7 RETURNING driver_user_id`,[req.user.id,lat,lng,Number(b.accuracy)||null,Number(b.heading)||null,Number(b.speed)||null,seq,s?s.id:null]);
   if(!up.rowCount){
    const exists=await q(`INSERT INTO driver_presence(driver_user_id,session_id,lat,lng,seq) VALUES($1,$2,$3,$4,$5) ON CONFLICT(driver_user_id) DO NOTHING RETURNING driver_user_id`,[req.user.id,s?s.id:null,lat,lng,seq]);
    if(!exists.rowCount)return res.status(409).json({error:'Stale or out-of-order location update'});
   }
   if(ride){
    await q(`INSERT INTO ride_location_samples(ride_id,session_id,driver_user_id,lat,lng,accuracy_m,heading,speed_mps,seq) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
     [ride.id,s?s.id:null,req.user.id,lat,lng,Number(b.accuracy)||null,Number(b.heading)||null,Number(b.speed)||null,seq]);
    push(ride.rider_id,{type:'driver_location',ride_id:ride.id,lat,lng,heading:Number(b.heading)||null,ts:Date.now()});
   }
   res.json({ok:true});
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });

 // ── Fare quotes (immutable snapshots; reuse fare_rate_cards + ancestry) ────
 // Vehicle categories are normalized so owner-entered labels like "car",
 // "Saloon" or "bodaboda" resolve against configured pilot categories.
 function normCat(c){
  const k=String(c||'').toLowerCase().replace(/[^a-z]/g,'');
  if(['car','passengercar','saloon','sedan','taxi','cab'].includes(k))return'passenger car';
  if(['boda','bodaboda','motorbike','motorcycle','bike'].includes(k))return'boda boda';
  return String(c||'').toLowerCase().trim();
 }
 async function findCard(zoneId,category){
  // Effective dates are calendar dates in Africa/Nairobi, never UTC-shifted.
  const rows=(await q(`WITH RECURSIVE chain AS(
    SELECT id,parent_id,0 AS depth FROM geo_areas WHERE id=$1
    UNION ALL SELECT g.id,g.parent_id,c.depth+1 FROM geo_areas g JOIN chain c ON g.id=c.parent_id
   )SELECT f.*,c.depth FROM fare_rate_cards f JOIN chain c ON c.id=f.area_id
    WHERE f.active AND f.effective_from<=(NOW() AT TIME ZONE 'Africa/Nairobi')::date
    ORDER BY c.depth,f.effective_from DESC`,[zoneId])).rows;
  const want=normCat(category);
  return rows.find(f=>normCat(f.vehicle_category)===want);
 }
 async function routeEstimate(pLat,pLng,dLat,dLng,given){
  if(process.env.GOOGLE_MAPS_SERVER_KEY){
   try{
    const r=await fetch(`https://maps.googleapis.com/maps/api/directions/json?origin=${pLat},${pLng}&destination=${dLat},${dLng}&key=${process.env.GOOGLE_MAPS_SERVER_KEY}`);
    const d=await r.json();
    const leg=d.routes?.[0]?.legs?.[0];
    if(leg)return{distance_m:leg.distance.value,duration_s:leg.duration.value,polyline:d.routes[0].overview_polyline?.points||null,source:'google'};
   }catch(e){console.error('directions error:',e.message);}
  }
  if(given&&Number(given.distance_m)>0&&Number(given.duration_s)>0)
   return{distance_m:Math.round(Number(given.distance_m)),duration_s:Math.round(Number(given.duration_s)),polyline:null,source:'client'};
  const straight=havM(pLat,pLng,dLat,dLng);
  const distance_m=Math.round(straight*1.4);// road-factor heuristic, clearly labelled mock
  return{distance_m,duration_s:Math.round(distance_m/(30/3.6)),polyline:null,source:'mock_estimate'};
 }
 app.post('/api/rides/quote',auth,active,writeLimiter,async(req,res)=>{
  try{
   if(!(await rideHailingEnabled()))return res.status(503).json({error:'Ride-hailing is not enabled'});
   const b=req.body||{};
   const pLat=Number(b.pickup_lat),pLng=Number(b.pickup_lng),dLat=Number(b.dest_lat),dLng=Number(b.dest_lng);
   if(!inKenya(pLat,pLng)||!inKenya(dLat,dLng))return res.status(400).json({error:'Locations must be within Kenya'});
   const zone=(await q(`SELECT id,name FROM geo_areas WHERE id::text=$1 OR slug=$1`,[String(b.zone||'zone-embu-pilot')])).rows[0];
   if(!zone||!(await zoneChainActive(zone.id)))return res.status(404).json({error:'Service area not available'});
   const cats=[...(await cfg('vehicle_categories'))];if((await cfg('boda_passenger_enabled'))===true)cats.push('Boda Boda');
   const category=String(b.vehicle_category||cats[0]);
   if(!cats.some(c=>c.toLowerCase()===category.toLowerCase()))return res.status(400).json({error:'This ride category is not available'});
   const card=await findCard(zone.id,category);
   if(!card)return res.status(404).json({error:'No rate card configured for this area yet'});
   const route=await routeEstimate(pLat,pLng,dLat,dLng,b);
   const km=route.distance_m/1000,min=route.duration_s/60;
   const maxPct=Number(await cfg('commission_max_pct'));
   const commissionPct=Math.min(Number(card.commission_pct),maxPct);
   const comp={base_fare:money(card.base_fare),booking_fee:money(card.booking_fee),
    distance_charge:money(km*card.per_km),time_charge:money(min*card.per_min),
    minimum_fare:money(card.minimum_fare),currency:card.currency,
    commission_pct:commissionPct,rate_card_id:card.id,waiting_per_min:money(card.waiting_per_min),
    demand_pricing:false,route_source:route.source};
   const subtotal=comp.base_fare+comp.booking_fee+comp.distance_charge+comp.time_charge;
   const total=money(Math.max(comp.minimum_fare,subtotal));
   const ttl=Number(await cfg('quote_ttl_s'));
   // Store the validated REQUESTED category (e.g. 'Passenger Car'), not the
   // card's own label (e.g. 'car'): dispatch matches vehicles against the
   // quote's category, so an alias card name would strand rides in search.
   const catCanonical=cats.find(c=>c.toLowerCase()===category.toLowerCase())||category;
   const r=(await q(`INSERT INTO fare_quotes(rider_id,zone_id,rate_card_id,vehicle_category,currency,distance_m,duration_s,components,total,route_source,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW()+make_interval(secs=>$11)) RETURNING *`,
    [req.user.id,zone.id,card.id,catCanonical,card.currency,route.distance_m,route.duration_s,JSON.stringify(comp),total,route.source,ttl])).rows[0];
   res.status(201).json({quote:r,polyline:route.polyline,zone_name:zone.name,mock_routing:route.source!=='google',
    note:route.source==='google'?null:'Route estimated without Google Maps — development estimate only.'});
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });

 // ── Ride creation ───────────────────────────────────────────────────────────
 app.post('/api/rides',auth,active,writeLimiter,async(req,res)=>{
  try{
   if(!(await rideHailingEnabled()))return res.status(503).json({error:'Ride-hailing is not enabled'});
   const b=req.body||{};
   if(!(await acceptedAgreement(req.user.id,'rider_terms')))return res.status(403).json({error:'Please accept the Rider Terms first',code:'agreement_required'});
   const quote=(await q(`SELECT * FROM fare_quotes WHERE id::text=$1 AND rider_id=$2`,[String(b.quote_id||''),req.user.id])).rows[0];
   if(!quote)return res.status(404).json({error:'Quote not found'});
   if(new Date(quote.expires_at)<new Date())return res.status(410).json({error:'Quote expired — request a new estimate'});
   if(!(await zoneChainActive(quote.zone_id)))return res.status(403).json({error:'This service area is not currently active'});
   const method=String(b.payment_method||'cash');
   if(!['cash','mpesa'].includes(method))return res.status(400).json({error:'Invalid payment method'});
   const idem=String(b.idempotency_key||'').slice(0,80)||crypto.randomBytes(12).toString('hex');
   const pin=String(crypto.randomInt(0,10000)).padStart(4,'0');
   const pLat=Number(b.pickup_lat),pLng=Number(b.pickup_lng),dLat=Number(b.dest_lat),dLng=Number(b.dest_lng);
   if(!inKenya(pLat,pLng)||!inKenya(dLat,dLng))return res.status(400).json({error:'Locations must be within Kenya'});
   let r;
   try{
    r=(await q(`INSERT INTO ride_requests(rider_id,quote_id,zone_id,vehicle_category,status,pickup_lat,pickup_lng,dest_lat,dest_lng,pickup_address,dest_address,pickup_note,landmark,payment_method,pin_hash,idempotency_key,search_started_at)
     VALUES($1,$2,$3,$4,'searching',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW()) RETURNING *`,
     [req.user.id,quote.id,quote.zone_id,quote.vehicle_category,pLat,pLng,dLat,dLng,
      String(b.pickup_address||'').slice(0,300),String(b.dest_address||'').slice(0,300),
      String(b.pickup_note||'').slice(0,300),String(b.landmark||'').slice(0,200),method,pinHash(pin),idem])).rows[0];
   }catch(e){
    if(e.code==='23505'){
     const dup=(await q(`SELECT * FROM ride_requests WHERE rider_id=$1 AND idempotency_key=$2`,[req.user.id,idem])).rows[0];
     if(dup)return res.status(200).json({ride:await rideView(dup,'rider'),pin:null,duplicate:true});
     return res.status(409).json({error:'You already have an active ride'});
    }
    throw e;
   }
   await rideEvent(r,req.user.id,'search_started',{zone_id:r.zone_id});
   dispatchNext(r.id).catch(e=>console.error('dispatch error:',e.message));
   res.status(201).json({ride:await rideView(r,'rider'),pin});
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });

 // ── Dispatch engine: sequential timed offers, DB-level double-accept guard ──
 async function candidates(ride){
  const staleS=Number(await cfg('presence_stale_s'));
  const required=await cfg('docs_required');
  const maxMin=Number(await cfg('max_continuous_minutes'));
  return(await q(`SELECT s.driver_user_id,s.vehicle_id,p.lat,p.lng,
     COALESCE(2*6371000*asin(sqrt(pow(sin(radians(($4-p.lat)/2)),2)+cos(radians(p.lat))*cos(radians($4))*pow(sin(radians(($5-p.lng)/2)),2))),1e9)::int AS dist_m
    FROM driver_availability_sessions s
    JOIN users u ON u.id=s.driver_user_id AND u.status='active'
    JOIN driver_vehicles v ON v.id=s.vehicle_id AND v.status='approved' AND LOWER(v.category)=LOWER($2)
    LEFT JOIN driver_presence p ON p.driver_user_id=s.driver_user_id AND p.updated_at>NOW()-make_interval(secs=>$6)
    WHERE s.status='online' AND s.zone_id=$3 AND p.driver_user_id IS NOT NULL
     AND s.started_at>NOW()-make_interval(mins=>$8)
     AND s.driver_user_id<>$9
     AND EXISTS(SELECT 1 FROM driver_operating_zones z WHERE z.driver_user_id=s.driver_user_id AND z.zone_id=s.zone_id AND z.status='approved')
     AND NOT EXISTS(SELECT 1 FROM ride_offers o WHERE o.ride_id=$1 AND o.driver_user_id=s.driver_user_id)
     AND NOT EXISTS(SELECT 1 FROM ride_offers o WHERE o.driver_user_id=s.driver_user_id AND o.status='pending')
     AND NOT EXISTS(SELECT 1 FROM ride_requests rr WHERE rr.driver_user_id=s.driver_user_id AND rr.status=ANY($10))
     AND(SELECT count(*)::int FROM driver_document_status d WHERE d.driver_user_id=s.driver_user_id AND d.doc_type=ANY($7) AND d.status='approved' AND (d.expires_on IS NULL OR d.expires_on>=CURRENT_DATE))=$11
    ORDER BY dist_m ASC LIMIT 5`,
   [ride.id,ride.vehicle_category,ride.zone_id,ride.pickup_lat,ride.pickup_lng,staleS,required,maxMin,ride.rider_id,ACTIVE_RIDE,required.length])).rows;
 }
 async function dispatchNext(rideId){
  const ride=(await q(`SELECT * FROM ride_requests WHERE id=$1`,[rideId])).rows[0];
  if(!ride||!['searching','offered'].includes(ride.status))return;
  const pending=(await q(`SELECT 1 FROM ride_offers WHERE ride_id=$1 AND status='pending' AND expires_at>NOW()`,[rideId])).rowCount;
  if(pending)return;
  const nOffers=+(await q(`SELECT count(*)::int n FROM ride_offers WHERE ride_id=$1`,[rideId])).rows[0].n;
  const maxOffers=Number(await cfg('search_max_offers'));
  const cands=nOffers>=maxOffers?[]:await candidates(ride);
  if(!cands.length){
   const done=(await q(`UPDATE ride_requests SET status='no_driver_available',updated_at=NOW() WHERE id=$1 AND status IN('searching','offered') RETURNING *`,[rideId])).rows[0];
   if(done)await rideEvent(done,null,'no_driver_available',{offers_made:nOffers});
   return;
  }
  const c=cands[0];
  const ttl=Number(await cfg('offer_timeout_s'));
  try{
   const o=(await q(`INSERT INTO ride_offers(ride_id,driver_user_id,round,pickup_distance_m,expires_at) VALUES($1,$2,$3,$4,NOW()+make_interval(secs=>$5)) RETURNING *`,
    [rideId,c.driver_user_id,nOffers+1,c.dist_m<1e8?c.dist_m:null,ttl])).rows[0];
   await q(`UPDATE ride_requests SET status='offered',updated_at=NOW() WHERE id=$1 AND status='searching'`,[rideId]);
   await addEvent(rideId,null,'offer_created',{driver_id:c.driver_user_id,round:o.round,expires_at:o.expires_at});
   push(c.driver_user_id,{type:'offer',offer_id:o.id,ride_id:rideId,pickup_distance_m:o.pickup_distance_m,expires_at:o.expires_at,countdown_s:ttl,ts:Date.now()});
   push(ride.rider_id,{type:'searching_update',ride_id:rideId,round:o.round,ts:Date.now()});
   pushOwner({type:'offer_created',ride_id:rideId,ts:Date.now()});
  }catch(e){
   if(e.code!=='23505')throw e;// pending-offer race: another tick will retry
  }
 }
 // Engine tick: expire offers, advance searches, prune old location samples.
 let lastPrune=0;
 async function engineTick(){
  try{
   const expired=(await q(`UPDATE ride_offers SET status='expired',responded_at=NOW() WHERE status='pending' AND expires_at<=NOW() RETURNING id,ride_id,driver_user_id`)).rows;
   for(const o of expired){
    await addEvent(o.ride_id,null,'offer_expired',{driver_id:o.driver_user_id});
    push(o.driver_user_id,{type:'offer_expired',offer_id:o.id,ride_id:o.ride_id,ts:Date.now()});
    await dispatchNext(o.ride_id);
   }
   const stuck=(await q(`SELECT id FROM ride_requests WHERE status IN('searching','offered') AND NOT EXISTS(SELECT 1 FROM ride_offers o WHERE o.ride_id=ride_requests.id AND o.status='pending' AND o.expires_at>NOW())`)).rows;
   for(const s of stuck)await dispatchNext(s.id);
   if(Date.now()-lastPrune>3600000){
    lastPrune=Date.now();
    const days=Number(await cfg('location_retention_days'));
    await q(`DELETE FROM ride_location_samples WHERE recorded_at<NOW()-make_interval(days=>$1)`,[days]);
   }
  }catch(e){console.error('engine tick error:',e.message)}
 }
 const engine=setInterval(engineTick,1000);
 engine.unref&&engine.unref();
 deps.rideEngineTick=engineTick;

 // ── Offer responses ─────────────────────────────────────────────────────────
 app.post('/api/offers/:id/accept',auth,active,dvCap,async(req,res)=>{
  const client=await pool.connect();
  try{
   await client.query('BEGIN');
   const o=(await client.query(`UPDATE ride_offers SET status='accepted',responded_at=NOW() WHERE id::text=$1 AND driver_user_id=$2 AND status='pending' AND expires_at>NOW() RETURNING *`,[req.params.id,req.user.id])).rows[0];
   if(!o){await client.query('ROLLBACK');return res.status(409).json({error:'Offer is no longer available'});}
   const s=(await client.query(`SELECT vehicle_id FROM driver_availability_sessions WHERE driver_user_id=$1 AND status IN('online','paused')`,[req.user.id])).rows[0];
   let ride;
   try{
    ride=(await client.query(`UPDATE ride_requests SET status='driver_assigned',driver_user_id=$2,vehicle_id=$3,assigned_at=NOW(),updated_at=NOW() WHERE id=$1 AND status IN('searching','offered') RETURNING *`,[o.ride_id,req.user.id,s?s.vehicle_id:null])).rows[0];
   }catch(e){
    await client.query('ROLLBACK');
    if(e.code==='23505')return res.status(409).json({error:'You already have an active ride'});
    throw e;
   }
   if(!ride){await client.query('ROLLBACK');return res.status(409).json({error:'Ride is no longer available'});}
   await client.query('COMMIT');
   await rideEvent(ride,req.user.id,'driver_assigned',{driver_id:req.user.id});
   res.json({ride:await rideView(ride,'driver')});
  }catch(e){await client.query('ROLLBACK').catch(()=>{});console.error(e);res.status(500).json({error:'Server error'})}
  finally{client.release()}
 });
 app.post('/api/offers/:id/decline',auth,active,dvCap,async(req,res)=>{
  try{
   const o=(await q(`UPDATE ride_offers SET status='declined',responded_at=NOW() WHERE id::text=$1 AND driver_user_id=$2 AND status='pending' RETURNING *`,[req.params.id,req.user.id])).rows[0];
   if(!o)return res.status(404).json({error:'Offer not found'});
   await addEvent(o.ride_id,req.user.id,'offer_declined',{driver_id:req.user.id});
   dispatchNext(o.ride_id).catch(e=>console.error(e.message));
   res.json({ok:true});
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });

 // ── Ride views (privacy: rider never sees driver documents/phone) ──────────
 async function rideView(r,role){
  const quote=(await q(`SELECT total,components,distance_m,duration_s,currency FROM fare_quotes WHERE id=$1`,[r.quote_id])).rows[0];
  const v={id:r.id,status:r.status,vehicle_category:r.vehicle_category,payment_method:r.payment_method,
   pickup_address:r.pickup_address,dest_address:r.dest_address,pickup_note:r.pickup_note,landmark:r.landmark,
   pickup_lat:r.pickup_lat,pickup_lng:r.pickup_lng,dest_lat:r.dest_lat,dest_lng:r.dest_lng,
   quote,final_fare:r.final_fare,final_components:r.final_components,fare_difference_note:r.fare_difference_note,
   cancel_reason:r.cancel_reason,created_at:r.created_at,assigned_at:r.assigned_at,arrived_at:r.arrived_at,
   started_at:r.started_at,completed_at:r.completed_at,zone_id:r.zone_id};
  if(r.driver_user_id){
   const d=(await q(`SELECT dp.display_name,u.profile_photo_url,
     (SELECT ROUND(AVG(rating)::numeric,1) FROM ride_ratings rr WHERE rr.ratee_id=u.id AND rr.status='active') AS rating,
     (SELECT count(*)::int FROM ride_requests c WHERE c.driver_user_id=u.id AND c.status IN('completed','closed')) AS trips
    FROM users u LEFT JOIN driver_profiles dp ON dp.user_id=u.id WHERE u.id=$1`,[r.driver_user_id])).rows[0];
   const veh=r.vehicle_id?(await q(`SELECT category,make,model,colour,registration_number FROM driver_vehicles WHERE id=$1`,[r.vehicle_id])).rows[0]:null;
   const pres=(await q(`SELECT lat,lng,heading,updated_at FROM driver_presence WHERE driver_user_id=$1`,[r.driver_user_id])).rows[0];
   v.driver={display_name:d?.display_name||'HAPA Driver',photo:d?.profile_photo_url||'',rating:d?.rating,trips:d?.trips||0};
   v.vehicle=veh;
   if(role!=='public'&&ACTIVE_RIDE.includes(r.status))v.driver_position=pres&&pres.lat!=null?{lat:pres.lat,lng:pres.lng,heading:pres.heading,updated_at:pres.updated_at}:null;
  }
  if(role==='rider'&&['completed','closed','payment_pending','payment_failed'].includes(r.status)===false&&r.pin_hash){
   // PIN itself is never stored in plaintext; rider receives it once at creation.
   v.pin_required=['driver_arrived','driver_assigned','driver_en_route'].includes(r.status);
  }
  return v;
 }
 async function loadRideFor(req,res,allowOwner=true){
  const r=(await q(`SELECT * FROM ride_requests WHERE id::text=$1`,[req.params.id])).rows[0];
  if(!r){res.status(404).json({error:'Ride not found'});return null;}
  const me=req.user.id;
  const isRider=r.rider_id===me,isDriver=r.driver_user_id===me,isOwner=req.user.role==='owner';
  if(!isRider&&!isDriver&&!(allowOwner&&isOwner)){res.status(403).json({error:'Not authorized for this ride'});return null;}
  return{r,isRider,isDriver,isOwner};
 }
 // Customer-facing payment status derived from canonical machine status.
 function paymentStatusOf(st){
  if(st==='closed')return 'paid';
  if(st==='payment_failed')return 'failed';
  if(st==='completed'||st==='payment_pending')return 'pending';
  return null;
 }
 app.get('/api/rides/mine',auth,active,async(req,res)=>{
  const rows=(await q(`SELECT r.*,(rr.id IS NOT NULL) AS i_rated FROM ride_requests r
   LEFT JOIN ride_ratings rr ON rr.ride_id=r.id AND rr.rater_id=$1
   WHERE r.rider_id=$1 ORDER BY r.created_at DESC LIMIT 20`,[req.user.id])).rows;
  res.json(await Promise.all(rows.map(async r=>{
   const v=await rideView(r,'rider');
   v.i_rated=r.i_rated===true;
   v.payment_status=paymentStatusOf(r.status);
   return v;
  })));
 });
 app.get('/api/rides/:id',auth,active,async(req,res)=>{
  try{
   const ctx=await loadRideFor(req,res);if(!ctx)return;
   const view=await rideView(ctx.r,ctx.isRider?'rider':ctx.isDriver?'driver':'owner');
   const since=Number(req.query.since_event||0);
   const events=(await q(`SELECT id,event_type,payload,created_at FROM ride_events WHERE ride_id=$1 AND id>$2 ORDER BY id LIMIT 200`,[ctx.r.id,since])).rows;
   res.json({ride:view,events});
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });

 // ── Lifecycle transitions (server-enforced) ────────────────────────────────
 async function transition(req,res,{from,to,by,stampCol,eventType,extra}){
  try{
   const ctx=await loadRideFor(req,res,false);if(!ctx)return;
   if(by==='driver'&&!ctx.isDriver){res.status(403).json({error:'Only the assigned driver can do this'});return null;}
   if(by==='rider'&&!ctx.isRider){res.status(403).json({error:'Only the rider can do this'});return null;}
   const sets=[`status='${to}'`,`updated_at=NOW()`];
   if(stampCol)sets.push(`${stampCol}=NOW()`);
   const vals=[ctx.r.id];let extraSql='';
   if(extra){for(const[k,val]of Object.entries(extra)){vals.push(val);extraSql+=`,${k}=$${vals.length}`;}}
   const r=(await q(`UPDATE ride_requests SET ${sets.join(',')}${extraSql} WHERE id=$1 AND status=ANY('{${from.join(',')}}') RETURNING *`,vals)).rows[0];
   if(!r){res.status(409).json({error:`Ride is ${ctx.r.status}`});return null;}
   await rideEvent(r,req.user.id,eventType,extra||{});
   return r;
  }catch(e){console.error(e);res.status(500).json({error:'Server error'});return null;}
 }
 app.post('/api/rides/:id/en-route',auth,active,async(req,res)=>{
  const r=await transition(req,res,{from:['driver_assigned'],to:'driver_en_route',by:'driver',eventType:'driver_en_route'});
  if(r)res.json({ride:await rideView(r,'driver')});
 });
 app.post('/api/rides/:id/arrived',auth,active,async(req,res)=>{
  const r=await transition(req,res,{from:['driver_assigned','driver_en_route'],to:'driver_arrived',by:'driver',stampCol:'arrived_at',eventType:'driver_arrived'});
  if(r)res.json({ride:await rideView(r,'driver')});
 });
 app.post('/api/rides/:id/verify-pin',auth,active,async(req,res)=>{
  try{
   const ctx=await loadRideFor(req,res,false);if(!ctx)return;
   if(!ctx.isDriver)return res.status(403).json({error:'Only the assigned driver can verify the PIN'});
   if(ctx.r.status!=='driver_arrived')return res.status(409).json({error:'Mark arrival before verifying the PIN'});
   const maxA=Number(await cfg('pin_max_attempts'));
   if(ctx.r.pin_attempts>=maxA)return res.status(429).json({error:'Too many PIN attempts — contact support'});
   const pin=String(req.body?.pin||'').trim();
   if(pinHash(pin)!==ctx.r.pin_hash){
    await q(`UPDATE ride_requests SET pin_attempts=pin_attempts+1,updated_at=NOW() WHERE id=$1`,[ctx.r.id]);
    await addEvent(ctx.r.id,req.user.id,'pin_failed',{attempt:ctx.r.pin_attempts+1});
    return res.status(400).json({error:'Incorrect PIN',attempts_left:maxA-ctx.r.pin_attempts-1});
   }
   const r=(await q(`UPDATE ride_requests SET status='pin_verified',updated_at=NOW() WHERE id=$1 AND status='driver_arrived' RETURNING *`,[ctx.r.id])).rows[0];
   if(!r)return res.status(409).json({error:'Ride state changed'});
   await rideEvent(r,req.user.id,'pin_verified',{});
   res.json({ride:await rideView(r,'driver')});
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });
 app.post('/api/rides/:id/start',auth,active,async(req,res)=>{
  const r=await transition(req,res,{from:['pin_verified'],to:'in_progress',by:'driver',stampCol:'started_at',eventType:'ride_started'});
  if(r)res.json({ride:await rideView(r,'driver')});
 });
 app.post('/api/rides/:id/complete',auth,active,async(req,res)=>{
  try{
   const ctx=await loadRideFor(req,res,false);if(!ctx)return;
   if(!ctx.isDriver)return res.status(403).json({error:'Only the assigned driver can complete the ride'});
   if(ctx.r.status!=='in_progress')return res.status(409).json({error:`Ride is ${ctx.r.status}`});
   const quote=(await q(`SELECT * FROM fare_quotes WHERE id=$1`,[ctx.r.quote_id])).rows[0];
   const comp={...quote.components};
   // Waiting charge from actual arrival→verification gap beyond the free window
   let waiting=0,note='';
   if(ctx.r.arrived_at&&ctx.r.started_at){
    const waitMin=Math.max(0,(new Date(ctx.r.started_at)-new Date(ctx.r.arrived_at))/60000-Number(await cfg('waiting_free_min')));
    waiting=money(waitMin*Number(comp.waiting_per_min||0));
    if(waiting>0)note=`Includes KES ${waiting} waiting time (${Math.round(waitMin)} min beyond free window).`;
   }
   const final=money(Math.max(Number(comp.minimum_fare),Number(quote.total)+waiting));
   comp.waiting_charge=waiting;comp.final_total=final;
   const r=(await q(`UPDATE ride_requests SET status='payment_pending',completed_at=NOW(),final_fare=$2,final_components=$3,fare_difference_note=$4,updated_at=NOW() WHERE id=$1 AND status='in_progress' RETURNING *`,
    [ctx.r.id,final,JSON.stringify(comp),note])).rows[0];
   if(!r)return res.status(409).json({error:'Ride state changed'});
   await q(`UPDATE trip_share_tokens SET expires_at=LEAST(expires_at,NOW()+make_interval(mins=>$2)) WHERE ride_id=$1`,[r.id,Number(await cfg('share_ttl_after_complete_min'))]);
   await rideEvent(r,req.user.id,'ride_completed',{final_fare:final,note});
   if(r.payment_method==='cash'){
    await q(`INSERT INTO ride_payments(ride_id,method,mode,amount,currency,status) VALUES($1,'cash','cash',$2,'KES','pending') ON CONFLICT DO NOTHING`,[r.id,final]);
   }
   res.json({ride:await rideView(r,'driver'),final_fare:final});
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });
 app.post('/api/rides/:id/cancel',auth,active,async(req,res)=>{
  try{
   const ctx=await loadRideFor(req,res,false);if(!ctx)return;
   const reason=String(req.body?.reason||'').trim().slice(0,300);
   let to,from;
   if(ctx.isRider){to='rider_cancelled';from=['searching','offered','driver_assigned','driver_en_route','driver_arrived'];}
   else if(ctx.isDriver){
    if(!reason)return res.status(400).json({error:'A cancellation reason is required'});
    to='driver_cancelled';from=['driver_assigned','driver_en_route','driver_arrived','pin_verified'];
   }else return res.status(403).json({error:'Not authorized'});
   const r=(await q(`UPDATE ride_requests SET status=$3,cancelled_at=NOW(),cancelled_by=$2,cancel_reason=$4,updated_at=NOW() WHERE id=$1 AND status=ANY($5) RETURNING *`,
    [ctx.r.id,req.user.id,to,reason,from])).rows[0];
   if(!r)return res.status(409).json({error:`Ride is ${ctx.r.status} and can no longer be cancelled this way`});
   await q(`UPDATE ride_offers SET status='withdrawn',responded_at=NOW() WHERE ride_id=$1 AND status='pending'`,[r.id]);
   await rideEvent(r,req.user.id,to,{reason});
   if(to==='driver_cancelled'){
    const recent=+(await q(`SELECT count(*)::int n FROM ride_requests WHERE driver_user_id=$1 AND status='driver_cancelled' AND cancelled_at>NOW()-interval '7 days'`,[req.user.id])).rows[0].n;
    if(recent>=3)pushOwner({type:'driver_cancellation_pattern',driver_id:req.user.id,recent,ts:Date.now()});
   }
   res.json({ride:await rideView(r,ctx.isRider?'rider':'driver')});
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });
 app.post('/api/rides/:id/retry',auth,active,async(req,res)=>{
  try{
   const ctx=await loadRideFor(req,res,false);if(!ctx||!ctx.isRider)return ctx?res.status(403).json({error:'Not authorized'}):undefined;
   const r=(await q(`UPDATE ride_requests SET status='searching',search_started_at=NOW(),updated_at=NOW() WHERE id=$1 AND status='no_driver_available' RETURNING *`,[ctx.r.id])).rows[0];
   if(!r)return res.status(409).json({error:'This ride cannot be retried'});
   await q(`DELETE FROM ride_offers WHERE ride_id=$1 AND status IN('expired','declined')`,[r.id]);
   await rideEvent(r,req.user.id,'search_restarted',{});
   dispatchNext(r.id).catch(()=>{});
   res.json({ride:await rideView(r,'rider')});
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });

 // ── Payments ────────────────────────────────────────────────────────────────
 async function finalizeRide(rideId,paymentId){
  const client=await pool.connect();
  try{
   await client.query('BEGIN');
   const r=(await client.query(`SELECT * FROM ride_requests WHERE id=$1 FOR UPDATE`,[rideId])).rows[0];
   if(!r||!['payment_pending','payment_failed'].includes(r.status)){await client.query('ROLLBACK');return null;}
   const comp=r.final_components||{};
   const pct=Number(comp.commission_pct||0);
   const commission=money(Number(r.final_fare)*pct/100);
   const net=money(Number(r.final_fare)-commission);
   await client.query(`INSERT INTO driver_earnings_ledger(driver_user_id,ride_id,gross,commission,net) VALUES($1,$2,$3,$4,$5) ON CONFLICT(ride_id) DO NOTHING`,[r.driver_user_id,r.id,r.final_fare,commission,net]);
   await client.query(`INSERT INTO platform_commission_ledger(ride_id,amount,pct) VALUES($1,$2,$3) ON CONFLICT(ride_id) DO NOTHING`,[r.id,commission,pct]);
   const ref='HAPA-'+Date.now().toString(36).toUpperCase()+'-'+crypto.randomBytes(2).toString('hex').toUpperCase();
   const veh=r.vehicle_id?(await client.query(`SELECT make,model,registration_number FROM driver_vehicles WHERE id=$1`,[r.vehicle_id])).rows[0]:null;
   const drv=(await client.query(`SELECT COALESCE(dp.display_name,u.name) AS name FROM users u LEFT JOIN driver_profiles dp ON dp.user_id=u.id WHERE u.id=$1`,[r.driver_user_id])).rows[0];
   const pay=(await client.query(`SELECT method,mode,status,provider_ref FROM ride_payments WHERE id=$1`,[paymentId])).rows[0];
   const quote=(await client.query(`SELECT distance_m,duration_s FROM fare_quotes WHERE id=$1`,[r.quote_id])).rows[0];
   const body={reference:ref,ride_id:r.id,datetime:new Date().toISOString(),pickup:r.pickup_address,destination:r.dest_address,
    driver:drv?.name,vehicle:veh?`${veh.make} ${veh.model}`.trim():null,registration:veh?.registration_number,
    distance_m:quote.distance_m,duration_s:quote.duration_s,components:comp,total:Number(r.final_fare),currency:'KES',
    payment_method:pay?.method,payment_mode:pay?.mode,payment_status:'confirmed',payment_ref:pay?.provider_ref||null,
    commission:commission,driver_earnings:net,note:r.fare_difference_note||null};
   await client.query(`INSERT INTO ride_receipts(ride_id,reference,body) VALUES($1,$2,$3) ON CONFLICT(ride_id) DO NOTHING`,[r.id,ref,JSON.stringify(body)]);
   const closed=(await client.query(`UPDATE ride_requests SET status='closed',closed_at=NOW(),updated_at=NOW() WHERE id=$1 RETURNING *`,[r.id])).rows[0];
   await client.query('COMMIT');
   await rideEvent(closed,null,'payment_confirmed',{receipt:ref,method:pay?.method});
   return closed;
  }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}
  finally{client.release()}
 }
 // Cash: driver confirms collection
 app.post('/api/rides/:id/cash-collected',auth,active,async(req,res)=>{
  try{
   const ctx=await loadRideFor(req,res,false);if(!ctx)return;
   if(!ctx.isDriver)return res.status(403).json({error:'Only the assigned driver can confirm cash'});
   if(ctx.r.status!=='payment_pending'||ctx.r.payment_method!=='cash')return res.status(409).json({error:'No cash payment is pending'});
   const p=(await q(`UPDATE ride_payments SET status='confirmed',updated_at=NOW() WHERE ride_id=$1 AND method='cash' AND status='pending' RETURNING *`,[ctx.r.id])).rows[0];
   if(!p)return res.status(409).json({error:'Payment already processed'});
   await q(`INSERT INTO ride_payment_events(payment_id,event_type,dedupe_key,payload) VALUES($1,'cash_confirmed',$2,'{}') ON CONFLICT DO NOTHING`,[p.id,'cash_'+ctx.r.id]);
   const closed=await finalizeRide(ctx.r.id,p.id);
   res.json({ride:closed?await rideView(closed,'driver'):null});
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });
 app.post('/api/rides/:id/report-unpaid',auth,active,async(req,res)=>{
  try{
   const ctx=await loadRideFor(req,res,false);if(!ctx||!ctx.isDriver)return ctx?res.status(403).json({error:'Only the assigned driver can report this'}):undefined;
   await q(`INSERT INTO safety_incidents(ride_id,reporter_id,kind,description) VALUES($1,$2,'payment',$3)`,[ctx.r.id,req.user.id,String(req.body?.description||'Cash not collected').slice(0,500)]);
   pushOwner({type:'incident',kind:'payment',ride_id:ctx.r.id,ts:Date.now()});
   res.status(201).json({ok:true});
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });
 // M-Pesa: rider initiates STK push (mock/sandbox/live via adapter)
 app.post('/api/rides/:id/pay-mpesa',auth,active,writeLimiter,async(req,res)=>{
  try{
   const ctx=await loadRideFor(req,res,false);if(!ctx)return;
   if(!ctx.isRider)return res.status(403).json({error:'Only the rider can pay'});
   if(!['payment_pending','payment_failed'].includes(ctx.r.status)||ctx.r.payment_method!=='mpesa')return res.status(409).json({error:'No M-Pesa payment is due'});
   const phone=String(req.body?.phone||'').replace(/\D/g,'');
   if(!/^254\d{9}$/.test(phone))return res.status(400).json({error:'Enter a valid Kenyan phone number (2547XXXXXXXX)'});
   const st=mpesa.status();
   if(st.mode==='live'&&(await cfg('mpesa_live_authorized'))!==true)return res.status(503).json({error:'Live M-Pesa is not authorized by the Owner yet'});
   const idem='mp_'+ctx.r.id;
   const init=await mpesa.stkPush({phone,amount:ctx.r.final_fare,reference:'HAPARIDE',description:'HAPA ride'});
   let p;
   try{
    p=(await q(`INSERT INTO ride_payments(ride_id,method,mode,amount,currency,status,provider_request_id,phone_masked,idempotency_key)
     VALUES($1,'mpesa',$2,$3,'KES','initiated',$4,$5,$6) RETURNING *`,
     [ctx.r.id,init.mode,ctx.r.final_fare,init.checkoutRequestId,phone.slice(0,6)+'***'+phone.slice(-2),idem])).rows[0];
   }catch(e){
    if(e.code==='23505')return res.status(409).json({error:'A payment is already in progress for this ride'});
    throw e;
   }
   await addEvent(ctx.r.id,req.user.id,'payment_initiated',{mode:init.mode});
   if(init.mode==='mock'){
    // Simulated Daraja callback (clearly labelled; same idempotent path as real callbacks)
    setTimeout(()=>{applyMpesaCallback(init.mockCallback(true)).catch(e=>console.error('mock cb error:',e.message));},1200);
   }
   res.status(202).json({payment_id:p.id,mode:init.mode,status:'initiated',note:init.mode==='mock'?'MOCK payment — simulated automatically, no real money moves.':'Confirm the STK prompt on your phone.'});
  }catch(e){
   if(e.statusCode)return res.status(e.statusCode).json({error:e.message});
   console.error(e);res.status(500).json({error:'Server error'});
  }
 });
 // Daraja callback — public endpoint, idempotent, replay-safe.
 async function applyMpesaCallback(body){
  const cb=mpesa.parseCallback(body);
  if(!cb)return{ok:false};
  const p=(await q(`SELECT * FROM ride_payments WHERE provider_request_id=$1`,[cb.checkoutRequestId])).rows[0];
  if(!p)return{ok:false};
  // Correlation checks: never trust the callback beyond what we initiated.
  if(p.status!=='initiated')return{ok:true,replay:true};
  if(cb.success&&cb.amount!=null&&Math.round(Number(cb.amount))!==Math.round(Number(p.amount))){
   await q(`INSERT INTO ride_payment_events(payment_id,event_type,dedupe_key,payload) VALUES($1,'callback_amount_mismatch',$2,$3) ON CONFLICT DO NOTHING`,
    [p.id,cb.checkoutRequestId+':mismatch',JSON.stringify({expected:p.amount,got:cb.amount})]);
   console.error('mpesa callback amount mismatch for payment',p.id);
   return{ok:false};
  }
  const dedupe=cb.checkoutRequestId+':'+cb.resultCode;
  const ev=await q(`INSERT INTO ride_payment_events(payment_id,event_type,dedupe_key,payload) VALUES($1,'stk_callback',$2,$3) ON CONFLICT DO NOTHING RETURNING id`,
   [p.id,dedupe,JSON.stringify({resultCode:cb.resultCode,resultDesc:cb.resultDesc,receipt:cb.receipt})]);
  if(!ev.rowCount)return{ok:true,replay:true};// replayed callback: acknowledged, not reprocessed
  if(cb.success){
   const upd=(await q(`UPDATE ride_payments SET status='confirmed',provider_ref=$2,updated_at=NOW() WHERE id=$1 AND status='initiated' RETURNING *`,[p.id,cb.receipt])).rows[0];
   if(upd)await finalizeRide(p.ride_id,p.id);
  }else{
   await q(`UPDATE ride_payments SET status='failed',updated_at=NOW() WHERE id=$1 AND status='initiated'`,[p.id]);
   const r=(await q(`UPDATE ride_requests SET status='payment_failed',updated_at=NOW() WHERE id=$1 AND status='payment_pending' RETURNING *`,[p.ride_id])).rows[0];
   if(r)await rideEvent(r,null,'payment_failed',{reason:cb.resultDesc});
  }
  return{ok:true};
 }
 app.post('/api/payments/mpesa/callback',async(req,res)=>{
  try{await applyMpesaCallback(req.body||{});res.json({ResultCode:0,ResultDesc:'Accepted'});}
  catch(e){console.error('mpesa cb error:',e.message);res.json({ResultCode:0,ResultDesc:'Accepted'});}
 });
 app.get('/api/rides/:id/receipt',auth,active,async(req,res)=>{
  try{
   const ctx=await loadRideFor(req,res);if(!ctx)return;
   const rec=(await q(`SELECT reference,body,created_at FROM ride_receipts WHERE ride_id=$1`,[ctx.r.id])).rows[0];
   if(!rec)return res.status(404).json({error:'No receipt yet'});
   res.json(rec);
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });
 // Branded customer-facing PDF (same auth as the JSON receipt; never public,
 // never cached, no commission/earnings/internal accounting fields).
 app.get('/api/rides/:id/receipt.pdf',auth,active,async(req,res)=>{
  try{
   const ctx=await loadRideFor(req,res);if(!ctx)return;
   const rec=(await q(`SELECT reference,body,created_at FROM ride_receipts WHERE ride_id=$1`,[ctx.r.id])).rows[0];
   if(!rec)return res.status(404).json({error:'No receipt yet'});
   const pdf=buildReceiptPdf(rec.reference,rec.body,rec.created_at);
   const safeRef=String(rec.reference).replace(/[^A-Za-z0-9-]/g,'');
   res.set({'Content-Type':'application/pdf',
    'Content-Disposition':`attachment; filename="HAPA-Receipt-${safeRef}.pdf"`,
    'Cache-Control':'private, no-store'});
   res.send(pdf);
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });

 // ── Chat (participants; Owner only with a reported incident on the ride) ───
 app.post('/api/rides/:id/messages',auth,active,writeLimiter,async(req,res)=>{
  try{
   const ctx=await loadRideFor(req,res,false);if(!ctx)return;
   if(!ctx.isRider&&!ctx.isDriver)return res.status(403).json({error:'Not authorized'});
   const body=String(req.body?.body||'').trim().slice(0,500);
   if(!body)return res.status(400).json({error:'Message is empty'});
   const m=(await q(`INSERT INTO ride_messages(ride_id,sender_id,body) VALUES($1,$2,$3) RETURNING *`,[ctx.r.id,req.user.id,body])).rows[0];
   const other=ctx.isRider?ctx.r.driver_user_id:ctx.r.rider_id;
   if(other)push(other,{type:'ride_message',ride_id:ctx.r.id,from:ctx.isRider?'rider':'driver',body,ts:Date.now()});
   res.status(201).json({id:m.id,created_at:m.created_at});
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });
 app.get('/api/rides/:id/messages',auth,active,async(req,res)=>{
  try{
   const r=(await q(`SELECT * FROM ride_requests WHERE id::text=$1`,[req.params.id])).rows[0];
   if(!r)return res.status(404).json({error:'Ride not found'});
   const me=req.user.id;
   const participant=r.rider_id===me||r.driver_user_id===me;
   if(!participant){
    // Owner access requires a justified support case (reported incident)
    const justified=req.user.role==='owner'&&(await q(`SELECT 1 FROM safety_incidents WHERE ride_id=$1`,[r.id])).rowCount;
    if(!justified)return res.status(403).json({error:'Not authorized'});
    await audit(me,'ride_chat_support_access','ride',r.id,'incident-justified');
   }
   const rows=(await q(`SELECT m.id,m.sender_id,m.body,m.created_at,(m.sender_id=$2) AS mine FROM ride_messages m WHERE m.ride_id=$1 ORDER BY m.created_at LIMIT 200`,[r.id,me])).rows;
   res.json(rows);
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });

 // ── Safety: share trip, trusted contacts, emergency, incidents ─────────────
 app.post('/api/rides/:id/share',auth,active,async(req,res)=>{
  try{
   const ctx=await loadRideFor(req,res,false);if(!ctx||!ctx.isRider)return ctx?res.status(403).json({error:'Only the rider can share the trip'}):undefined;
   const token=crypto.randomBytes(18).toString('hex');
   const t=(await q(`INSERT INTO trip_share_tokens(ride_id,token,expires_at) VALUES($1,$2,NOW()+interval '4 hours') RETURNING *`,[ctx.r.id,token])).rows[0];
   res.status(201).json({token:t.token,url:'/trip/'+t.token,expires_at:t.expires_at});
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });
 app.post('/api/rides/:id/share/revoke',auth,active,async(req,res)=>{
  try{
   const ctx=await loadRideFor(req,res,false);if(!ctx||!ctx.isRider)return ctx?res.status(403).json({error:'Not authorized'}):undefined;
   await q(`UPDATE trip_share_tokens SET revoked=TRUE WHERE ride_id=$1`,[ctx.r.id]);
   res.json({ok:true});
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });
 // Public live trip page data — minimum necessary; no phones, docs, payment data.
 app.get('/api/public/trip/:token',async(req,res)=>{
  try{
   const t=(await q(`SELECT * FROM trip_share_tokens WHERE token=$1 AND NOT revoked AND expires_at>NOW()`,[String(req.params.token)])).rows[0];
   if(!t)return res.status(404).json({error:'This trip link has expired'});
   const r=(await q(`SELECT * FROM ride_requests WHERE id=$1`,[t.ride_id])).rows[0];
   const v=await rideView(r,'public');
   res.json({status:r.status,pickup_address:v.pickup_address,dest_address:v.dest_address,
    driver:v.driver?{display_name:v.driver.display_name}:null,
    vehicle:v.vehicle?{make:v.vehicle.make,model:v.vehicle.model,colour:v.vehicle.colour,registration_number:v.vehicle.registration_number}:null,
    driver_position:ACTIVE_RIDE.includes(r.status)?(await q(`SELECT lat,lng,updated_at FROM driver_presence WHERE driver_user_id=$1`,[r.driver_user_id])).rows[0]||null:null,
    reference:r.id.slice(0,8).toUpperCase()});
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });
 app.get('/api/me/trusted-contacts',auth,active,async(req,res)=>{
  res.json((await q(`SELECT id,name,phone,created_at FROM trusted_contacts WHERE user_id=$1 ORDER BY created_at`,[req.user.id])).rows);
 });
 app.post('/api/me/trusted-contacts',auth,active,async(req,res)=>{
  try{
   const name=String(req.body?.name||'').trim().slice(0,80),phone=String(req.body?.phone||'').trim().slice(0,20);
   if(!name||!phone)return res.status(400).json({error:'Name and phone are required'});
   const n=+(await q(`SELECT count(*)::int n FROM trusted_contacts WHERE user_id=$1`,[req.user.id])).rows[0].n;
   if(n>=5)return res.status(400).json({error:'Maximum 5 trusted contacts'});
   res.status(201).json((await q(`INSERT INTO trusted_contacts(user_id,name,phone) VALUES($1,$2,$3) RETURNING id,name,phone`,[req.user.id,name,phone])).rows[0]);
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });
 app.delete('/api/me/trusted-contacts/:id',auth,active,async(req,res)=>{
  await q(`DELETE FROM trusted_contacts WHERE id::text=$1 AND user_id=$2`,[req.params.id,req.user.id]);
  res.json({ok:true});
 });
 app.get('/api/rides/:id/emergency',auth,active,async(req,res)=>{
  try{
   const ctx=await loadRideFor(req,res,false);if(!ctx)return;
   const phone=process.env.SUPPORT_EMERGENCY_PHONE||null;
   const pres=ctx.r.driver_user_id?(await q(`SELECT lat,lng,updated_at FROM driver_presence WHERE driver_user_id=$1`,[ctx.r.driver_user_id])).rows[0]:null;
   const v=await rideView(ctx.r,'rider');
   await addEvent(ctx.r.id,req.user.id,'emergency_opened',{});
   pushOwner({type:'emergency_opened',ride_id:ctx.r.id,by:req.user.id,ts:Date.now()});
   res.json({emergency_phone:phone,configured:!!phone,
    note:phone?'Call the number below. HAPA support is notified.':'No emergency contact configured yet. Call 999 (Kenya Police) or 112 directly.',
    ride_reference:ctx.r.id.slice(0,8).toUpperCase(),driver:v.driver||null,vehicle:v.vehicle||null,
    last_position:pres&&pres.lat!=null?pres:null});
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });
 app.post('/api/safety/incidents',auth,active,writeLimiter,async(req,res)=>{
  try{
   const b=req.body||{};
   const kind=['safety','lost_item','payment','other'].includes(String(b.kind))?String(b.kind):'other';
   let rideId=null;
   if(b.ride_id){
    const r=(await q(`SELECT id,rider_id,driver_user_id FROM ride_requests WHERE id::text=$1`,[String(b.ride_id)])).rows[0];
    if(!r||(r.rider_id!==req.user.id&&r.driver_user_id!==req.user.id))return res.status(403).json({error:'Not authorized for this ride'});
    rideId=r.id;
   }
   const i=(await q(`INSERT INTO safety_incidents(ride_id,reporter_id,kind,description) VALUES($1,$2,$3,$4) RETURNING *`,
    [rideId,req.user.id,kind,String(b.description||'').trim().slice(0,1000)])).rows[0];
   if(rideId)await addEvent(rideId,req.user.id,'incident_reported',{kind});
   pushOwner({type:'incident',kind,ride_id:rideId,ts:Date.now()});
   res.status(201).json({id:i.id,status:i.status});
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });

 // ── Two-way ratings ─────────────────────────────────────────────────────────
 app.post('/api/rides/:id/rate',auth,active,async(req,res)=>{
  try{
   const ctx=await loadRideFor(req,res,false);if(!ctx)return;
   if(!ctx.isRider&&!ctx.isDriver)return res.status(403).json({error:'Only ride participants can rate'});
   if(!['completed','closed','payment_pending'].includes(ctx.r.status))return res.status(409).json({error:'Ratings open after the ride is completed'});
   const rating=Number(req.body?.rating);
   if(!Number.isInteger(rating)||rating<1||rating>5)return res.status(400).json({error:'Rating must be 1–5'});
   const ratee=ctx.isRider?ctx.r.driver_user_id:ctx.r.rider_id;
   if(!ratee||ratee===req.user.id)return res.status(400).json({error:'No one to rate on this ride'});
   const r=await q(`INSERT INTO ride_ratings(ride_id,rater_id,ratee_id,role,rating,comment) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(ride_id,rater_id) DO NOTHING RETURNING *`,
    [ctx.r.id,req.user.id,ratee,ctx.isRider?'rider':'driver',rating,String(req.body?.comment||'').trim().slice(0,500)]);
   if(!r.rowCount)return res.status(409).json({error:'You already rated this ride'});
   res.status(201).json(r.rows[0]);
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });

 // ── Owner transport operations ──────────────────────────────────────────────
 app.get('/api/owner/transport',auth,owner,async(req,res)=>{
  try{
   const staleS=Number(await cfg('presence_stale_s'));
   const one=async sql=>+(await q(sql)).rows[0].n;
   const stats={
    online_drivers:+(await q(`SELECT count(*)::int n FROM driver_availability_sessions WHERE status='online'`)).rows[0].n,
    stale_drivers:+(await q(`SELECT count(*)::int n FROM driver_availability_sessions s LEFT JOIN driver_presence p ON p.driver_user_id=s.driver_user_id WHERE s.status='online' AND (p.updated_at IS NULL OR p.updated_at<NOW()-make_interval(secs=>${staleS}))`)).rows[0].n,
    searching:await one(`SELECT count(*)::int n FROM ride_requests WHERE status IN('searching','offered')`),
    pending_offers:await one(`SELECT count(*)::int n FROM ride_offers WHERE status='pending' AND expires_at>NOW()`),
    active_rides:await one(`SELECT count(*)::int n FROM ride_requests WHERE status IN('driver_assigned','driver_en_route','driver_arrived','pin_verified','in_progress')`),
    completed_today:await one(`SELECT count(*)::int n FROM ride_requests WHERE status IN('completed','closed') AND completed_at::date=CURRENT_DATE`),
    cancellations_today:await one(`SELECT count(*)::int n FROM ride_requests WHERE status IN('rider_cancelled','driver_cancelled') AND cancelled_at::date=CURRENT_DATE`),
    no_driver_today:await one(`SELECT count(*)::int n FROM ride_requests WHERE status='no_driver_available' AND updated_at::date=CURRENT_DATE`),
    payment_failures:await one(`SELECT count(*)::int n FROM ride_payments WHERE status='failed'`),
    open_incidents:await one(`SELECT count(*)::int n FROM safety_incidents WHERE status='open'`),
    docs_expiring_30d:await one(`SELECT count(*)::int n FROM driver_document_status WHERE status='approved' AND expires_on BETWEEN CURRENT_DATE AND CURRENT_DATE+30`),
    pending_vehicles:await one(`SELECT count(*)::int n FROM driver_vehicles WHERE status='pending'`),
    pending_documents:await one(`SELECT count(*)::int n FROM driver_document_status WHERE status='pending'`),
   };
   const rides=(await q(`SELECT r.id,r.status,r.pickup_address,r.dest_address,r.final_fare,r.created_at,r.vehicle_category,g.name AS zone_name,u.name AS rider_name,du.name AS driver_name
    FROM ride_requests r JOIN geo_areas g ON g.id=r.zone_id JOIN users u ON u.id=r.rider_id LEFT JOIN users du ON du.id=r.driver_user_id
    ORDER BY r.created_at DESC LIMIT 30`)).rows;
   const incidents=(await q(`SELECT i.*,u.name AS reporter_name FROM safety_incidents i JOIN users u ON u.id=i.reporter_id ORDER BY i.created_at DESC LIMIT 20`)).rows;
   const payments=(await q(`SELECT p.id,p.ride_id,p.method,p.mode,p.amount,p.status,p.provider_ref,p.created_at FROM ride_payments p ORDER BY p.created_at DESC LIMIT 20`)).rows;
   const ledger=(await q(`SELECT COALESCE(SUM(amount),0) AS commission_total FROM platform_commission_ledger`)).rows[0];
   const pendingVehicles=(await q(`SELECT v.*,u.name AS driver_name FROM driver_vehicles v JOIN users u ON u.id=v.driver_user_id WHERE v.status='pending' ORDER BY v.created_at LIMIT 20`)).rows;
   const pendingDocs=(await q(`SELECT d.*,u.name AS driver_name FROM driver_document_status d JOIN users u ON u.id=d.driver_user_id WHERE d.status='pending' ORDER BY d.created_at LIMIT 20`)).rows;
   res.json({stats,rides,incidents,payments,commission_total:ledger.commission_total,pending_vehicles:pendingVehicles,pending_documents:pendingDocs,mpesa:mpesa.status()});
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });
 // Strip exact coordinates from any value destined for the default Owner
 // operations view. Exact-location access is a separate audited action.
 function scrubCoords(o){
  if(!o||typeof o!=='object')return o;
  for(const k of Object.keys(o)){
   if(/(^|_)(lat|lng|latitude|longitude)$/i.test(k))delete o[k];
   else if(o[k]&&typeof o[k]==='object')scrubCoords(o[k]);
  }
  return o;
 }
 // Nairobi formatting for operational reports/exports (DB keeps UTC).
 const NRB_D=new Intl.DateTimeFormat('en-KE',{timeZone:'Africa/Nairobi',year:'numeric',month:'2-digit',day:'2-digit'});
 const NRB_T=new Intl.DateTimeFormat('en-KE',{timeZone:'Africa/Nairobi',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
 const nrbD=d=>d?NRB_D.format(new Date(d)).split('/').reverse().join('-'):'';
 const nrbT=d=>d?NRB_T.format(new Date(d)):'';

 // Shared, fully parameterized Owner ride filter (search + CSV export).
 const OWNER_RIDE_STATUSES=['searching','offered','driver_assigned','driver_en_route','driver_arrived','pin_verified','in_progress','completed','rider_cancelled','driver_cancelled','declined','no_driver_available','payment_pending','payment_failed','closed'];
 function ownerRideFilter(qs){
  const where=[],vals=[];
  const add=(sql,v)=>{vals.push(v);where.push(sql.replace(/\$X/g,'$'+vals.length));};
  if(qs.ref)add(`(rc.reference ILIKE $X OR r.id::text ILIKE $X)`, String(qs.ref).slice(0,40)+'%');
  if(qs.rider)add(`(ru.name ILIKE $X OR ru.email ILIKE $X)`,'%'+String(qs.rider).slice(0,80)+'%');
  if(qs.driver)add(`(du.name ILIKE $X OR du.email ILIKE $X)`,'%'+String(qs.driver).slice(0,80)+'%');
  if(qs.reg)add(`v.registration_number ILIKE $X`,'%'+String(qs.reg).slice(0,20)+'%');
  if(qs.from&&/^\d{4}-\d{2}-\d{2}$/.test(qs.from))add(`(COALESCE(r.completed_at,r.created_at) AT TIME ZONE 'Africa/Nairobi')::date>=$X::date`,qs.from);
  if(qs.to&&/^\d{4}-\d{2}-\d{2}$/.test(qs.to))add(`(COALESCE(r.completed_at,r.created_at) AT TIME ZONE 'Africa/Nairobi')::date<=$X::date`,qs.to);
  if(qs.zone)add(`(g.slug=$X OR g.name ILIKE $X)`,String(qs.zone).slice(0,80));
  if(qs.county)add(`EXISTS(WITH RECURSIVE anc(id,parent_id,name,level) AS(
    SELECT id,parent_id,name,level FROM geo_areas WHERE id=r.zone_id
    UNION ALL SELECT p.id,p.parent_id,p.name,p.level FROM geo_areas p JOIN anc ON anc.parent_id=p.id)
   SELECT 1 FROM anc WHERE level='county' AND name ILIKE $X)`,'%'+String(qs.county).slice(0,60)+'%');
  if(qs.status&&OWNER_RIDE_STATUSES.includes(qs.status))add(`r.status=$X`,qs.status);
  if(qs.payment_method&&['cash','mpesa'].includes(qs.payment_method))add(`r.payment_method=$X`,qs.payment_method);
  if(qs.payment_status==='paid')where.push(`r.status='closed'`);
  else if(qs.payment_status==='pending')where.push(`r.status IN('completed','payment_pending')`);
  else if(qs.payment_status==='failed')where.push(`r.status='payment_failed'`);
  if(qs.payout_status&&['unsettled','processing','paid'].includes(qs.payout_status))add(`l.payout_status=$X`,qs.payout_status);
  if(qs.vehicle_category)add(`r.vehicle_category=$X`,String(qs.vehicle_category).slice(0,40));
  return{where:where.length?'WHERE '+where.join(' AND '):'',vals};
 }
 const OWNER_RIDE_FROM=`FROM ride_requests r
   JOIN geo_areas g ON g.id=r.zone_id
   JOIN users ru ON ru.id=r.rider_id
   LEFT JOIN users du ON du.id=r.driver_user_id
   LEFT JOIN driver_vehicles v ON v.id=r.vehicle_id
   LEFT JOIN driver_earnings_ledger l ON l.ride_id=r.id
   LEFT JOIN ride_receipts rc ON rc.ride_id=r.id`;

 // Owner ride search: server-side filters + pagination, never coordinates.
 app.get('/api/owner/rides',auth,owner,async(req,res)=>{
  try{
   const{where,vals}=ownerRideFilter(req.query);
   const page=Math.max(1,Math.min(500,Number(req.query.page)||1));
   const per=30;
   vals.push(per,(page-1)*per);
   const rows=(await q(`SELECT r.id,r.status,r.vehicle_category,r.payment_method,r.pickup_address,r.dest_address,
     r.final_fare,r.created_at,r.completed_at,g.name AS zone_name,ru.name AS rider_name,du.name AS driver_name,
     v.registration_number,l.gross,l.commission,l.net,l.payout_status,rc.reference AS receipt_reference
    ${OWNER_RIDE_FROM} ${where}
    ORDER BY r.created_at DESC LIMIT $${vals.length-1} OFFSET $${vals.length}`,vals)).rows;
   const total=+(await q(`SELECT count(*)::int n ${OWNER_RIDE_FROM} ${where}`,vals.slice(0,-2))).rows[0].n;
   for(const r of rows)r.payment_status=paymentStatusOf(r.status);
   res.json({rides:rows,total,page,per});
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });

 // Owner-only CSV accounting export (audited, formula-injection safe, UTF-8).
 app.get('/api/owner/rides-export.csv',auth,owner,async(req,res)=>{
  try{
   const{where,vals}=ownerRideFilter(req.query);
   const rows=(await q(`SELECT r.id,r.status,r.vehicle_category,r.payment_method,r.pickup_address,r.dest_address,
     r.final_fare,r.created_at,r.assigned_at,r.started_at,r.completed_at,g.name AS zone_name,
     ru.name AS rider_name,du.name AS driver_name,v.registration_number,
     l.gross,l.commission,l.net,l.payout_status,rc.reference AS receipt_reference,
     fq.distance_m
    ${OWNER_RIDE_FROM} JOIN fare_quotes fq ON fq.id=r.quote_id ${where}
    ORDER BY r.created_at DESC LIMIT 5000`,vals)).rows;
   const cell=v=>{
    let s=v==null?'':String(v);
    if(/^[=+\-@]/.test(s))s="'"+s;           // neutralize spreadsheet formulas
    if(/[",\r\n]/.test(s))s='"'+s.replace(/"/g,'""')+'"';
    return s;
   };
   const kes=v=>v==null?'':Number(v).toFixed(2);
   const head=['Ride reference','Operational date (Africa/Nairobi)','Requested time (Africa/Nairobi)','Accepted time (Africa/Nairobi)','Started time (Africa/Nairobi)','Completed time (Africa/Nairobi)','Ride duration (min)','Rider','Driver','Vehicle registration','Vehicle category','Service zone','Pickup','Destination','Distance (km)','Gross fare (KES)','HAPA commission (KES)','Driver net earnings (KES)','Payment method','Payment status','Payout status','Ride status','Receipt reference'];
   const lines=[head.map(cell).join(',')];
   for(const r of rows){
    const dur=r.started_at&&r.completed_at?((new Date(r.completed_at)-new Date(r.started_at))/60000).toFixed(1):'';
    lines.push([
     r.receipt_reference||r.id.slice(0,8).toUpperCase(),
     nrbD(r.completed_at||r.created_at),nrbT(r.created_at),nrbT(r.assigned_at),nrbT(r.started_at),nrbT(r.completed_at),dur,
     r.rider_name,r.driver_name||'',r.registration_number||'',r.vehicle_category,r.zone_name,
     r.pickup_address,r.dest_address,r.distance_m!=null?(r.distance_m/1000).toFixed(1):'',
     kes(r.gross!=null?r.gross:r.final_fare),kes(r.commission),kes(r.net),
     r.payment_method,paymentStatusOf(r.status)||'',r.payout_status||'',r.status,r.receipt_reference||''
    ].map(cell).join(','));
   }
   await audit(req.user.id,'accounting_export','rides',null,`rows=${rows.length} filters=${JSON.stringify(req.query).slice(0,300)}`);
   res.set('Content-Type','text/csv; charset=utf-8');
   res.set('Content-Disposition','attachment; filename="hapa-ride-accounting.csv"');
   res.send('\uFEFF'+lines.join('\r\n'));
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });

 // Owner-only Driver earnings report (persisted rides + ledgers, never cards).
 app.get('/api/owner/driver-earnings',auth,owner,async(req,res)=>{
  try{
   const{where,vals}=ownerRideFilter(req.query);
   const base=where?where+' AND r.driver_user_id IS NOT NULL':'WHERE r.driver_user_id IS NOT NULL';
   const rows=(await q(`SELECT du.id AS driver_id,du.name AS driver_name,du.status AS account_status,
     count(DISTINCT r.id) FILTER (WHERE r.status IN('completed','closed')) AS completed_rides,
     count(DISTINCT r.id) FILTER (WHERE r.status IN('rider_cancelled','driver_cancelled')) AS cancellations,
     count(DISTINCT r.id) FILTER (WHERE r.status IN('completed','payment_pending','payment_failed')) AS unpaid_rides,
     COALESCE(SUM(l.gross),0) AS gross,COALESCE(SUM(l.commission),0) AS commission,COALESCE(SUM(l.net),0) AS net,
     COALESCE(SUM(l.gross) FILTER (WHERE r.payment_method='cash' AND r.status='closed'),0) AS cash_collected,
     COALESCE(SUM(l.gross) FILTER (WHERE r.payment_method='mpesa' AND r.status='closed'),0) AS mpesa_collected,
     COALESCE(SUM(l.net) FILTER (WHERE l.payout_status='unsettled'),0) AS unsettled,
     COALESCE(SUM(l.net) FILTER (WHERE l.payout_status='paid'),0) AS settled,
     COALESCE(SUM(EXTRACT(EPOCH FROM (r.completed_at-r.started_at)) ) FILTER (WHERE r.completed_at IS NOT NULL AND r.started_at IS NOT NULL),0)::bigint AS driving_seconds,
     (SELECT ROUND(AVG(rating)::numeric,1) FROM ride_ratings rr WHERE rr.ratee_id=du.id AND rr.status='active') AS rating,
     (SELECT g2.name FROM driver_availability_sessions s JOIN geo_areas g2 ON g2.id=s.zone_id WHERE s.driver_user_id=du.id ORDER BY s.started_at DESC LIMIT 1) AS zone_name,
     (SELECT v2.make||' '||v2.model||' · '||v2.registration_number FROM driver_vehicles v2 WHERE v2.driver_user_id=du.id ORDER BY v2.created_at DESC LIMIT 1) AS vehicle_label,
     (SELECT COALESCE(SUM(s.online_seconds+CASE WHEN s.status IN('online','paused') THEN EXTRACT(EPOCH FROM (NOW()-s.started_at))::int ELSE 0 END),0) FROM driver_availability_sessions s WHERE s.driver_user_id=du.id)::bigint AS online_seconds
    ${OWNER_RIDE_FROM} ${base}
    GROUP BY du.id,du.name,du.status ORDER BY gross DESC LIMIT 200`,vals)).rows;
   const totals=rows.reduce((t,r)=>({
    completed_rides:t.completed_rides+Number(r.completed_rides),gross:t.gross+Number(r.gross),
    commission:t.commission+Number(r.commission),net:t.net+Number(r.net),
    cash_collected:t.cash_collected+Number(r.cash_collected),mpesa_collected:t.mpesa_collected+Number(r.mpesa_collected),
    unsettled:t.unsettled+Number(r.unsettled)
   }),{completed_rides:0,gross:0,commission:0,net:0,cash_collected:0,mpesa_collected:0,unsettled:0});
   res.json({drivers:rows,totals});
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });

 app.get('/api/owner/rides/:id',auth,owner,async(req,res)=>{
  try{
   const r=(await q(`SELECT * FROM ride_requests WHERE id::text=$1`,[req.params.id])).rows[0];
   if(!r)return res.status(404).json({error:'Ride not found'});
   await audit(req.user.id,'ride_ops_view','ride',r.id,'');
   const events=(await q(`SELECT e.id,e.actor_id,u.name AS actor_name,e.event_type,e.payload,e.created_at FROM ride_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.ride_id=$1 ORDER BY e.id`,[r.id])).rows;
   const offers=(await q(`SELECT o.id,o.status,o.round,o.created_at,o.responded_at,o.expires_at,u.name AS driver_name FROM ride_offers o JOIN users u ON u.id=o.driver_user_id WHERE o.ride_id=$1 ORDER BY o.created_at`,[r.id])).rows;
   const payments=(await q(`SELECT id,method,mode,amount,currency,status,provider_ref,phone_masked,created_at FROM ride_payments WHERE ride_id=$1`,[r.id])).rows;
   const receipt=(await q(`SELECT reference,created_at FROM ride_receipts WHERE ride_id=$1`,[r.id])).rows[0]||null;
   const incidents=(await q(`SELECT id,kind,description,status,resolution_note,created_at FROM safety_incidents WHERE ride_id=$1`,[r.id])).rows;
   const ratings=(await q(`SELECT role,rating,comment,status,created_at FROM ride_ratings WHERE ride_id=$1`,[r.id])).rows;
   const quote=(await q(`SELECT total,components,distance_m,duration_s,currency,created_at FROM fare_quotes WHERE id=$1`,[r.quote_id])).rows[0]||null;
   const ledger=(await q(`SELECT gross,commission,net,payout_status FROM driver_earnings_ledger WHERE ride_id=$1`,[r.id])).rows[0]||null;
   const zone=(await q(`SELECT name,slug FROM geo_areas WHERE id=$1`,[r.zone_id])).rows[0]||null;
   const rider=(await q(`SELECT u.id,u.name,u.status,
     (SELECT ROUND(AVG(rating)::numeric,1) FROM ride_ratings rr WHERE rr.ratee_id=u.id AND rr.status='active') AS rating
    FROM users u WHERE u.id=$1`,[r.rider_id])).rows[0]||null;
   const view=await rideView(r,'owner');
   // Default Owner details view: no raw coordinates. Exact-location access is
   // a separate, explicitly audited support action (POST …/locations).
   scrubCoords(view);events.forEach(e=>scrubCoords(e.payload));
   view.payment_status=paymentStatusOf(r.status);
   const actual_duration_s=r.started_at&&r.completed_at?Math.round((new Date(r.completed_at)-new Date(r.started_at))/1000):null;
   res.json({ride:view,zone,rider,ledger,quote,events,offers,payments,receipt,incidents,ratings,actual_duration_s});
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });
 // Explicit, audited exact-location access for support investigations only.
 app.post('/api/owner/rides/:id/locations',auth,owner,async(req,res)=>{
  try{
   const reason=String(req.body?.reason||'').trim();
   if(reason.length<5)return res.status(400).json({error:'A support reason is required to view exact locations'});
   const r=(await q(`SELECT id,pickup_lat,pickup_lng,dest_lat,dest_lng FROM ride_requests WHERE id::text=$1`,[req.params.id])).rows[0];
   if(!r)return res.status(404).json({error:'Ride not found'});
   await audit(req.user.id,'ride_location_access','ride',r.id,reason.slice(0,300));
   const samples=(await q(`SELECT lat,lng,recorded_at FROM ride_location_samples WHERE ride_id=$1 ORDER BY id LIMIT 500`,[r.id])).rows;
   res.json({pickup:{lat:r.pickup_lat,lng:r.pickup_lng},destination:{lat:r.dest_lat,lng:r.dest_lng},samples});
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });
 // Driver earnings totals for a Nairobi-operational date range.
 app.get('/api/driver/earnings',auth,active,dvCap,async(req,res)=>{
  try{
   const vals=[req.user.id];let range='';
   if(req.query.from&&/^\d{4}-\d{2}-\d{2}$/.test(req.query.from)){vals.push(req.query.from);range+=` AND (COALESCE(r.completed_at,r.created_at) AT TIME ZONE 'Africa/Nairobi')::date>=$${vals.length}::date`;}
   if(req.query.to&&/^\d{4}-\d{2}-\d{2}$/.test(req.query.to)){vals.push(req.query.to);range+=` AND (COALESCE(r.completed_at,r.created_at) AT TIME ZONE 'Africa/Nairobi')::date<=$${vals.length}::date`;}
   const t=(await q(`SELECT
     count(*) FILTER (WHERE r.status IN('completed','closed'))::int AS completed_rides,
     COALESCE(SUM(l.gross),0) AS gross,COALESCE(SUM(l.commission),0) AS commission,COALESCE(SUM(l.net),0) AS net,
     COALESCE(SUM(l.gross) FILTER (WHERE r.payment_method='cash' AND r.status='closed'),0) AS cash_collected,
     COALESCE(SUM(l.gross) FILTER (WHERE r.payment_method='mpesa' AND r.status='closed'),0) AS mpesa_collected,
     COALESCE(SUM(l.net) FILTER (WHERE l.payout_status='unsettled'),0) AS unsettled,
     COALESCE(SUM(l.net) FILTER (WHERE l.payout_status='paid'),0) AS settled,
     COALESCE(SUM(EXTRACT(EPOCH FROM (r.completed_at-r.started_at))) FILTER (WHERE r.completed_at IS NOT NULL AND r.started_at IS NOT NULL),0)::bigint AS driving_seconds
    FROM ride_requests r LEFT JOIN driver_earnings_ledger l ON l.ride_id=r.id
    WHERE r.driver_user_id=$1${range}`,vals)).rows[0];
   const ses=(await q(`SELECT COALESCE(SUM(online_seconds+CASE WHEN status IN('online','paused') THEN EXTRACT(EPOCH FROM (NOW()-started_at))::int ELSE 0 END),0)::bigint AS online_seconds
    FROM driver_availability_sessions WHERE driver_user_id=$1${range.replace(/COALESCE\(r\.completed_at,r\.created_at\)/g,'started_at')}`,vals)).rows[0];
   res.json({...t,online_seconds:ses.online_seconds});
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });
 app.post('/api/owner/rides/:id/cancel',auth,owner,async(req,res)=>{
  try{
   const note=String(req.body?.note||'').trim();
   if(!note)return res.status(400).json({error:'A support note is required for an operational cancellation'});
   const r=(await q(`UPDATE ride_requests SET status='rider_cancelled',cancelled_at=NOW(),cancelled_by=$2,cancel_reason=$3,updated_at=NOW() WHERE id::text=$1 AND status=ANY($4) RETURNING *`,
    [req.params.id,req.user.id,'[HAPA support] '+note.slice(0,280),['searching','offered',...ACTIVE_RIDE]])).rows[0];
   if(!r)return res.status(409).json({error:'This ride cannot be cancelled'});
   await q(`UPDATE ride_offers SET status='withdrawn',responded_at=NOW() WHERE ride_id=$1 AND status='pending'`,[r.id]);
   await audit(req.user.id,'ride_ops_cancel','ride',r.id,note.slice(0,200));
   await rideEvent(r,req.user.id,'support_cancelled',{note});
   res.json({ok:true});
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });
 app.patch('/api/owner/incidents/:id',auth,owner,async(req,res)=>{
  try{
   const st=String(req.body?.status||'');
   if(!['reviewing','resolved'].includes(st))return res.status(400).json({error:'Invalid status'});
   const r=await q(`UPDATE safety_incidents SET status=$2,resolution_note=$3,resolved_by=$4,updated_at=NOW() WHERE id::text=$1 RETURNING *`,
    [req.params.id,st,String(req.body?.note||'').slice(0,500),req.user.id]);
   if(!r.rowCount)return res.status(404).json({error:'Incident not found'});
   await audit(req.user.id,'incident_'+st,'safety_incident',req.params.id,'');
   res.json(r.rows[0]);
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });
 // Compliance settings (audited; this is where legal limits live)
 app.get('/api/owner/compliance',auth,owner,async(req,res)=>{
  res.json((await q(`SELECT key,value,note,updated_at FROM compliance_settings ORDER BY key`)).rows);
 });
 app.patch('/api/owner/compliance/:key',auth,owner,async(req,res)=>{
  try{
   if(!('value'in(req.body||{})))return res.status(400).json({error:'value is required'});
   if(req.params.key==='commission_max_pct'&&Number(req.body.value)>18)
    return res.status(400).json({error:'Commission above 18% exceeds the NTSA (LN 120/2022) cap. Update only with verified current legal basis.'});
   const r=await q(`UPDATE compliance_settings SET value=$2,updated_by=$3,updated_at=NOW() WHERE key=$1 RETURNING *`,[req.params.key,JSON.stringify(req.body.value),req.user.id]);
   if(!r.rowCount)return res.status(404).json({error:'Unknown setting'});
   cfgCache.t=0;
   await audit(req.user.id,'compliance_updated','compliance_setting',req.params.key,JSON.stringify(req.body.value).slice(0,150));
   res.json(r.rows[0]);
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });
 // Activation gates for a controlled CASH pilot.
 // Mandatory gates block production readiness; optional integrations never do.
 app.get('/api/owner/ride-gates',auth,owner,async(req,res)=>{
  try{
   const zone=(await q(`SELECT id FROM geo_areas WHERE slug='zone-embu-pilot' AND active`)).rows[0];
   const card=zone?await findCard(zone.id,(await cfg('vehicle_categories'))[0]):null;
   const g=(gate,required,pass,readyDetail,blockedDetail)=>({gate,required,pass:!!pass,
    status:pass?'READY':(required?'BLOCKED':'OPTIONAL — NOT CONFIGURED'),
    detail:pass?readyDetail:blockedDetail});
   const gates=[
    g('RIDE_HAILING_ENABLED',true,await rideHailingEnabled(),'Master feature switch is on','Master feature switch is off (compliance setting ride_hailing_enabled)'),
    g('TNC_LICENSE_CONFIRMED',true,String(process.env.TNC_LICENSE_CONFIRMED||'')==='true',
     process.env.TNC_LICENSE_REFERENCE?'Licence confirmed, reference on file':'Licence confirmed (add TNC_LICENSE_REFERENCE)',
     'NTSA TNC licence not confirmed — set TNC_LICENSE_CONFIRMED and TNC_LICENSE_REFERENCE'),
    g('GOOGLE_MAPS_BROWSER_KEY',true,!!process.env.GOOGLE_MAPS_BROWSER_KEY,'Browser Maps key configured','Browser Maps key missing — pickup/destination map UX unavailable'),
    g('GOOGLE_MAPS_SERVER_KEY',true,!!process.env.GOOGLE_MAPS_SERVER_KEY,'Server routing key configured','Server routing key missing — fares use labelled estimates, not real routes'),
    g('SUPPORT_EMERGENCY_PHONE',true,!!process.env.SUPPORT_EMERGENCY_PHONE,'Emergency/support line configured','Emergency/support phone not set — Safety Centre has no live line'),
    g('RATE_CARD',true,!!card,
     card?`Active card resolved: ${card.vehicle_category} from ${String(card.effective_from).slice(0,10)}`:'',
     zone?'No active, currently-effective rate card resolves for the pilot zone (zone or ancestor, passenger-car category)':'Pilot zone is missing or inactive'),
    g('MPESA',false,mpesa.status().ready&&mpesa.status().mode!=='mock',
     'M-Pesa live: '+mpesa.status().mode,'Cash pilot runs without it — configure Daraja credentials to enable M-Pesa'),
    g('PHONE_MASKING',false,String(process.env.PHONE_MASKING_ENABLED||'')==='true',
     'External masking provider enabled','Not required — authenticated in-app chat keeps personal numbers hidden'),
   ];
   res.json({gates,production_ready:gates.filter(x=>x.required).every(x=>x.pass)});
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });
};
