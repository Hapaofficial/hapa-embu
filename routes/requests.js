// Unified request/enquiry/booking system + reviews + generic reports + owner
// support tooling. One consistent model for Professional, Merchant and Driver.
module.exports=function(app,deps){
 const{q,auth,active,owner,audit,writeLimiter}=deps;

 const REQ_TYPES={professional:['service'],merchant:['enquiry','order','reservation'],driver:['ride','delivery','transport']};
 const PROFILE_TABLE={professional:'professional_profiles',merchant:'merchant_profiles',driver:'driver_profiles'};
 const CAP_KEY={professional:'professional',merchant:'merchant',driver:'driver'};
 // Allowed transitions: who may move a request to what, from which statuses.
 const TRANSITIONS={
  accepted:{from:['pending'],by:'provider'},
  declined:{from:['pending'],by:'provider'},
  completed:{from:['accepted'],by:'provider'},
  cancelled:{from:['pending','accepted'],by:'customer'}
 };

 const reqSafe=r=>({id:r.id,provider_type:r.provider_type,profile_id:r.profile_id,item_id:r.item_id,
  request_type:r.request_type,pickup_text:r.pickup_text,destination_text:r.destination_text,
  pickup_lat:r.pickup_lat,pickup_lng:r.pickup_lng,destination_lat:r.destination_lat,destination_lng:r.destination_lng,
  pickup_address:r.pickup_address,destination_address:r.destination_address,pickup_note:r.pickup_note,landmark:r.landmark,
  route_distance_m:r.route_distance_m,route_duration_s:r.route_duration_s,
  requested_for:r.requested_for,note:r.note,status:r.status,created_at:r.created_at,updated_at:r.updated_at,
  accepted_at:r.accepted_at,declined_at:r.declined_at,cancelled_at:r.cancelled_at,completed_at:r.completed_at});

 async function addEvent(requestId,actorId,type,status,message){
  await q(`INSERT INTO request_events(request_id,actor_id,event_type,status,message) VALUES($1,$2,$3,$4,$5)`,[requestId,actorId,type,status||null,message||null]);
 }

 // ── Create ─────────────────────────────────────────────────────────────────
 app.post('/api/requests',auth,active,writeLimiter,async(req,res)=>{
  try{
   const b=req.body||{};
   const pt=String(b.provider_type||'');
   if(!REQ_TYPES[pt])return res.status(400).json({error:'Invalid provider type'});
   const rt=String(b.request_type||'');
   if(!REQ_TYPES[pt].includes(rt))return res.status(400).json({error:'Invalid request type for this provider'});
   // Provider profile must be publicly visible
   const p=(await q(`SELECT p.id,p.user_id FROM ${PROFILE_TABLE[pt]} p JOIN users u ON u.id=p.user_id WHERE p.id::text=$1 AND p.status='active' AND u.status='active' AND (u.capabilities->>'${CAP_KEY[pt]}')='true'`,[String(b.profile_id||'')])).rows[0];
   if(!p)return res.status(404).json({error:'Provider not found'});
   if(p.user_id===req.user.id)return res.status(400).json({error:'You cannot send a request to yourself'});
   let itemId=null;
   if(b.item_id){
    if(pt!=='merchant')return res.status(400).json({error:'item_id only applies to merchant requests'});
    const it=(await q(`SELECT id FROM merchant_items WHERE id::text=$1 AND merchant_profile_id=$2 AND status='active'`,[String(b.item_id),p.id])).rows[0];
    if(!it)return res.status(404).json({error:'Listing not found'});
    itemId=it.id;
   }
   if(pt==='driver'&&(!String(b.pickup_text||b.pickup_address||'').trim()||!String(b.destination_text||b.destination_address||'').trim()))
    return res.status(400).json({error:'Pickup and destination are required'});
   // ── Precise GPS coordinates (driver requests only). Server-side validated:
   // lat+lng of a point must be present together and within valid ranges.
   // Coordinates are exposed only through the authorized request endpoints
   // (customer / addressed provider / owner) — never through public APIs.
   const geo={pickup_lat:null,pickup_lng:null,destination_lat:null,destination_lng:null,pickup_address:null,destination_address:null,pickup_note:null,landmark:null,route_distance_m:null,route_duration_s:null};
   if(pt==='driver'){
    for(const side of['pickup','destination']){
     const la=b[side+'_lat'],ln=b[side+'_lng'];
     if(la!=null||ln!=null){
      const vla=Number(la),vln=Number(ln);
      if(!Number.isFinite(vla)||!Number.isFinite(vln)||Math.abs(vla)>90||Math.abs(vln)>180)return res.status(400).json({error:'Invalid '+side+' coordinates'});
      geo[side+'_lat']=vla;geo[side+'_lng']=vln;
     }
     if(b[side+'_address'])geo[side+'_address']=String(b[side+'_address']).trim().slice(0,300)||null;
    }
    if(b.pickup_note)geo.pickup_note=String(b.pickup_note).trim().slice(0,300)||null;
    if(b.landmark)geo.landmark=String(b.landmark).trim().slice(0,200)||null;
    if(b.route_distance_m!=null){const d=Math.round(Number(b.route_distance_m));if(Number.isFinite(d)&&d>=0&&d<2e6)geo.route_distance_m=d;}
    if(b.route_duration_s!=null){const d=Math.round(Number(b.route_duration_s));if(Number.isFinite(d)&&d>=0&&d<2e5)geo.route_duration_s=d;}
   }
   const note=String(b.note||'').trim().slice(0,1000);
   if(pt!=='driver'&&!note&&!itemId)return res.status(400).json({error:'Please describe what you need'});
   const open=+(await q(`SELECT count(*)::int n FROM service_requests WHERE customer_id=$1 AND provider_user_id=$2 AND status IN('pending','accepted')`,[req.user.id,p.user_id])).rows[0].n;
   if(open>=3)return res.status(409).json({error:'You already have open requests with this provider'});
   const r=(await q(`INSERT INTO service_requests(customer_id,provider_user_id,provider_type,profile_id,item_id,request_type,pickup_text,destination_text,requested_for,note,
     pickup_lat,pickup_lng,destination_lat,destination_lng,pickup_address,destination_address,pickup_note,landmark,route_distance_m,route_duration_s)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
    [req.user.id,p.user_id,pt,p.id,itemId,rt,String(b.pickup_text||b.pickup_address||'').trim().slice(0,300),String(b.destination_text||b.destination_address||'').trim().slice(0,300),String(b.requested_for||'').trim().slice(0,120),note,
     geo.pickup_lat,geo.pickup_lng,geo.destination_lat,geo.destination_lng,geo.pickup_address,geo.destination_address,geo.pickup_note,geo.landmark,geo.route_distance_m,geo.route_duration_s])).rows[0];
   await addEvent(r.id,req.user.id,'created','pending',null);
   res.status(201).json(reqSafe(r));
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });

 // ── Lists ──────────────────────────────────────────────────────────────────
 const LIST_JOIN=`
  LEFT JOIN professional_profiles pp ON sr.provider_type='professional' AND pp.id=sr.profile_id
  LEFT JOIN merchant_profiles mp ON sr.provider_type='merchant' AND mp.id=sr.profile_id
  LEFT JOIN driver_profiles dp ON sr.provider_type='driver' AND dp.id=sr.profile_id
  LEFT JOIN merchant_items mi ON mi.id=sr.item_id`;
 const PROVIDER_NAME=`COALESCE(pp.display_name,mp.business_name,dp.display_name,'') AS provider_name,mi.title AS item_title`;

 app.get('/api/me/requests',auth,async(req,res)=>{
  try{
   const rows=(await q(`SELECT sr.*,${PROVIDER_NAME},EXISTS(SELECT 1 FROM reviews rv WHERE rv.request_id=sr.id) AS reviewed
    FROM service_requests sr ${LIST_JOIN} WHERE sr.customer_id=$1 ORDER BY sr.created_at DESC LIMIT 100`,[req.user.id])).rows;
   res.json(rows.map(r=>({...reqSafe(r),provider_name:r.provider_name,item_title:r.item_title,reviewed:r.reviewed,role:'customer'})));
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });

 app.get('/api/me/provider-requests',auth,active,async(req,res)=>{
  try{
   const rows=(await q(`SELECT sr.*,${PROVIDER_NAME},u.name AS customer_name
    FROM service_requests sr ${LIST_JOIN} JOIN users u ON u.id=sr.customer_id
    WHERE sr.provider_user_id=$1 ORDER BY CASE sr.status WHEN 'pending' THEN 0 WHEN 'accepted' THEN 1 ELSE 2 END,sr.created_at DESC LIMIT 100`,[req.user.id])).rows;
   res.json(rows.map(r=>({...reqSafe(r),provider_name:r.provider_name,item_title:r.item_title,customer_name:r.customer_name,role:'provider'})));
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });

 // ── Detail (parties + platform owner only; contact rules applied) ──────────
 app.get('/api/requests/:id',auth,async(req,res)=>{
  try{
   const r=(await q(`SELECT sr.*,${PROVIDER_NAME},cu.name AS customer_name,cu.phone AS customer_phone,pu.name AS provider_account_name,pu.phone AS provider_phone,
     COALESCE(pp.phone_visible,mp.phone_visible,dp.phone_visible,false) AS provider_phone_visible,
     EXISTS(SELECT 1 FROM reviews rv WHERE rv.request_id=sr.id) AS reviewed
    FROM service_requests sr ${LIST_JOIN}
    JOIN users cu ON cu.id=sr.customer_id JOIN users pu ON pu.id=sr.provider_user_id
    WHERE sr.id::text=$1`,[req.params.id])).rows[0];
   if(!r)return res.status(404).json({error:'Request not found'});
   const isCustomer=r.customer_id===req.user.id,isProvider=r.provider_user_id===req.user.id,isPlatformOwner=req.user.role==='owner';
   if(!isCustomer&&!isProvider&&!isPlatformOwner)return res.status(404).json({error:'Request not found'});
   const events=(await q(`SELECT e.id,e.event_type,e.status,e.message,e.created_at,e.actor_id,u.name AS actor_name FROM request_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.request_id=$1 ORDER BY e.created_at ASC`,[r.id])).rows
    .map(e=>({id:e.id,event_type:e.event_type,status:e.status,message:e.message,created_at:e.created_at,actor_name:e.actor_name,mine:e.actor_id===req.user.id}));
   const out={...reqSafe(r),provider_name:r.provider_name,item_title:r.item_title,customer_name:r.customer_name,reviewed:r.reviewed,
    role:isCustomer?'customer':isProvider?'provider':'owner',events};
   // Contact rules: customer phone → provider only once accepted; provider phone
   // → customer per the provider's public visibility setting.
   if((isProvider||isPlatformOwner)&&['accepted','completed'].includes(r.status))out.customer_phone=r.customer_phone;
   if((isCustomer||isPlatformOwner)&&(r.provider_phone_visible||['accepted','completed'].includes(r.status)))out.provider_phone=r.provider_phone;
   res.json(out);
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });

 // ── Messages ───────────────────────────────────────────────────────────────
 app.post('/api/requests/:id/message',auth,active,writeLimiter,async(req,res)=>{
  try{
   const msg=String(req.body.message||'').trim().slice(0,1000);
   if(!msg)return res.status(400).json({error:'Message required'});
   const r=(await q(`SELECT id,customer_id,provider_user_id,status FROM service_requests WHERE id::text=$1`,[req.params.id])).rows[0];
   if(!r||(r.customer_id!==req.user.id&&r.provider_user_id!==req.user.id))return res.status(404).json({error:'Request not found'});
   if(['declined','cancelled'].includes(r.status))return res.status(409).json({error:'This request is closed'});
   await addEvent(r.id,req.user.id,'message',null,msg);
   res.status(201).json({ok:true});
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });

 // ── Status transitions ─────────────────────────────────────────────────────
 app.post('/api/requests/:id/status',auth,active,async(req,res)=>{
  try{
   const to=String(req.body.status||'');
   const t=TRANSITIONS[to];
   if(!t)return res.status(400).json({error:'Invalid status'});
   const r=(await q(`SELECT * FROM service_requests WHERE id::text=$1`,[req.params.id])).rows[0];
   if(!r||(r.customer_id!==req.user.id&&r.provider_user_id!==req.user.id))return res.status(404).json({error:'Request not found'});
   const actorRole=r.customer_id===req.user.id?'customer':'provider';
   if(t.by!==actorRole)return res.status(403).json({error:`Only the ${t.by} can ${to==='cancelled'?'cancel':to.replace('ed','')} this request`});
   if(!t.from.includes(r.status))return res.status(409).json({error:`Request is already ${r.status}`});
   const ts={accepted:'accepted_at',declined:'declined_at',cancelled:'cancelled_at',completed:'completed_at'}[to];
   const upd=(await q(`UPDATE service_requests SET status=$2,updated_at=NOW(),${ts}=NOW()${to==='cancelled'?',cancelled_by=$3':''} WHERE id=$1 AND status=ANY($${to==='cancelled'?4:3}) RETURNING *`,
    to==='cancelled'?[r.id,to,req.user.id,t.from]:[r.id,to,t.from])).rows[0];
   if(!upd)return res.status(409).json({error:'Request status changed, refresh and try again'});
   await addEvent(r.id,req.user.id,'status',to,null);
   res.json(reqSafe(upd));
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });

 // ── Reviews ────────────────────────────────────────────────────────────────
 app.post('/api/requests/:id/review',auth,active,writeLimiter,async(req,res)=>{
  try{
   const rating=+req.body.rating;
   const comment=String(req.body.comment||'').trim().slice(0,1000);
   if(!Number.isInteger(rating)||rating<1||rating>5)return res.status(400).json({error:'Rating must be 1–5'});
   const r=(await q(`SELECT * FROM service_requests WHERE id::text=$1`,[req.params.id])).rows[0];
   if(!r||r.customer_id!==req.user.id)return res.status(404).json({error:'Request not found'});
   if(r.status!=='completed')return res.status(409).json({error:'You can review only after the request is completed'});
   if(r.provider_user_id===req.user.id)return res.status(403).json({error:'You cannot review yourself'});
   if((await q(`SELECT 1 FROM reviews WHERE request_id=$1`,[r.id])).rowCount)return res.status(409).json({error:'You already reviewed this request'});
   const rv=(await q(`INSERT INTO reviews(request_id,reviewer_id,provider_user_id,provider_type,rating,comment) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,rating,comment,created_at`,
    [r.id,req.user.id,r.provider_user_id,r.provider_type,rating,comment])).rows[0];
   res.status(201).json(rv);
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });

 // Public reviews for a provider profile
 app.get('/api/public/providers/:type/:profileId/reviews',async(req,res)=>{
  try{
   const pt=String(req.params.type||'');
   if(!PROFILE_TABLE[pt])return res.status(400).json({error:'Invalid provider type'});
   const p=(await q(`SELECT p.user_id FROM ${PROFILE_TABLE[pt]} p JOIN users u ON u.id=p.user_id WHERE p.id::text=$1 AND p.status='active' AND u.status='active'`,[req.params.profileId])).rows[0];
   if(!p)return res.status(404).json({error:'Provider not found'});
   const rows=(await q(`SELECT rv.id,rv.rating,rv.comment,rv.created_at,u.name AS reviewer_name FROM reviews rv JOIN users u ON u.id=rv.reviewer_id WHERE rv.provider_user_id=$1 AND rv.provider_type=$2 AND rv.status='active' ORDER BY rv.created_at DESC LIMIT 50`,[p.user_id,pt])).rows;
   const agg=(await q(`SELECT ROUND(AVG(rating)::numeric,1) AS avg,count(*)::int AS n FROM reviews WHERE provider_user_id=$1 AND provider_type=$2 AND status='active'`,[p.user_id,pt])).rows[0];
   res.json({rating_avg:agg.avg,rating_count:agg.n,reviews:rows});
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });

 // ── Generic reports (profiles, users, items, reviews, requests, problems) ──
 const REPORT_TARGETS=['user','professional_profile','merchant_profile','driver_profile','merchant_item','review','request','problem'];
 const REPORT_REASONS=['scam','fake_profile','offensive_content','unsafe_behaviour','wrong_information','spam','app_problem','other'];
 app.post('/api/reports',auth,active,writeLimiter,async(req,res)=>{
  try{
   const tt=String(req.body.target_type||''),reason=String(req.body.reason||'');
   if(!REPORT_TARGETS.includes(tt))return res.status(400).json({error:'Invalid report target'});
   if(!REPORT_REASONS.includes(reason))return res.status(400).json({error:'Invalid reason'});
   const details=String(req.body.details||'').trim().slice(0,1000);
   let targetId=null;
   if(tt!=='problem'){
    targetId=String(req.body.target_id||'');
    if(!/^[0-9a-f-]{36}$/i.test(targetId))return res.status(400).json({error:'target_id required'});
   }else if(!details)return res.status(400).json({error:'Please describe the problem'});
   if((await q(`SELECT 1 FROM reports WHERE reporter_id=$1 AND target_type=$2 AND COALESCE(target_id::text,'')=COALESCE($3,'') AND status='pending'`,[req.user.id,tt,targetId])).rowCount)
    return res.status(409).json({error:'You already have a pending report for this'});
   await q(`INSERT INTO reports(reporter_id,target_type,target_id,reason,details) VALUES($1,$2,$3,$4,$5)`,[req.user.id,tt,targetId,reason,details]);
   res.status(201).json({ok:true});
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });

 // ── Owner support/moderation ───────────────────────────────────────────────
 app.get('/api/owner/requests',auth,owner,async(req,res)=>{
  try{
   const vals=[];let w='1=1';
   if(['pending','accepted','declined','cancelled','completed'].includes(req.query.status)){vals.push(req.query.status);w+=` AND sr.status=$${vals.length}`;}
   if(REQ_TYPES[req.query.provider_type]){vals.push(req.query.provider_type);w+=` AND sr.provider_type=$${vals.length}`;}
   const rows=(await q(`SELECT sr.*,${PROVIDER_NAME},cu.name AS customer_name,pu.name AS provider_account_name
    FROM service_requests sr ${LIST_JOIN} JOIN users cu ON cu.id=sr.customer_id JOIN users pu ON pu.id=sr.provider_user_id
    WHERE ${w} ORDER BY sr.created_at DESC LIMIT 200`,vals)).rows;
   res.json(rows.map(r=>({...reqSafe(r),provider_name:r.provider_name,item_title:r.item_title,customer_name:r.customer_name,provider_account_name:r.provider_account_name})));
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });

 app.get('/api/owner/reviews',auth,owner,async(req,res)=>{
  try{
   const rows=(await q(`SELECT rv.*,u.name AS reviewer_name,pu.name AS provider_account_name FROM reviews rv JOIN users u ON u.id=rv.reviewer_id JOIN users pu ON pu.id=rv.provider_user_id ORDER BY rv.created_at DESC LIMIT 200`)).rows;
   res.json(rows.map(r=>({id:r.id,request_id:r.request_id,provider_type:r.provider_type,rating:r.rating,comment:r.comment,status:r.status,moderation_note:r.moderation_note,created_at:r.created_at,reviewer_name:r.reviewer_name,provider_account_name:r.provider_account_name})));
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });
 app.patch('/api/owner/reviews/:id/status',auth,owner,async(req,res)=>{
  try{
   const{status,moderation_note}=req.body||{};
   if(!['owner_hidden','active'].includes(status))return res.status(400).json({error:'status must be owner_hidden or active'});
   const r=(await q(`UPDATE reviews SET status=$2,moderation_note=$3,hidden_at=CASE WHEN $2='owner_hidden' THEN NOW() ELSE NULL END,hidden_by=CASE WHEN $2='owner_hidden' THEN $4::uuid ELSE NULL END WHERE id=$1 RETURNING id,status,moderation_note`,[req.params.id,status,moderation_note?String(moderation_note).slice(0,500):null,req.user.id])).rows[0];
   if(!r)return res.status(404).json({error:'Review not found'});
   await audit(req.user.id,status==='owner_hidden'?'hide_review':'restore_review','review',req.params.id,moderation_note);
   res.json(r);
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });

 app.get('/api/owner/reports',auth,owner,async(req,res)=>{
  try{
   const s=['pending','reviewed','dismissed','all'].includes(req.query.status)?req.query.status:'pending';
   const rows=(await q(`SELECT r.*,u.name AS reporter_name FROM reports r LEFT JOIN users u ON u.id=r.reporter_id${s!=='all'?` WHERE r.status=$1`:''} ORDER BY r.created_at DESC LIMIT 200`,s!=='all'?[s]:[])).rows;
   res.json(rows);
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });
 app.patch('/api/owner/reports/:id',auth,owner,async(req,res)=>{
  try{
   const s=req.body.status;
   if(!['reviewed','dismissed'].includes(s))return res.status(400).json({error:'Invalid status'});
   const r=(await q(`UPDATE reports SET status=$2,reviewed_at=NOW(),reviewed_by=$3 WHERE id=$1 RETURNING *`,[req.params.id,s,req.user.id])).rows[0];
   if(!r)return res.status(404).json({error:'Not found'});
   await audit(req.user.id,'report_'+s,'report',req.params.id,'');
   res.json(r);
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });

 app.get('/api/owner/audit-log',auth,owner,async(req,res)=>{
  try{
   const rows=(await q(`SELECT a.*,u.name AS actor_name FROM owner_audit_log a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.created_at DESC LIMIT 200`)).rows;
   res.json(rows);
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });
};
