// Shared public media for the Merchant and Driver modules (provider_media).
// Mirrors the Professional media pattern: sanitized bytes only, PII-free
// storage keys, soft deletion, owner-gated + public-gated serving routes.
// NEVER touches private-document storage.
const crypto=require('crypto');
const pubMedia=require('./publicMediaStorage');
const {sanitizeImage}=require('./imagePipeline');

const PM_OWNER_BASE='/api/me/provider-media/';
const PM_PUBLIC_BASE='/api/public/provider-media/';

function init({q,auth,active}){
 const imgSafe=(i,base)=>({id:i.id,url:base+i.id,width:i.width,height:i.height,sort_order:i.sort_order,kind:i.kind});

 async function images(ownerKind,ownerId,base){
  const r=await q(`SELECT id,width,height,sort_order,kind FROM provider_media WHERE owner_kind=$1 AND owner_id=$2 AND status='active' ORDER BY sort_order ASC,created_at ASC`,[ownerKind,ownerId]);
  return r.rows.map(i=>imgSafe(i,base));
 }

 // Store a sanitized image; caller has already verified ownership.
 async function store(buffer,ownerKind,ownerId,kind){
  const img=await sanitizeImage(buffer);
  const id=crypto.randomUUID();
  const storageKey=`${ownerKind.replace('_profile','').replace('_item','-item')}/${ownerId}/${kind}/${id}.jpg`;
  await pubMedia.putObject(storageKey,img.buffer,img.mimeType);
  try{
   const sort=+(await q(`SELECT COALESCE(MAX(sort_order),-1)+1 n FROM provider_media WHERE owner_kind=$1 AND owner_id=$2 AND kind=$3 AND status='active'`,[ownerKind,ownerId,kind])).rows[0].n;
   return(await q(`INSERT INTO provider_media(id,owner_kind,owner_id,kind,storage_provider,storage_key,mime_type,size_bytes,width,height,sha256,sort_order)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [id,ownerKind,ownerId,kind,pubMedia.MODE,storageKey,img.mimeType,img.sizeBytes,img.width,img.height,img.sha256,sort])).rows[0];
  }catch(e){try{await pubMedia.deleteObject(storageKey);}catch(_){}throw e;}
 }

 async function softRemove(ownerKind,ownerId,mediaId){
  const r=await q(`UPDATE provider_media SET status='removed',removed_at=NOW() WHERE id=$1 AND owner_kind=$2 AND owner_id=$3 AND status='active' RETURNING id`,[mediaId,ownerKind,ownerId]);
  return r.rowCount>0;
 }

 async function stream(res,im){
  res.setHeader('X-Content-Type-Options','nosniff');
  const etag='"'+im.sha256.slice(0,32)+'"';
  res.setHeader('ETag',etag);
  if(res.req.headers['if-none-match']===etag)return res.status(304).end();
  const access=await pubMedia.getObjectAccess(im.storage_key,im.mime_type);
  if(access.kind==='signedUrl')return res.redirect(302,access.url);
  res.setHeader('Content-Type',im.mime_type);
  access.stream.on('error',()=>{if(!res.headersSent)res.status(404).json({error:'Image file missing'});});
  access.stream.pipe(res);
 }

 function registerRoutes(app){
  // Owner-of-the-media route: works for draft/paused/owner_hidden profiles.
  // Platform owner (role=owner) may also view for moderation.
  app.get('/api/me/provider-media/:id',auth,active,async(req,res)=>{
   try{
    const im=(await q(`
     SELECT m.storage_key,m.mime_type,m.sha256,
      CASE m.owner_kind
       WHEN 'merchant_profile' THEN (SELECT user_id FROM merchant_profiles WHERE id=m.owner_id)
       WHEN 'driver_profile' THEN (SELECT user_id FROM driver_profiles WHERE id=m.owner_id)
       WHEN 'merchant_item' THEN (SELECT mp.user_id FROM merchant_items mi JOIN merchant_profiles mp ON mp.id=mi.merchant_profile_id WHERE mi.id=m.owner_id)
      END AS media_owner
     FROM provider_media m WHERE m.id::text=$1 AND m.status='active'`,[req.params.id])).rows[0];
    if(!im||(im.media_owner!==req.user.id&&req.user.role!=='owner'))return res.status(404).json({error:'Image not found'});
    res.setHeader('Cache-Control','private, max-age=300');
    await stream(res,im);
   }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
  });

  // Public route: only while the owning profile/item is publicly visible.
  app.get('/api/public/provider-media/:id',async(req,res)=>{
   try{
    const im=(await q(`
     SELECT m.storage_key,m.mime_type,m.sha256 FROM provider_media m WHERE m.id::text=$1 AND m.status='active' AND (
      (m.owner_kind='merchant_profile' AND EXISTS(SELECT 1 FROM merchant_profiles p JOIN users u ON u.id=p.user_id WHERE p.id=m.owner_id AND p.status='active' AND u.status='active' AND (u.capabilities->>'merchant')='true'))
      OR (m.owner_kind='driver_profile' AND EXISTS(SELECT 1 FROM driver_profiles p JOIN users u ON u.id=p.user_id WHERE p.id=m.owner_id AND p.status='active' AND u.status='active' AND (u.capabilities->>'driver')='true'))
      OR (m.owner_kind='merchant_item' AND EXISTS(SELECT 1 FROM merchant_items mi JOIN merchant_profiles p ON p.id=mi.merchant_profile_id JOIN users u ON u.id=p.user_id WHERE mi.id=m.owner_id AND mi.status='active' AND p.status='active' AND u.status='active' AND (u.capabilities->>'merchant')='true'))
     )`,[req.params.id])).rows[0];
    if(!im)return res.status(404).json({error:'Image not found'});
    res.setHeader('Cache-Control','public, max-age=300');
    await stream(res,im);
   }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
  });
 }

 return{imgSafe,images,store,softRemove,registerRoutes,productionReady:pubMedia.productionReady,PM_OWNER_BASE,PM_PUBLIC_BASE};
}

module.exports={init,PM_OWNER_BASE,PM_PUBLIC_BASE};
