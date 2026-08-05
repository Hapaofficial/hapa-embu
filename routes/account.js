// Account settings, password change, deactivation, and public site info.
module.exports=function(app,deps){
 const{q,auth,active,bcrypt,tok,safe,email,phone,strong,writeLimiter}=deps;

 // PATCH /api/me — edit own profile (name, email, phone, location).
 // Changing email/phone resets that channel's verified flag.
 app.patch('/api/me',auth,async(req,res)=>{
  try{
   const b=req.body||{};
   const sets=[],vals=[req.user.id];
   if('name'in b){
    const n=String(b.name||'').trim();
    if(n.length<2||n.length>80)return res.status(400).json({error:'Name must be 2–80 characters'});
    vals.push(n);sets.push(`name=$${vals.length}`);
   }
   if('location'in b){vals.push(String(b.location||'').trim().slice(0,120));sets.push(`location=$${vals.length}`);}
   if('email'in b){
    const e=email(b.email);
    if(b.email&&!e)return res.status(400).json({error:'Invalid email'});
    if(e&&e!==(req.user.email||'').toLowerCase()){
     if((await q(`SELECT 1 FROM users WHERE lower(email)=lower($1) AND id<>$2`,[e,req.user.id])).rowCount)return res.status(409).json({error:'Email already used'});
     vals.push(e);sets.push(`email=$${vals.length}`);sets.push('email_verified=false');
    }
   }
   if('phone'in b){
    const p=phone(b.phone);
    if(b.phone&&!p)return res.status(400).json({error:'Invalid phone number'});
    if(!p&&!(('email'in b&&email(b.email))||req.user.email))return res.status(400).json({error:'Keep at least a phone or an email on your account'});
    if(p&&p!==req.user.phone){
     if(!/^\+254\d{9}$/.test(p))return res.status(400).json({error:'Use a Kenyan number, e.g. 07XX XXX XXX or +2547XX XXX XXX'});
     if((await q(`SELECT 1 FROM users WHERE phone=$1 AND id<>$2`,[p,req.user.id])).rowCount)return res.status(409).json({error:'Phone already used'});
     vals.push(p);sets.push(`phone=$${vals.length}`);sets.push('phone_verified=false');
    }else if(!p&&req.user.phone){vals.push(null);sets.push(`phone=$${vals.length}`);sets.push('phone_verified=false');}
   }
   if(!sets.length)return res.status(400).json({error:'Nothing to update'});
   const r=(await q(`UPDATE users SET ${sets.join(',')} WHERE id=$1 RETURNING *`,vals)).rows[0];
   res.json(safe(r));
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });

 // POST /api/me/password — change password while logged in.
 app.post('/api/me/password',auth,writeLimiter,async(req,res)=>{
  try{
   const cur=String(req.body.currentPassword||''),nw=String(req.body.newPassword||'');
   if(!await bcrypt.compare(cur,req.user.password_hash))return res.status(403).json({error:'Current password is wrong'});
   if(!strong(nw))return res.status(400).json({error:'New password must be at least 10 characters with letters and numbers'});
   const h=await bcrypt.hash(nw,12);
   const r=(await q(`UPDATE users SET password_hash=$2,token_version=token_version+1 WHERE id=$1 RETURNING *`,[req.user.id,h])).rows[0];
   res.json({ok:true,token:tok(r)}); // fresh token — old sessions are invalidated
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });

 // POST /api/me/deactivate — self-service deactivation (password confirmed).
 // Public profiles disappear from discovery immediately (all public queries
 // require users.status='active'). The Owner can reactivate on request.
 app.post('/api/me/deactivate',auth,async(req,res)=>{
  try{
   if(req.user.role==='owner')return res.status(403).json({error:'The owner account cannot be deactivated here'});
   if(!await bcrypt.compare(String(req.body.password||''),req.user.password_hash))return res.status(403).json({error:'Password is wrong'});
   await q(`UPDATE users SET status='deactivated',deactivated_at=NOW(),token_version=token_version+1 WHERE id=$1`,[req.user.id]);
   res.json({ok:true});
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });

 // POST /api/me/delete — permanent self-service account deletion.
 // Confirmed with the password. The row becomes an anonymized tombstone:
 // name/contact details are wiped, content disappears from public discovery
 // (all public queries require users.status='active'), device tokens are
 // removed, and every session is invalidated. Owner audit records, moderation
 // history and request records are retained (legal/safety requirement) but no
 // longer reference personal details. Deletion cannot be undone.
 app.post('/api/me/delete',auth,writeLimiter,async(req,res)=>{
  try{
   if(req.user.role==='owner')return res.status(403).json({error:'The owner account cannot be deleted here'});
   if(!await bcrypt.compare(String(req.body.password||''),req.user.password_hash))return res.status(403).json({error:'Password is wrong'});
   if(String(req.body.confirm||'')!=='DELETE')return res.status(400).json({error:'Type DELETE to confirm'});
   const tomb='deleted-'+req.user.id+'@deleted.hapa.invalid';
   await q(`UPDATE users SET status='deleted',deleted_at=NOW(),deactivated_at=COALESCE(deactivated_at,NOW()),
     name='Deleted user',email=$2,phone=NULL,location='',email_verified=false,phone_verified=false,
     profile_photo_url=NULL,token_version=token_version+1 WHERE id=$1`,[req.user.id,tomb]);
   await q(`DELETE FROM device_tokens WHERE user_id=$1`,[req.user.id]);
   res.json({ok:true,message:'Your account was deleted. Your listings and profiles are no longer public.'});
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });

 // ── Push notification device tokens (native apps). Storage + lifecycle only —
 // no delivery pipeline is claimed until FCM/APNs credentials are configured. ──
 app.post('/api/me/device-tokens',auth,writeLimiter,async(req,res)=>{
  try{
   const platform=String(req.body.platform||'');
   const token=String(req.body.token||'').trim();
   if(!['android','ios','web'].includes(platform))return res.status(400).json({error:'Invalid platform'});
   if(token.length<10||token.length>4096)return res.status(400).json({error:'Invalid token'});
   await q(`INSERT INTO device_tokens(user_id,platform,token) VALUES($1,$2,$3)
     ON CONFLICT(token) DO UPDATE SET user_id=$1,platform=$2,last_seen_at=NOW()`,[req.user.id,platform,token]);
   res.json({ok:true});
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });
 app.delete('/api/me/device-tokens',auth,async(req,res)=>{
  try{
   const token=String(req.body.token||'').trim();
   if(token)await q(`DELETE FROM device_tokens WHERE user_id=$1 AND token=$2`,[req.user.id,token]);
   else await q(`DELETE FROM device_tokens WHERE user_id=$1`,[req.user.id]);
   res.json({ok:true});
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });
 // Notification preferences (merged shallowly; boolean values only)
 app.patch('/api/me/notification-prefs',auth,async(req,res)=>{
  try{
   const allowed=['requests','moderation','support'];
   const cur=req.user.notify_prefs||{};
   for(const k of allowed)if(k in (req.body||{}))cur[k]=req.body[k]===true;
   const r=(await q(`UPDATE users SET notify_prefs=$2 WHERE id=$1 RETURNING notify_prefs`,[req.user.id,JSON.stringify(cur)])).rows[0];
   res.json({ok:true,notify_prefs:r.notify_prefs});
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });

 // Public runtime configuration for the frontend. The Google Maps web key is
 // referrer-restricted and public-by-design; absent = maps UI falls back to
 // manual location entry. Single source of truth: lib/maps.publicWebKey()
 // (prefers GOOGLE_MAPS_WEB_KEY, legacy fallback GOOGLE_MAPS_BROWSER_KEY,
 // else null). The server routing key is never exposed here or anywhere.
 app.get('/api/public/config',(req,res)=>{
  res.json({mapsBrowserKey:require('../lib/maps').publicWebKey()});
 });

 // ── Deep-link association files. Served only when the deployment provides
 // real values — nothing is invented. See docs/mobile/DEEPLINKS.md. ──
 app.get('/.well-known/assetlinks.json',(req,res)=>{
  const pkg=process.env.ANDROID_PACKAGE_NAME,sha=process.env.ANDROID_CERT_SHA256;
  if(!pkg||!sha)return res.status(404).json({error:'Android app links not configured'});
  res.json([{relation:['delegate_permission/common.handle_all_urls'],target:{namespace:'android_app',package_name:pkg,sha256_cert_fingerprints:[sha]}}]);
 });
 app.get('/.well-known/apple-app-site-association',(req,res)=>{
  const appId=process.env.IOS_APP_ID; // TEAMID.bundle.id
  if(!appId)return res.status(404).json({error:'iOS universal links not configured'});
  res.type('application/json').json({applinks:{apps:[],details:[{appID:appId,paths:['/p/*','/m/*','/d/*','/l/*']}]}});
 });

 // Public site/support info — centralized deployment configuration, no
 // scattered placeholders. Values are env-provided; absent values are null and
 // the UI says contact details are coming soon.
 app.get('/api/public/site-info',(req,res)=>{
  res.json({
   name:'HAPA',
   tagline:'Embu-first marketplace for trusted local services',
   supportEmail:process.env.SUPPORT_EMAIL||null,
   supportPhone:process.env.SUPPORT_PHONE||null,
   legalEntity:process.env.LEGAL_ENTITY_NAME||null,
   legalAddress:process.env.LEGAL_ADDRESS||null
  });
 });
};
