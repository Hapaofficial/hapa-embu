// Driver module — public driver profile. Mirrors Professional/Merchant:
// verified application stays separate; public profile is marketing data only.
module.exports=function(app,deps){
 const{q,auth,active,owner,docUpload,pm,audit,isVerifiedExpr,uploadLimiter}=deps;

 const DV_EDITABLE=['display_name','vehicle_description','county','town','service_area','availability','pricing_info','phone_visible','whatsapp_visible'];
 const DV_LOCKED=['vehicle_type','vehicleType','registrationNumber','drivingLicenceNumber','status','user_id','role','capabilities','moderation_note','hidden_by','hidden_at'];
 const dvCap=(req,res,next)=>(req.user.capabilities||{}).driver===true?next():res.status(403).json({error:'Driver capability required'});
 const dvApprovedApp=async userId=>(await q(`SELECT id,details FROM upgrade_applications WHERE user_id=$1 AND type='driver' AND status='approved' ORDER BY created_at DESC LIMIT 1`,[userId])).rows[0]||null;
 const dvMine=async userId=>(await q(`SELECT * FROM driver_profiles WHERE user_id=$1`,[userId])).rows[0]||null;
 const dvSafe=p=>({id:p.id,status:p.status,vehicle_type:p.vehicle_type,display_name:p.display_name,vehicle_description:p.vehicle_description,county:p.county,town:p.town,service_area:p.service_area,availability:p.availability,pricing_info:p.pricing_info,phone_visible:p.phone_visible,whatsapp_visible:p.whatsapp_visible,profile_photo_id:p.profile_photo_id,moderation_note:p.status==='owner_hidden'?p.moderation_note:null,created_at:p.created_at,updated_at:p.updated_at,published_at:p.published_at,paused_at:p.paused_at});
 async function dvPhoto(profileId,base){return(await pm.images('driver_profile',profileId,base)).filter(i=>i.kind==='profile_photo')[0]||null;}
 async function dvPayload(p){return{profile:dvSafe(p),profile_photo:await dvPhoto(p.id,pm.PM_OWNER_BASE)};}

 app.get('/api/me/driver-profile',auth,active,dvCap,async(req,res)=>{
  try{const p=await dvMine(req.user.id);if(!p)return res.json({profile:null});res.json(await dvPayload(p));}
  catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });

 app.post('/api/me/driver-profile',auth,active,dvCap,async(req,res)=>{
  try{
   if(req.user.role!=='customer')return res.status(403).json({error:'Only customer accounts can hold a driver profile'});
   if(await dvMine(req.user.id))return res.status(409).json({error:'Profile already exists'});
   const a=await dvApprovedApp(req.user.id);
   if(!a)return res.status(403).json({error:'An approved Driver application is required'});
   const d=a.details||{};
   const p=(await q(`INSERT INTO driver_profiles(user_id,application_id,vehicle_type,display_name,county,town)
    VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
    [req.user.id,a.id,String(d.vehicleType||'').slice(0,80),String(req.user.name||'').slice(0,80),String(d.county||'').slice(0,80),String(d.town||'').slice(0,80)])).rows[0];
   res.status(201).json(await dvPayload(p));
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });

 app.patch('/api/me/driver-profile',auth,active,dvCap,async(req,res)=>{
  try{
   const p=await dvMine(req.user.id);
   if(!p)return res.status(404).json({error:'Profile not found'});
   const body=req.body||{};
   const lockedHit=Object.keys(body).find(k=>DV_LOCKED.includes(k));
   if(lockedHit)return res.status(400).json({error:`Field "${lockedHit}" is verified and cannot be edited here. Contact HAPA support to request a change.`});
   const sets=[],vals=[p.id];
   for(const k of DV_EDITABLE){
    if(!(k in body))continue;
    let v=body[k];
    if(k==='phone_visible'||k==='whatsapp_visible')v=v===true;
    else v=String(v==null?'':v).trim().slice(0,k==='vehicle_description'?1000:200);
    vals.push(v);sets.push(`${k}=$${vals.length}`);
   }
   if('county'in body&&String(body.county||'').trim()&&!(await deps.geo.countyKnown(body.county)))return res.status(400).json({error:'Enter a valid Kenyan county'});
   if(!sets.length)return res.status(400).json({error:'No editable fields provided'});
   const r=(await q(`UPDATE driver_profiles SET ${sets.join(',')},updated_at=NOW() WHERE id=$1 RETURNING *`,vals)).rows[0];
   res.json(await dvPayload(r));
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });

 async function dvTransition(req,res,from,to){
  try{
   const p=await dvMine(req.user.id);
   if(!p)return res.status(404).json({error:'Profile not found'});
   if(p.status==='owner_hidden')return res.status(403).json({error:'This profile was hidden by HAPA moderation. Contact HAPA support.'});
   if(!from.includes(p.status))return res.status(409).json({error:`Profile is ${p.status}`});
   if(to==='active'){
    if(!(await dvApprovedApp(req.user.id)))return res.status(403).json({error:'An approved Driver application is required to publish'});
    if(!String(p.display_name).trim())return res.status(400).json({error:'Add a display name before publishing'});
    // Service-area gate: drivers may only go online inside an ACTIVE market.
    if(!(await deps.geo.countyActive(p.county)))return res.status(403).json({error:'HAPA is not yet live in "'+(p.county||'your area')+'". This area will open automatically once activated.'});
   }
   const r=(await q(`UPDATE driver_profiles SET status=$2,updated_at=NOW(),
     published_at=CASE WHEN $2='active' AND published_at IS NULL THEN NOW() ELSE published_at END,
     paused_at=CASE WHEN $2='paused' THEN NOW() ELSE paused_at END
     WHERE id=$1 RETURNING *`,[p.id,to])).rows[0];
   res.json(await dvPayload(r));
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 }
 app.post('/api/me/driver-profile/publish',auth,active,dvCap,(req,res)=>dvTransition(req,res,['draft','paused'],'active'));
 app.post('/api/me/driver-profile/pause',auth,active,dvCap,(req,res)=>dvTransition(req,res,['active'],'paused'));
 app.post('/api/me/driver-profile/reactivate',auth,active,dvCap,(req,res)=>dvTransition(req,res,['paused'],'active'));

 app.post('/api/me/driver-profile/profile-photo',auth,active,dvCap,uploadLimiter,(req,res)=>docUpload.single('file')(req,res,async err=>{
  try{
   if(err)return res.status(400).json({error:err.code==='LIMIT_FILE_SIZE'?'File exceeds the 5 MB limit':'Upload failed'});
   if(!pm.productionReady())return res.status(503).json({error:'Public media storage is not configured. Uploads are disabled.'});
   if(!req.file||!req.file.buffer)return res.status(400).json({error:'No file provided'});
   const p=await dvMine(req.user.id);
   if(!p)return res.status(404).json({error:'Profile not found'});
   const row=await pm.store(req.file.buffer,'driver_profile',p.id,'profile_photo');
   await q(`UPDATE provider_media SET status='removed',removed_at=NOW() WHERE owner_kind='driver_profile' AND owner_id=$1 AND kind='profile_photo' AND status='active' AND id<>$2`,[p.id,row.id]);
   await q(`UPDATE driver_profiles SET profile_photo_id=$2,updated_at=NOW() WHERE id=$1`,[p.id,row.id]);
   res.status(201).json(pm.imgSafe(row,pm.PM_OWNER_BASE));
  }catch(e){
   if(e.statusCode===400)return res.status(400).json({error:e.message});
   console.error('driver photo upload error:',e.message);res.status(500).json({error:'Server error'});
  }
 }));
 app.delete('/api/me/driver-profile/profile-photo',auth,active,dvCap,async(req,res)=>{
  try{
   const p=await dvMine(req.user.id);
   if(!p)return res.status(404).json({error:'Profile not found'});
   await q(`UPDATE provider_media SET status='removed',removed_at=NOW() WHERE owner_kind='driver_profile' AND owner_id=$1 AND kind='profile_photo' AND status='active'`,[p.id]);
   await q(`UPDATE driver_profiles SET profile_photo_id=NULL,updated_at=NOW() WHERE id=$1`,[p.id]);
   res.json({ok:true});
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });

 // ── Public ─────────────────────────────────────────────────────────────────
 const DV_PUBLIC_WHERE=`p.status='active' AND u.status='active' AND (u.capabilities->>'driver')='true'`;
 const ratingSel=`(SELECT ROUND(AVG(rating)::numeric,1) FROM reviews rv WHERE rv.provider_user_id=u.id AND rv.provider_type='driver' AND rv.status='active') AS rating_avg,
  (SELECT count(*)::int FROM reviews rv WHERE rv.provider_user_id=u.id AND rv.provider_type='driver' AND rv.status='active') AS rating_count`;
 async function dvPublicView(p){
  return{id:p.id,display_name:p.display_name,hapa_verified:true,is_verified:p.is_verified===true,
   vehicle_type:p.vehicle_type,vehicle_description:p.vehicle_description,county:p.county,town:p.town,
   service_area:p.service_area,availability:p.availability,
   pricing_info:String(p.pricing_info||'').trim()||'Price agreed with driver',
   phone:p.phone_visible&&p.phone?p.phone:null,whatsapp:p.whatsapp_visible&&p.phone?p.phone:null,
   profile_photo:await dvPhoto(p.id,pm.PM_PUBLIC_BASE),rating_avg:p.rating_avg,rating_count:p.rating_count,member_since:p.created_at};
 }
 app.get('/api/public/drivers',async(req,res)=>{
  try{
   const vals=[];let where=DV_PUBLIC_WHERE;
   if(req.query.vehicle_type){vals.push(String(req.query.vehicle_type));where+=` AND p.vehicle_type ILIKE $${vals.length}`;}
   if(req.query.county){vals.push(String(req.query.county));where+=` AND p.county ILIKE $${vals.length}`;}
   if(req.query.q){vals.push('%'+String(req.query.q).slice(0,80)+'%');where+=` AND (p.display_name ILIKE $${vals.length} OR p.vehicle_type ILIKE $${vals.length} OR p.vehicle_description ILIKE $${vals.length} OR p.town ILIKE $${vals.length})`;}
   const rows=(await q(`SELECT p.*,u.phone,${isVerifiedExpr()} AS is_verified,${ratingSel} FROM driver_profiles p JOIN users u ON u.id=p.user_id WHERE ${where} ORDER BY p.published_at DESC NULLS LAST LIMIT 50`,vals)).rows;
   res.json(await Promise.all(rows.map(dvPublicView)));
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });
 app.get('/api/public/drivers/:id',async(req,res)=>{
  try{
   const p=(await q(`SELECT p.*,u.phone,${isVerifiedExpr()} AS is_verified,${ratingSel} FROM driver_profiles p JOIN users u ON u.id=p.user_id WHERE (p.id::text=$1 OR p.user_id::text=$1) AND ${DV_PUBLIC_WHERE}`,[req.params.id])).rows[0];
   if(!p)return res.status(404).json({error:'Driver not found'});
   res.json(await dvPublicView(p));
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });

 // ── Owner moderation ───────────────────────────────────────────────────────
 app.get('/api/owner/driver-profiles',auth,owner,async(req,res)=>{
  try{
   const rows=(await q(`SELECT p.*,u.name AS account_name,u.email,u.status AS user_status FROM driver_profiles p JOIN users u ON u.id=p.user_id ORDER BY p.updated_at DESC LIMIT 200`)).rows;
   res.json(rows.map(p=>({...dvSafe(p),moderation_note:p.moderation_note,account_name:p.account_name,email:p.email,user_status:p.user_status,user_id:p.user_id})));
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });
 app.get('/api/owner/driver-profiles/:id',auth,owner,async(req,res)=>{
  try{
   const p=(await q(`SELECT p.*,u.name AS account_name,u.email,u.status AS user_status FROM driver_profiles p JOIN users u ON u.id=p.user_id WHERE p.id=$1`,[req.params.id])).rows[0];
   if(!p)return res.status(404).json({error:'Profile not found'});
   res.json({...dvSafe(p),moderation_note:p.moderation_note,account_name:p.account_name,email:p.email,user_status:p.user_status,user_id:p.user_id,profile_photo:await dvPhoto(p.id,pm.PM_OWNER_BASE)});
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });
 app.patch('/api/owner/driver-profiles/:id/status',auth,owner,async(req,res)=>{
  try{
   const{status,moderation_note}=req.body||{};
   if(!['owner_hidden','active'].includes(status))return res.status(400).json({error:'status must be owner_hidden or active'});
   const p=(await q(`SELECT * FROM driver_profiles WHERE id=$1`,[req.params.id])).rows[0];
   if(!p)return res.status(404).json({error:'Profile not found'});
   if(status==='owner_hidden'&&p.status==='owner_hidden')return res.status(409).json({error:'Already hidden'});
   if(status==='active'&&p.status!=='owner_hidden')return res.status(409).json({error:'Profile is not hidden'});
   const restoreTo=['draft','active','paused'].includes(p.status_before_hidden)?p.status_before_hidden:'paused';
   const newStatus=status==='owner_hidden'?'owner_hidden':restoreTo;
   const r=(await q(`UPDATE driver_profiles SET status=$2,moderation_note=$3,updated_at=NOW(),
     status_before_hidden=CASE WHEN $2='owner_hidden' THEN $5 ELSE NULL END,
     hidden_at=CASE WHEN $2='owner_hidden' THEN NOW() ELSE NULL END,
     hidden_by=CASE WHEN $2='owner_hidden' THEN $4::uuid ELSE NULL END
     WHERE id=$1 RETURNING *`,[p.id,newStatus,moderation_note?String(moderation_note).slice(0,500):null,req.user.id,p.status])).rows[0];
   await audit(req.user.id,status==='owner_hidden'?'hide_driver_profile':'restore_driver_profile','driver_profile',p.id,moderation_note);
   res.json({...dvSafe(r),moderation_note:r.moderation_note});
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });
};
