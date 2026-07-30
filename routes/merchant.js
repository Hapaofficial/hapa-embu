// Merchant module — public business profile + items. Mirrors the Professional
// module: verified application (upgrade_applications) stays separate and
// read-only; the public profile is marketing data only; media via provider_media.
module.exports=function(app,deps){
 const{q,auth,active,owner,docUpload,pm,audit,isVerifiedExpr,uploadLimiter}=deps;

 const MC_EDITABLE=['business_name','description','county','town','service_area','opening_hours','phone_visible','whatsapp_visible'];
 const MC_LOCKED=['verified_category','businessCategory','business_category','status','user_id','role','capabilities','moderation_note','hidden_by','hidden_at'];
 const MC_MAX_GALLERY=12,MC_MAX_ITEM_IMAGES=5,MC_MAX_ITEMS=50;
 const mcCap=(req,res,next)=>(req.user.capabilities||{}).merchant===true?next():res.status(403).json({error:'Merchant capability required'});
 const mcApprovedApp=async userId=>(await q(`SELECT id,details FROM upgrade_applications WHERE user_id=$1 AND type='merchant' AND status='approved' ORDER BY created_at DESC LIMIT 1`,[userId])).rows[0]||null;
 const mcMine=async userId=>(await q(`SELECT * FROM merchant_profiles WHERE user_id=$1`,[userId])).rows[0]||null;
 const mcSafe=p=>({id:p.id,status:p.status,verified_category:p.verified_category,business_name:p.business_name,description:p.description,county:p.county,town:p.town,service_area:p.service_area,opening_hours:p.opening_hours,phone_visible:p.phone_visible,whatsapp_visible:p.whatsapp_visible,logo_image_id:p.logo_image_id,moderation_note:p.status==='owner_hidden'?p.moderation_note:null,created_at:p.created_at,updated_at:p.updated_at,published_at:p.published_at,paused_at:p.paused_at});
 async function mcMedia(profileId,base){
  const all=await pm.images('merchant_profile',profileId,base);
  return{logo:all.filter(i=>i.kind==='logo')[0]||null,gallery:all.filter(i=>i.kind==='gallery')};
 }
 async function mcPayload(p){const m=await mcMedia(p.id,pm.PM_OWNER_BASE);return{profile:mcSafe(p),logo:m.logo,gallery:m.gallery};}
 const itemSafe=i=>({id:i.id,title:i.title,description:i.description,category:i.category,price:i.price,price_unit:i.price_unit,in_stock:i.in_stock,status:i.status,created_at:i.created_at,updated_at:i.updated_at});
 async function itemPayload(i,base){return{...itemSafe(i),images:(await pm.images('merchant_item',i.id,base)).filter(x=>x.kind==='item')};}

 // ── Editor ─────────────────────────────────────────────────────────────────
 app.get('/api/me/merchant-profile',auth,active,mcCap,async(req,res)=>{
  try{const p=await mcMine(req.user.id);if(!p)return res.json({profile:null});res.json(await mcPayload(p));}
  catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });

 app.post('/api/me/merchant-profile',auth,active,mcCap,async(req,res)=>{
  try{
   if(req.user.role!=='customer')return res.status(403).json({error:'Only customer accounts can hold a merchant profile'});
   if(await mcMine(req.user.id))return res.status(409).json({error:'Profile already exists'});
   const a=await mcApprovedApp(req.user.id);
   if(!a)return res.status(403).json({error:'An approved Merchant application is required'});
   const d=a.details||{};
   const p=(await q(`INSERT INTO merchant_profiles(user_id,application_id,verified_category,business_name,county,town,service_area)
    VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [req.user.id,a.id,String(d.businessCategory||'').slice(0,80),String(d.businessName||'').slice(0,120),String(d.county||'').slice(0,80),String(d.town||'').slice(0,80),String(d.serviceArea||'').slice(0,200)])).rows[0];
   res.status(201).json(await mcPayload(p));
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });

 app.patch('/api/me/merchant-profile',auth,active,mcCap,async(req,res)=>{
  try{
   const p=await mcMine(req.user.id);
   if(!p)return res.status(404).json({error:'Profile not found'});
   const body=req.body||{};
   const lockedHit=Object.keys(body).find(k=>MC_LOCKED.includes(k));
   if(lockedHit)return res.status(400).json({error:`Field "${lockedHit}" is verified and cannot be edited here. Contact HAPA support to request a change.`});
   const sets=[],vals=[p.id];
   for(const k of MC_EDITABLE){
    if(!(k in body))continue;
    let v=body[k];
    if(k==='phone_visible'||k==='whatsapp_visible')v=v===true;
    else v=String(v==null?'':v).trim().slice(0,k==='description'?2000:200);
    vals.push(v);sets.push(`${k}=$${vals.length}`);
   }
   if(!sets.length)return res.status(400).json({error:'No editable fields provided'});
   const r=(await q(`UPDATE merchant_profiles SET ${sets.join(',')},updated_at=NOW() WHERE id=$1 RETURNING *`,vals)).rows[0];
   res.json(await mcPayload(r));
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });

 async function mcTransition(req,res,from,to){
  try{
   const p=await mcMine(req.user.id);
   if(!p)return res.status(404).json({error:'Profile not found'});
   if(p.status==='owner_hidden')return res.status(403).json({error:'This profile was hidden by HAPA moderation. Contact HAPA support.'});
   if(!from.includes(p.status))return res.status(409).json({error:`Profile is ${p.status}`});
   if(to==='active'){
    if(!(await mcApprovedApp(req.user.id)))return res.status(403).json({error:'An approved Merchant application is required to publish'});
    if(!String(p.business_name).trim()||!String(p.description).trim())return res.status(400).json({error:'Add a business name and description before publishing'});
   }
   const r=(await q(`UPDATE merchant_profiles SET status=$2,updated_at=NOW(),
     published_at=CASE WHEN $2='active' AND published_at IS NULL THEN NOW() ELSE published_at END,
     paused_at=CASE WHEN $2='paused' THEN NOW() ELSE paused_at END
     WHERE id=$1 RETURNING *`,[p.id,to])).rows[0];
   res.json(await mcPayload(r));
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 }
 app.post('/api/me/merchant-profile/publish',auth,active,mcCap,(req,res)=>mcTransition(req,res,['draft','paused'],'active'));
 app.post('/api/me/merchant-profile/pause',auth,active,mcCap,(req,res)=>mcTransition(req,res,['active'],'paused'));
 app.post('/api/me/merchant-profile/reactivate',auth,active,mcCap,(req,res)=>mcTransition(req,res,['paused'],'active'));

 // ── Media ──────────────────────────────────────────────────────────────────
 function mcUploadRoute(handler){
  return(req,res)=>docUpload.single('file')(req,res,async err=>{
   try{
    if(err)return res.status(400).json({error:err.code==='LIMIT_FILE_SIZE'?'File exceeds the 5 MB limit':'Upload failed'});
    if(!pm.productionReady())return res.status(503).json({error:'Public media storage is not configured. Uploads are disabled.'});
    if(!req.file||!req.file.buffer)return res.status(400).json({error:'No file provided'});
    const p=await mcMine(req.user.id);
    if(!p)return res.status(404).json({error:'Profile not found'});
    await handler(req,res,p);
   }catch(e){
    if(e.statusCode===400)return res.status(400).json({error:e.message});
    console.error('merchant media upload error:',e.message);res.status(500).json({error:'Server error'});
   }
  });
 }
 app.post('/api/me/merchant-profile/logo',auth,active,mcCap,uploadLimiter,mcUploadRoute(async(req,res,p)=>{
  const row=await pm.store(req.file.buffer,'merchant_profile',p.id,'logo');
  await q(`UPDATE provider_media SET status='removed',removed_at=NOW() WHERE owner_kind='merchant_profile' AND owner_id=$1 AND kind='logo' AND status='active' AND id<>$2`,[p.id,row.id]);
  await q(`UPDATE merchant_profiles SET logo_image_id=$2,updated_at=NOW() WHERE id=$1`,[p.id,row.id]);
  res.status(201).json(pm.imgSafe(row,pm.PM_OWNER_BASE));
 }));
 app.delete('/api/me/merchant-profile/logo',auth,active,mcCap,async(req,res)=>{
  try{
   const p=await mcMine(req.user.id);
   if(!p)return res.status(404).json({error:'Profile not found'});
   await q(`UPDATE provider_media SET status='removed',removed_at=NOW() WHERE owner_kind='merchant_profile' AND owner_id=$1 AND kind='logo' AND status='active'`,[p.id]);
   await q(`UPDATE merchant_profiles SET logo_image_id=NULL,updated_at=NOW() WHERE id=$1`,[p.id]);
   res.json({ok:true});
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });
 app.post('/api/me/merchant-profile/gallery',auth,active,mcCap,uploadLimiter,mcUploadRoute(async(req,res,p)=>{
  const n=+(await q(`SELECT count(*)::int n FROM provider_media WHERE owner_kind='merchant_profile' AND owner_id=$1 AND kind='gallery' AND status='active'`,[p.id])).rows[0].n;
  if(n>=MC_MAX_GALLERY)return res.status(409).json({error:`Maximum ${MC_MAX_GALLERY} gallery photos`});
  res.status(201).json(pm.imgSafe(await pm.store(req.file.buffer,'merchant_profile',p.id,'gallery'),pm.PM_OWNER_BASE));
 }));
 app.delete('/api/me/merchant-profile/gallery/:mediaId',auth,active,mcCap,async(req,res)=>{
  try{
   const p=await mcMine(req.user.id);
   if(!p)return res.status(404).json({error:'Profile not found'});
   if(!(await pm.softRemove('merchant_profile',p.id,req.params.mediaId)))return res.status(404).json({error:'Photo not found'});
   res.json({ok:true});
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });

 // ── Items ──────────────────────────────────────────────────────────────────
 function itemValidate(b,partial){
  const out={};
  if(!partial||'title'in b){const t=String(b.title||'').trim();if(t.length<3||t.length>100)return{error:'Title must be 3–100 characters'};out.title=t;}
  if('description'in b){const d=String(b.description||'').trim().slice(0,2000);out.description=d;}
  if('category'in b)out.category=String(b.category||'').trim().slice(0,80);
  if('price'in b){if(b.price===null||b.price==='')out.price=null;else{const pr=+b.price;if(!isFinite(pr)||pr<0||pr>100000000)return{error:'Invalid price'};out.price=pr;}}
  if('price_unit'in b)out.price_unit=String(b.price_unit||'').trim().slice(0,40);
  if('in_stock'in b)out.in_stock=b.in_stock===true;
  return{out};
 }
 app.get('/api/me/merchant-items',auth,active,mcCap,async(req,res)=>{
  try{
   const p=await mcMine(req.user.id);
   if(!p)return res.json({items:[]});
   const rows=(await q(`SELECT * FROM merchant_items WHERE merchant_profile_id=$1 AND status<>'archived' ORDER BY created_at DESC`,[p.id])).rows;
   res.json({items:await Promise.all(rows.map(i=>itemPayload(i,pm.PM_OWNER_BASE)))});
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });
 app.post('/api/me/merchant-items',auth,active,mcCap,async(req,res)=>{
  try{
   const p=await mcMine(req.user.id);
   if(!p)return res.status(404).json({error:'Create your business profile first'});
   const n=+(await q(`SELECT count(*)::int n FROM merchant_items WHERE merchant_profile_id=$1 AND status<>'archived'`,[p.id])).rows[0].n;
   if(n>=MC_MAX_ITEMS)return res.status(409).json({error:`Maximum ${MC_MAX_ITEMS} listings`});
   const v=itemValidate(req.body||{},false);
   if(v.error)return res.status(400).json({error:v.error});
   const o=v.out;
   const r=(await q(`INSERT INTO merchant_items(merchant_profile_id,title,description,category,price,price_unit,in_stock,status) VALUES($1,$2,$3,$4,$5,$6,$7,'active') RETURNING *`,
    [p.id,o.title,o.description||'',o.category||'',o.price==null?null:o.price,o.price_unit||'',o.in_stock!==false])).rows[0];
   res.status(201).json(await itemPayload(r,pm.PM_OWNER_BASE));
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });
 async function myItem(req){
  const p=await mcMine(req.user.id);
  if(!p)return{};
  const i=(await q(`SELECT * FROM merchant_items WHERE id::text=$1 AND merchant_profile_id=$2`,[req.params.id,p.id])).rows[0];
  return{p,i};
 }
 app.patch('/api/me/merchant-items/:id',auth,active,mcCap,async(req,res)=>{
  try{
   const{i}=await myItem(req);
   if(!i)return res.status(404).json({error:'Listing not found'});
   if(i.status==='owner_hidden')return res.status(403).json({error:'This listing was hidden by HAPA moderation. Contact HAPA support.'});
   const v=itemValidate(req.body||{},true);
   if(v.error)return res.status(400).json({error:v.error});
   const sets=[],vals=[i.id];
   for(const[k,val]of Object.entries(v.out)){vals.push(val);sets.push(`${k}=$${vals.length}`);}
   if(!sets.length)return res.status(400).json({error:'No fields provided'});
   const r=(await q(`UPDATE merchant_items SET ${sets.join(',')},updated_at=NOW() WHERE id=$1 RETURNING *`,vals)).rows[0];
   res.json(await itemPayload(r,pm.PM_OWNER_BASE));
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });
 app.patch('/api/me/merchant-items/:id/status',auth,active,mcCap,async(req,res)=>{
  try{
   const s=req.body.status;
   if(!['active','paused','archived'].includes(s))return res.status(400).json({error:'Invalid status'});
   const{i}=await myItem(req);
   if(!i)return res.status(404).json({error:'Listing not found'});
   if(i.status==='owner_hidden')return res.status(403).json({error:'This listing was hidden by HAPA moderation. Contact HAPA support.'});
   const r=(await q(`UPDATE merchant_items SET status=$2,updated_at=NOW() WHERE id=$1 RETURNING *`,[i.id,s])).rows[0];
   res.json(await itemPayload(r,pm.PM_OWNER_BASE));
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });
 app.post('/api/me/merchant-items/:id/images',auth,active,mcCap,uploadLimiter,(req,res)=>docUpload.single('file')(req,res,async err=>{
  try{
   if(err)return res.status(400).json({error:err.code==='LIMIT_FILE_SIZE'?'File exceeds the 5 MB limit':'Upload failed'});
   if(!pm.productionReady())return res.status(503).json({error:'Public media storage is not configured. Uploads are disabled.'});
   if(!req.file||!req.file.buffer)return res.status(400).json({error:'No file provided'});
   const{i}=await myItem(req);
   if(!i)return res.status(404).json({error:'Listing not found'});
   const n=(await pm.images('merchant_item',i.id,pm.PM_OWNER_BASE)).length;
   if(n>=MC_MAX_ITEM_IMAGES)return res.status(409).json({error:`Maximum ${MC_MAX_ITEM_IMAGES} photos per listing`});
   res.status(201).json(pm.imgSafe(await pm.store(req.file.buffer,'merchant_item',i.id,'item'),pm.PM_OWNER_BASE));
  }catch(e){
   if(e.statusCode===400)return res.status(400).json({error:e.message});
   console.error('item image upload error:',e.message);res.status(500).json({error:'Server error'});
  }
 }));
 app.delete('/api/me/merchant-items/:id/images/:mediaId',auth,active,mcCap,async(req,res)=>{
  try{
   const{i}=await myItem(req);
   if(!i)return res.status(404).json({error:'Listing not found'});
   if(!(await pm.softRemove('merchant_item',i.id,req.params.mediaId)))return res.status(404).json({error:'Photo not found'});
   res.json({ok:true});
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });

 // ── Public ─────────────────────────────────────────────────────────────────
 const MC_PUBLIC_WHERE=`p.status='active' AND u.status='active' AND (u.capabilities->>'merchant')='true'`;
 const ratingSel=`(SELECT ROUND(AVG(rating)::numeric,1) FROM reviews rv WHERE rv.provider_user_id=u.id AND rv.provider_type='merchant' AND rv.status='active') AS rating_avg,
  (SELECT count(*)::int FROM reviews rv WHERE rv.provider_user_id=u.id AND rv.provider_type='merchant' AND rv.status='active') AS rating_count`;
 async function mcPublicView(p,withItems){
  const m=await mcMedia(p.id,pm.PM_PUBLIC_BASE);
  const out={id:p.id,business_name:p.business_name,hapa_verified:true,is_verified:p.is_verified===true,
   verified_category:p.verified_category,description:p.description,county:p.county,town:p.town,
   service_area:p.service_area,opening_hours:p.opening_hours,
   phone:p.phone_visible&&p.phone?p.phone:null,whatsapp:p.whatsapp_visible&&p.phone?p.phone:null,
   logo:m.logo,gallery:m.gallery,rating_avg:p.rating_avg,rating_count:p.rating_count,member_since:p.created_at};
  if(withItems){
   const items=(await q(`SELECT * FROM merchant_items WHERE merchant_profile_id=$1 AND status='active' ORDER BY created_at DESC LIMIT 100`,[p.id])).rows;
   out.items=await Promise.all(items.map(i=>itemPayload(i,pm.PM_PUBLIC_BASE)));
  }
  return out;
 }
 app.get('/api/public/merchants',async(req,res)=>{
  try{
   const vals=[];let where=MC_PUBLIC_WHERE;
   if(req.query.category){vals.push(String(req.query.category));where+=` AND p.verified_category ILIKE $${vals.length}`;}
   if(req.query.county){vals.push(String(req.query.county));where+=` AND p.county ILIKE $${vals.length}`;}
   if(req.query.q){vals.push('%'+String(req.query.q).slice(0,80)+'%');where+=` AND (p.business_name ILIKE $${vals.length} OR p.description ILIKE $${vals.length} OR p.verified_category ILIKE $${vals.length} OR p.town ILIKE $${vals.length})`;}
   const rows=(await q(`SELECT p.*,u.phone,${isVerifiedExpr()} AS is_verified,${ratingSel} FROM merchant_profiles p JOIN users u ON u.id=p.user_id WHERE ${where} ORDER BY p.published_at DESC NULLS LAST LIMIT 50`,vals)).rows;
   res.json(await Promise.all(rows.map(p=>mcPublicView(p,false))));
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });
 app.get('/api/public/merchants/:id',async(req,res)=>{
  try{
   const p=(await q(`SELECT p.*,u.phone,${isVerifiedExpr()} AS is_verified,${ratingSel} FROM merchant_profiles p JOIN users u ON u.id=p.user_id WHERE (p.id::text=$1 OR p.user_id::text=$1) AND ${MC_PUBLIC_WHERE}`,[req.params.id])).rows[0];
   if(!p)return res.status(404).json({error:'Business not found'});
   res.json(await mcPublicView(p,true));
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });

 // ── Owner moderation (public profile only — never role/capability/application)
 app.get('/api/owner/merchant-profiles',auth,owner,async(req,res)=>{
  try{
   const rows=(await q(`SELECT p.*,u.name AS account_name,u.email,u.status AS user_status FROM merchant_profiles p JOIN users u ON u.id=p.user_id ORDER BY p.updated_at DESC LIMIT 200`)).rows;
   res.json(rows.map(p=>({...mcSafe(p),moderation_note:p.moderation_note,account_name:p.account_name,email:p.email,user_status:p.user_status,user_id:p.user_id})));
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });
 app.get('/api/owner/merchant-profiles/:id',auth,owner,async(req,res)=>{
  try{
   const p=(await q(`SELECT p.*,u.name AS account_name,u.email,u.status AS user_status FROM merchant_profiles p JOIN users u ON u.id=p.user_id WHERE p.id=$1`,[req.params.id])).rows[0];
   if(!p)return res.status(404).json({error:'Profile not found'});
   const m=await mcMedia(p.id,pm.PM_OWNER_BASE);
   const items=(await q(`SELECT * FROM merchant_items WHERE merchant_profile_id=$1 ORDER BY created_at DESC`,[p.id])).rows;
   res.json({...mcSafe(p),moderation_note:p.moderation_note,account_name:p.account_name,email:p.email,user_status:p.user_status,user_id:p.user_id,logo:m.logo,gallery:m.gallery,items:items.map(itemSafe)});
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });
 app.patch('/api/owner/merchant-profiles/:id/status',auth,owner,async(req,res)=>{
  try{
   const{status,moderation_note}=req.body||{};
   if(!['owner_hidden','active'].includes(status))return res.status(400).json({error:'status must be owner_hidden or active'});
   const p=(await q(`SELECT * FROM merchant_profiles WHERE id=$1`,[req.params.id])).rows[0];
   if(!p)return res.status(404).json({error:'Profile not found'});
   if(status==='owner_hidden'&&p.status==='owner_hidden')return res.status(409).json({error:'Already hidden'});
   if(status==='active'&&p.status!=='owner_hidden')return res.status(409).json({error:'Profile is not hidden'});
   const restoreTo=['draft','active','paused'].includes(p.status_before_hidden)?p.status_before_hidden:'paused';
   const newStatus=status==='owner_hidden'?'owner_hidden':restoreTo;
   const r=(await q(`UPDATE merchant_profiles SET status=$2,moderation_note=$3,updated_at=NOW(),
     status_before_hidden=CASE WHEN $2='owner_hidden' THEN $5 ELSE NULL END,
     hidden_at=CASE WHEN $2='owner_hidden' THEN NOW() ELSE NULL END,
     hidden_by=CASE WHEN $2='owner_hidden' THEN $4::uuid ELSE NULL END
     WHERE id=$1 RETURNING *`,[p.id,newStatus,moderation_note?String(moderation_note).slice(0,500):null,req.user.id,p.status])).rows[0];
   await audit(req.user.id,status==='owner_hidden'?'hide_merchant_profile':'restore_merchant_profile','merchant_profile',p.id,moderation_note);
   res.json({...mcSafe(r),moderation_note:r.moderation_note});
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });
 app.patch('/api/owner/merchant-items/:id/status',auth,owner,async(req,res)=>{
  try{
   const{status,moderation_note}=req.body||{};
   if(!['owner_hidden','active'].includes(status))return res.status(400).json({error:'status must be owner_hidden or active'});
   const i=(await q(`SELECT * FROM merchant_items WHERE id=$1`,[req.params.id])).rows[0];
   if(!i)return res.status(404).json({error:'Listing not found'});
   const r=(await q(`UPDATE merchant_items SET status=$2,updated_at=NOW() WHERE id=$1 RETURNING *`,[i.id,status])).rows[0];
   await audit(req.user.id,status==='owner_hidden'?'hide_merchant_item':'restore_merchant_item','merchant_item',i.id,moderation_note);
   res.json(itemSafe(r));
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });
};
