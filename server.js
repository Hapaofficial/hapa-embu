const express=require('express'),path=require('path'),fs=require('fs'),bcrypt=require('bcryptjs'),jwt=require('jsonwebtoken'),crypto=require('crypto');
const {Pool}=require('pg');
const rateLimit=require('express-rate-limit');
const multer=require('multer');
const docStorage=require('./lib/documentStorage');
const fieldCrypto=require('./lib/fieldCrypto');
const {sanitizeImage,MAX_INPUT_BYTES}=require('./lib/imagePipeline');
const app=express(),PORT=+process.env.PORT||10000;
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.NODE_ENV==='production'?{rejectUnauthorized:false}:false});
const q=(t,p=[])=>pool.query(t,p), secret=process.env.JWT_SECRET||'CHANGE_ME', authMode=process.env.AUTH_MODE||'demo';

// ── Production safety gate ────────────────────────────────────────────────────
if(process.env.NODE_ENV==='production'){
 if(!process.env.JWT_SECRET||process.env.JWT_SECRET==='CHANGE_ME'){
  console.error('FATAL: JWT_SECRET must be set to a strong secret in production. Exiting.');
  process.exit(1);
 }
 if(!docStorage.productionReady())console.error('WARNING: secure document storage is not configured (DOCUMENT_STORAGE_MODE=s3 + credentials required). Document uploads will be refused.');
 if(!fieldCrypto.available())console.error('WARNING: DOCUMENT_ENCRYPTION_KEY is not set. Sensitive-field writes will be refused.');
}

app.set('trust proxy',1);
app.use(express.json({limit:'10mb'}));
// Defense in depth: private-storage-like paths must 404 before static/SPA.
// (Bytes were never served — this replaces the SPA-HTML fallthrough with an
// explicit generic 404, covering encoded/normalized traversal attempts.)
const PRIVATE_PATH_RE=/(^|\/)(var\/private-documents|\.data\/private-upgrade-documents|private-upgrade-documents)(\/|$)/i;
app.use((req,res,next)=>{
 let p=req.path;
 try{p=decodeURIComponent(p);}catch(_){return res.status(404).json({error:'Not found'});}
 if(PRIVATE_PATH_RE.test(path.posix.normalize(p)))return res.status(404).json({error:'Not found'});
 next();
});
// ── Security headers (CSP allows the inline-script SPA; no external origins
// except https images/signed-URL fetches) ─────────────────────────────────────
app.use((req,res,next)=>{
 res.setHeader('X-Content-Type-Options','nosniff');
 res.setHeader('X-Frame-Options','DENY');
 res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
 res.setHeader('Permissions-Policy','geolocation=(), microphone=(), payment=()');
 res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline' https://maps.googleapis.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob: https:; connect-src 'self' https:; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'");
 if(process.env.NODE_ENV==='production')res.setHeader('Strict-Transport-Security','max-age=31536000; includeSubDomains');
 next();
});
app.use(express.static(path.join(__dirname,'public')));
// Externally accessible account-deletion instructions (store-listing requirement)
app.get('/delete-account',(req,res)=>res.sendFile(path.join(__dirname,'public','delete-account.html')));

// ── Rate limiters ─────────────────────────────────────────────────────────────
// Demo/dev mode relaxes limits so automated test suites can run; production
// (AUTH_MODE unset or not 'demo') keeps strict limits.
const RL=n=>authMode==='demo'?1000:n;
const authLimiter=rateLimit({windowMs:15*60*1000,max:RL(10),standardHeaders:true,legacyHeaders:false,message:{error:'Too many attempts. Please try again in 15 minutes.'}});
const otpLimiter=rateLimit({windowMs:10*60*1000,max:RL(3),standardHeaders:true,legacyHeaders:false,message:{error:'Too many code requests. Please try again in 10 minutes.'}});
const uploadLimiter=rateLimit({windowMs:15*60*1000,max:RL(40),standardHeaders:true,legacyHeaders:false,message:{error:'Too many uploads. Please try again shortly.'}});
const writeLimiter=rateLimit({windowMs:15*60*1000,max:RL(30),standardHeaders:true,legacyHeaders:false,message:{error:'Too many requests. Please slow down and try again shortly.'}});

// ── Helpers ───────────────────────────────────────────────────────────────────
const email=v=>String(v||'').trim().toLowerCase()||null;
const phone=v=>{let s=String(v||'').replace(/[^\d+]/g,'');if(!s)return null;if(s.startsWith('0'))s='+254'+s.slice(1);if(s.startsWith('254'))s='+'+s;return s};
const strong=p=>String(p||'').length>=10&&/[A-Za-z]/.test(p)&&/\d/.test(p);
const safe=u=>({id:u.id,name:u.name,email:u.email,phone:u.phone,role:u.role,status:u.status,wallet:+u.wallet_balance||0,
 profilePhotoUrl:u.profile_photo_url,emailVerified:u.email_verified,phoneVerified:u.phone_verified,capabilities:u.capabilities||{}});
const tok=u=>jwt.sign({sub:u.id,tv:+u.token_version||0},secret,{expiresIn:'7d',issuer:'hapa'});

// is_verified: active + at least one verified channel + has profile photo
const isVerifiedExpr=(t='u')=>
 `(${t}.status='active' AND (${t}.email_verified=true OR ${t}.phone_verified=true) AND ${t}.profile_photo_url IS NOT NULL AND ${t}.profile_photo_url<>'')`;

async function auth(req,res,next){try{let h=req.headers.authorization||'';let d=jwt.verify(h.slice(7),secret,{issuer:'hapa'});let r=await q('SELECT * FROM users WHERE id=$1',[d.sub]);if(!r.rowCount||['blocked','deactivated','deleted'].includes(r.rows[0].status))throw 0;if((+r.rows[0].token_version||0)!==(+d.tv||0))throw 0;req.user=r.rows[0];next()}catch{res.status(401).json({error:'Login required'})}}
const owner=(req,res,next)=>req.user.role==='owner'?next():res.status(403).json({error:'Owner only'});
const active=(req,res,next)=>(req.user.role==='owner'||req.user.status==='active')?next():res.status(403).json({error:'Account not active'});
async function code(userId,channel,purpose){let c=String(Math.floor(100000+Math.random()*900000));await q(`INSERT INTO verification_codes(user_id,channel,purpose,code,expires_at) VALUES($1,$2,$3,$4,NOW()+interval '10 min')`,[userId,channel,purpose,c]);return c}

async function boot(){
 await q(fs.readFileSync(path.join(__dirname,'sql/schema.sql'),'utf8'));
 const fixedOwnerEmail='trader2027@protonmail.com';
 const ownerPassword=String(process.env.OWNER_PASSWORD||'');
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const demoted=await client.query(`UPDATE users SET role='customer' WHERE role='owner' AND lower(coalesce(email,''))<>lower($1) RETURNING id,email,phone`,[fixedOwnerEmail]);
  let ownerRow=await client.query(`SELECT * FROM users WHERE lower(coalesce(email,''))=lower($1) LIMIT 1`,[fixedOwnerEmail]);
  if(!ownerRow.rowCount){
   if(!strong(ownerPassword))throw new Error('OWNER_PASSWORD is missing or too weak');
   const hash=await bcrypt.hash(ownerPassword,12);
   ownerRow=await client.query(`INSERT INTO users(name,email,role,status,password_hash,email_verified,phone_verified) VALUES($1,$2,'owner','active',$3,true,true) RETURNING *`,[process.env.OWNER_NAME||'HAPA Owner',fixedOwnerEmail,hash]);
  }else{
   ownerRow=await client.query(`UPDATE users SET role='owner',status='active',email_verified=true,phone_verified=true WHERE id=$1 RETURNING *`,[ownerRow.rows[0].id]);
  }
  const moreen=await client.query(`UPDATE users SET role='customer',status=CASE WHEN status='blocked' THEN 'blocked' ELSE 'active' END,name=CASE WHEN name='HAPA Owner' THEN 'Moreen' ELSE name END WHERE lower(coalesce(email,''))=lower($1) RETURNING id,name,email,phone,role,status`,['moreentrader@gmail.com']);
  const count=await client.query(`SELECT count(*)::int AS n FROM users WHERE role='owner'`);
  if(count.rows[0].n!==1)throw new Error(`Owner enforcement failed: expected 1 owner, found ${count.rows[0].n}`);
  await client.query('COMMIT');
  console.log(JSON.stringify({event:'owner-role-enforced',fixedOwner:fixedOwnerEmail,ownerCount:count.rows[0].n,demoted:demoted.rowCount,moreenMatched:moreen.rowCount}));
 }catch(err){await client.query('ROLLBACK');throw err;}
 finally{client.release();}
}

// Owner action audit trail (best-effort; never blocks the action)
async function audit(actorId,action,targetType,targetId,note){
 try{await q(`INSERT INTO owner_audit_log(actor_id,action,target_type,target_id,note) VALUES($1,$2,$3,$4,$5)`,
  [actorId,String(action).slice(0,80),String(targetType||'').slice(0,40),String(targetId||'').slice(0,64),String(note||'').slice(0,500)]);}catch(e){console.error('audit failed',e.message);}
}

// ── Core ──────────────────────────────────────────────────────────────────────
app.get('/api/health',async(req,res)=>{await q('SELECT 1');res.json({ok:true,version:'1.7.0'})});

// ── Auth ──────────────────────────────────────────────────────────────────────
app.post('/api/auth/register',authLimiter,async(req,res)=>{
 try{
  let n=String(req.body.name||'').trim(),e=email(req.body.email),p=phone(req.body.phone),pw=String(req.body.password||''),selfie=String(req.body.selfie||'');
  if(!n||(!e&&!p)||!strong(pw)||!selfie)return res.status(400).json({error:'Name, phone or email, password (min 10 chars with letters and numbers) and selfie required'});
  if(e&&(await q('SELECT 1 FROM users WHERE lower(email)=lower($1)',[e])).rowCount)return res.status(409).json({error:'Email already used'});
  if(p&&(await q('SELECT 1 FROM users WHERE phone=$1',[p])).rowCount)return res.status(409).json({error:'Phone already used'});
  let h=await bcrypt.hash(pw,12),r=await q(`INSERT INTO users(name,email,phone,role,status,password_hash,profile_photo_url) VALUES($1,$2,$3,'customer','pending',$4,$5) RETURNING *`,[n,e,p,h,selfie]),u=r.rows[0];
  await q(`INSERT INTO access_requests(user_id) VALUES($1)`,[u.id]);let ch=p?'phone':'email',c=await code(u.id,ch,'verify');
  res.status(201).json({token:tok(u),user:safe(u),channel:ch,demoCode:authMode==='demo'?c:undefined});
 }catch(e){console.error(e);res.status(500).json({error:'Registration failed'})}
});

app.post('/api/auth/login',authLimiter,async(req,res)=>{
 let id=String(req.body.identifier||'').trim(),e=email(id),p=phone(id),r=await q(`SELECT * FROM users WHERE lower(coalesce(email,''))=lower($1) OR phone=$2 LIMIT 1`,[e||'',p||'']),u=r.rows[0];
 if(!u||!await bcrypt.compare(String(req.body.password||''),u.password_hash))return res.status(401).json({error:'Wrong login or password'});
 if(u.status==='blocked')return res.status(403).json({error:'Account blocked'});
 if(u.status==='deactivated')return res.status(403).json({error:'This account was deactivated. Contact HAPA support to restore it.'});
 if(u.status==='deleted')return res.status(403).json({error:'This account was deleted.'});
 res.json({token:tok(u),user:safe(u)});
});

app.post('/api/auth/verify',auth,otpLimiter,async(req,res)=>{
 let r=await q(`SELECT * FROM verification_codes WHERE user_id=$1 AND purpose='verify' AND used_at IS NULL AND expires_at>NOW() ORDER BY expires_at DESC LIMIT 1`,[req.user.id]);
 if(!r.rowCount||r.rows[0].code!==String(req.body.code||''))return res.status(400).json({error:'Invalid or expired code'});
 await q('UPDATE verification_codes SET used_at=NOW() WHERE id=$1',[r.rows[0].id]);
 await q(`UPDATE users SET ${r.rows[0].channel==='phone'?'phone_verified':'email_verified'}=true WHERE id=$1`,[req.user.id]);
 res.json({ok:true});
});

app.post('/api/auth/resend',auth,otpLimiter,async(req,res)=>{
 try{
  const u=req.user;
  const ch=u.phone?'phone':'email';
  const c=await code(u.id,ch,'verify');
  res.json({ok:true,channel:ch,demoCode:authMode==='demo'?c:undefined});
 }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
});

app.post('/api/auth/forgot',otpLimiter,async(req,res)=>{
 let id=String(req.body.identifier||''),e=email(id),p=phone(id),r=await q(`SELECT * FROM users WHERE lower(coalesce(email,''))=lower($1) OR phone=$2 LIMIT 1`,[e||'',p||'']);
 if(!r.rowCount)return res.json({ok:true});
 let ch=p&&r.rows[0].phone===p?'phone':'email',c=await code(r.rows[0].id,ch,'reset');
 res.json({ok:true,demoCode:authMode==='demo'?c:undefined});
});

app.post('/api/auth/reset',otpLimiter,async(req,res)=>{
 let id=String(req.body.identifier||''),e=email(id),p=phone(id),u=(await q(`SELECT * FROM users WHERE lower(coalesce(email,''))=lower($1) OR phone=$2 LIMIT 1`,[e||'',p||''])).rows[0];
 if(!u||!strong(req.body.newPassword))return res.status(400).json({error:'Invalid request or password too weak'});
 let c=(await q(`SELECT * FROM verification_codes WHERE user_id=$1 AND purpose='reset' AND used_at IS NULL AND expires_at>NOW() ORDER BY expires_at DESC LIMIT 1`,[u.id])).rows[0];
 if(!c||c.code!==String(req.body.code||''))return res.status(400).json({error:'Invalid or expired code'});
 let h=await bcrypt.hash(req.body.newPassword,12);
 await q('UPDATE users SET password_hash=$2,token_version=token_version+1 WHERE id=$1',[u.id,h]);
 await q('UPDATE verification_codes SET used_at=NOW() WHERE id=$1',[c.id]);
 res.json({ok:true});
});

// ── Me ────────────────────────────────────────────────────────────────────────
app.get('/api/me',auth,(req,res)=>res.json(safe(req.user)));
app.post('/api/me/request-again',auth,async(req,res)=>{
 if((await q(`SELECT 1 FROM access_requests WHERE user_id=$1 AND status='pending'`,[req.user.id])).rowCount)return res.status(409).json({error:'Already pending'});
 await q(`INSERT INTO access_requests(user_id) VALUES($1)`,[req.user.id]);
 await q(`UPDATE users SET status='pending' WHERE id=$1`,[req.user.id]);
 res.json({ok:true});
});

// My listings (all statuses, auth only)
app.get('/api/me/listings',auth,async(req,res)=>{
 try{
  const lim=Math.min(+(req.query.limit)||50,100),off=(Math.max(+(req.query.page)||1,1)-1)*lim;
  const tot=+(await q(`SELECT count(*)::int n FROM marketplace_listings WHERE seller_id=$1`,[req.user.id])).rows[0].n;
  const rows=(await q(`SELECT id,title,price,category,condition,location,status,created_at,updated_at,views_count,negotiable,seller_phone_visible,images->0 AS main_image,jsonb_array_length(images)::int AS image_count FROM marketplace_listings WHERE seller_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,[req.user.id,lim,off])).rows;
  res.json({data:rows,total:tot,page:+(req.query.page)||1,limit:lim,pages:Math.ceil(tot/lim)});
 }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
});

// My favorites
app.get('/api/me/favorites',auth,active,async(req,res)=>{
 try{
  const lim=Math.min(+(req.query.limit)||20,100),off=(Math.max(+(req.query.page)||1,1)-1)*lim;
  const tot=+(await q(`SELECT count(*)::int n FROM listing_favorites lf JOIN marketplace_listings ml ON ml.id=lf.listing_id WHERE lf.user_id=$1 AND ml.status='active'`,[req.user.id])).rows[0].n;
  const rows=(await q(`SELECT ml.id,ml.title,ml.price,ml.category,ml.condition,ml.location,ml.status,ml.created_at,ml.views_count,ml.negotiable,ml.images->0 AS main_image,jsonb_array_length(ml.images)::int AS image_count,u.name AS seller_name,u.id AS seller_id,u.profile_photo_url AS seller_photo,lf.created_at AS favorited_at,${isVerifiedExpr()} AS is_verified FROM listing_favorites lf JOIN marketplace_listings ml ON ml.id=lf.listing_id JOIN users u ON u.id=ml.seller_id WHERE lf.user_id=$1 AND ml.status='active' ORDER BY lf.created_at DESC LIMIT $2 OFFSET $3`,[req.user.id,lim,off])).rows;
  res.json({data:rows,total:tot,page:+(req.query.page)||1,limit:lim,pages:Math.ceil(tot/lim)});
 }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
});

// ── Upgrade System (Sprint 2) ─────────────────────────────────────────────────
const UG_TYPES=['driver','merchant','professional'];
const UG_STATUSES=['draft','pending','corrections_requested','approved','rejected','suspended'];
const UG_REQUIRED={driver:['fullName','drivingLicenceNumber','vehicleType','registrationNumber','county'],merchant:['businessName','ownerName','businessCategory','county'],professional:['fullName','professionCategory','skills','county']};
// Sprint 2B: base64 document contents are no longer accepted in details.
// Documents go through the secure multipart pipeline only.
function ugCheckDocs(det,depth=0){
 if(depth>4)return'Details are nested too deeply.';
 for(const[k,v]of Object.entries(det||{})){
  if(typeof v==='string'&&v.startsWith('data:'))return`Embedded file contents are no longer accepted ("${k}"). Upload documents through the secure document uploader.`;
  else if(Array.isArray(v)){
   for(const f of v){
    if(typeof f==='string'&&f.startsWith('data:'))return`Embedded file contents are no longer accepted ("${k}").`;
    if(f&&typeof f==='object'){const err=ugCheckDocs(f,depth+1);if(err)return err;}
   }
  }
  else if(v&&typeof v==='object'){const err=ugCheckDocs(v,depth+1);if(err)return err;}
 }
 return null;
}
// Sensitive text fields: stored AES-256-GCM encrypted in sensitive_details,
// never in the plain details JSONB, never returned by list endpoints.
const UG_SENSITIVE=['nationalId','drivingLicenceNumber','psvLicenceNumber','insurancePolicyNumber','businessRegNumber','kraPin'];
function ugSplitSensitive(det){
 const plain={},sensitive={};
 for(const[k,v]of Object.entries(det||{})){
  if(UG_SENSITIVE.includes(k))sensitive[k]=v;else plain[k]=v;
 }
 return{plain,sensitive};
}
function ugRequireCryptoOrFail(res){
 if(fieldCrypto.available())return true;
 res.status(503).json({error:'Secure storage for sensitive details is not configured. Please try again later.'});
 return false;
}
// Consent version for document processing
const UG_CONSENT_VERSION='v1-2026-07';
// Allowed document types + max active documents per type
const UG_DOC_TYPES={
 driver:{profilePhoto:1,nationalIdFront:1,nationalIdBack:1,licenceFront:1,licenceBack:1,vehicleRegDoc:1,vehiclePhoto:1,insuranceDoc:1,psvDoc:1},
 merchant:{ownerPhoto:1,nationalId:1,businessRegDoc:1,kraDoc:1,storefrontPhoto:1},
 professional:{profilePhoto:1,nationalId:1,certificates:3,portfolioPhotos:3}
};
const UG_EDITABLE_STATUSES=['draft','corrections_requested','rejected'];
const docUpload=multer({storage:multer.memoryStorage(),limits:{fileSize:MAX_INPUT_BYTES,files:1}});
async function docLog(documentId,actorId,action,req){
 try{await q(`INSERT INTO document_access_log(document_id,actor_id,action,ip_address,user_agent) VALUES($1,$2,$3,$4,$5)`,
  [documentId,actorId,action,String(req.ip||'').slice(0,64),String(req.headers['user-agent']||'').slice(0,300)]);}catch(e){console.error('doc-log failed',e.message);}
}
// Decrypt sensitive fields for authorized detail views only
function ugMergeSensitive(row){
 const out={...row};delete out.sensitive_details;
 try{if(row.sensitive_details)out.details={...(row.details||{}),...fieldCrypto.decryptFields(row.sensitive_details)};}
 catch(e){console.error('sensitive decrypt failed for application',row.id);}
 return out;
}
// Allowed moderation transitions: from-status → allowed actions
const UG_TRANSITIONS={pending:['approved','rejected','corrections_requested'],corrections_requested:['approved','rejected'],approved:['suspended'],suspended:['restored','rejected'],draft:[],rejected:[]};

// GET /api/me/upgrades — latest per type, no documents
app.get('/api/me/upgrades',auth,active,async(req,res)=>{
 try{
  const r=await q(`SELECT id,type,status,review_note,submitted_at,reviewed_at,updated_at,created_at FROM upgrade_applications WHERE user_id=$1 ORDER BY created_at DESC`,[req.user.id]);
  const map={};r.rows.forEach(a=>{if(!map[a.type])map[a.type]=a;});
  res.json(map);
 }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
});

// GET /api/me/upgrades/:type — full application including documents
app.get('/api/me/upgrades/:type',auth,active,async(req,res)=>{
 try{
  const t=req.params.type;
  if(!UG_TYPES.includes(t))return res.status(400).json({error:'Invalid type'});
  const r=await q(`SELECT * FROM upgrade_applications WHERE user_id=$1 AND type=$2 ORDER BY created_at DESC LIMIT 1`,[req.user.id,t]);
  if(!r.rowCount)return res.status(404).json({error:'No application found'});
  res.json(ugMergeSensitive(r.rows[0]));
 }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
});

// POST /api/me/upgrades/:type — save draft
app.post('/api/me/upgrades/:type',auth,active,async(req,res)=>{
 try{
  const t=req.params.type;
  if(!UG_TYPES.includes(t))return res.status(400).json({error:'Invalid type'});
  const det=req.body.details||{};
  const docErr=ugCheckDocs(det);if(docErr)return res.status(400).json({error:docErr});
  const{plain,sensitive}=ugSplitSensitive(det);
  const hasSensitive=Object.keys(sensitive).some(k=>sensitive[k]!==undefined&&String(sensitive[k]??'').trim()!=='');
  if(hasSensitive&&!ugRequireCryptoOrFail(res))return;
  const env=hasSensitive?fieldCrypto.encryptFields(sensitive):null;
  const ex=await q(`SELECT id,status FROM upgrade_applications WHERE user_id=$1 AND type=$2 AND status NOT IN('rejected') ORDER BY created_at DESC LIMIT 1`,[req.user.id,t]);
  if(ex.rowCount){
   if(!['draft','corrections_requested'].includes(ex.rows[0].status))return res.status(409).json({error:'Application is already '+ex.rows[0].status});
   const r=await q(`UPDATE upgrade_applications SET details=$2,sensitive_details=$3,updated_at=NOW() WHERE id=$1 RETURNING id,type,status,submitted_at,review_note,updated_at,created_at`,[ex.rows[0].id,plain,env]);
   return res.json(r.rows[0]);
  }
  const r=await q(`INSERT INTO upgrade_applications(user_id,type,status,details,sensitive_details) VALUES($1,$2,'draft',$3,$4) RETURNING id,type,status,submitted_at,review_note,updated_at,created_at`,[req.user.id,t,plain,env]);
  res.status(201).json(r.rows[0]);
 }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
});

// POST /api/me/upgrades/:type/submit — submit for review
app.post('/api/me/upgrades/:type/submit',auth,active,async(req,res)=>{
 try{
  const t=req.params.type;
  if(!UG_TYPES.includes(t))return res.status(400).json({error:'Invalid type'});
  const det=req.body.details||{};
  const miss=UG_REQUIRED[t].filter(k=>!det[k]||String(det[k]).trim()==='');
  if(miss.length)return res.status(400).json({error:'Required fields missing: '+miss.join(', ')});
  const docErr=ugCheckDocs(det);if(docErr)return res.status(400).json({error:docErr});
  if(req.body.consent!==true)return res.status(400).json({error:'You must consent to secure processing of your documents before submitting.'});
  const{plain,sensitive}=ugSplitSensitive(det);
  const hasSensitive=Object.keys(sensitive).some(k=>String(sensitive[k]??'').trim()!=='');
  if(hasSensitive&&!ugRequireCryptoOrFail(res))return;
  const env=hasSensitive?fieldCrypto.encryptFields(sensitive):null;
  const ex=await q(`SELECT id,status FROM upgrade_applications WHERE user_id=$1 AND type=$2 ORDER BY created_at DESC LIMIT 1`,[req.user.id,t]);
  let r;
  if(ex.rowCount&&['draft','corrections_requested'].includes(ex.rows[0].status)){
   r=await q(`UPDATE upgrade_applications SET status='pending',details=$2,sensitive_details=$3,submitted_at=NOW(),updated_at=NOW(),review_note=NULL,consent_at=NOW(),consent_version=$4 WHERE id=$1 RETURNING id,type,status,submitted_at`,[ex.rows[0].id,plain,env,UG_CONSENT_VERSION]);
  }else if(ex.rowCount&&ex.rows[0].status==='pending'){
   return res.status(409).json({error:'An application is already under review'});
  }else if(ex.rowCount&&ex.rows[0].status==='approved'){
   return res.status(409).json({error:'This role is already approved'});
  }else{
   r=await q(`INSERT INTO upgrade_applications(user_id,type,status,details,sensitive_details,submitted_at,consent_at,consent_version) VALUES($1,$2,'pending',$3,$4,NOW(),NOW(),$5) RETURNING id,type,status,submitted_at`,[req.user.id,t,plain,env,UG_CONSENT_VERSION]);
  }
  res.json(r.rows[0]);
 }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
});

// PATCH /api/me/upgrades/:type — partial update of draft or corrections_requested
app.patch('/api/me/upgrades/:type',auth,active,async(req,res)=>{
 try{
  const t=req.params.type;
  if(!UG_TYPES.includes(t))return res.status(400).json({error:'Invalid type'});
  const det=req.body.details||{};
  const docErr=ugCheckDocs(det);if(docErr)return res.status(400).json({error:docErr});
  const{plain,sensitive}=ugSplitSensitive(det);
  const hasSensitive=Object.keys(sensitive).length>0;
  if(hasSensitive&&!ugRequireCryptoOrFail(res))return;
  const ex=await q(`SELECT id,status,details,sensitive_details FROM upgrade_applications WHERE user_id=$1 AND type=$2 AND status IN('draft','corrections_requested') ORDER BY created_at DESC LIMIT 1`,[req.user.id,t]);
  if(!ex.rowCount)return res.status(404).json({error:'No editable application found'});
  const merged={...(ex.rows[0].details||{}),...plain};
  let env=ex.rows[0].sensitive_details;
  if(hasSensitive){
   let prev={};try{prev=ex.rows[0].sensitive_details?fieldCrypto.decryptFields(ex.rows[0].sensitive_details):{};}catch(e){}
   env=fieldCrypto.encryptFields({...prev,...sensitive});
  }
  const r=await q(`UPDATE upgrade_applications SET details=$2,sensitive_details=$3,updated_at=NOW() WHERE id=$1 RETURNING id,type,status,updated_at`,[ex.rows[0].id,merged,env]);
  res.json(r.rows[0]);
 }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
});

// ── Sprint 2B: Secure Private Documents ───────────────────────────────────────
const DOC_SAFE_COLS='id,document_type,application_type,mime_type,size_bytes,width,height,status,created_at,updated_at';

// POST /api/me/upgrades/:type/documents — multipart upload (field "file" + "document_type")
app.post('/api/me/upgrades/:type/documents',auth,active,(req,res)=>{
 docUpload.single('file')(req,res,async(err)=>{
  try{
   if(err)return res.status(400).json({error:err.code==='LIMIT_FILE_SIZE'?'File exceeds the 5 MB limit':'Upload failed'});
   const t=req.params.type;
   if(!UG_TYPES.includes(t))return res.status(400).json({error:'Invalid type'});
   if(!docStorage.productionReady())return res.status(503).json({error:'Secure document storage is not configured. Uploads are disabled.'});
   const docType=String(req.body.document_type||'');
   const maxN=(UG_DOC_TYPES[t]||{})[docType];
   if(!maxN)return res.status(400).json({error:'Invalid document type'});
   if(!req.file||!req.file.buffer)return res.status(400).json({error:'No file provided'});
   // Application must exist in an editable status (or a draft is created)
   let appRow=(await q(`SELECT id,status FROM upgrade_applications WHERE user_id=$1 AND type=$2 ORDER BY created_at DESC LIMIT 1`,[req.user.id,t])).rows[0];
   if(appRow&&!UG_EDITABLE_STATUSES.includes(appRow.status))return res.status(409).json({error:'Documents cannot be changed while the application is '+appRow.status});
   if(!appRow||appRow.status==='rejected'){
    appRow=(await q(`INSERT INTO upgrade_applications(user_id,type,status,details) VALUES($1,$2,'draft','{}') RETURNING id,status`,[req.user.id,t])).rows[0];
   }
   // Sanitize: decode real bytes, reject fakes/animated, strip EXIF, re-encode JPEG
   const img=await sanitizeImage(req.file.buffer);
   const docId=crypto.randomUUID();
   const objectKey=`upgrades/${req.user.id}/${appRow.id}/${docId}.jpg`;
   await docStorage.putObject(objectKey,img.buffer,img.mimeType);
   // Atomic replace+insert: row-lock active docs of this type so concurrent
   // uploads cannot exceed the per-type limit or half-replace documents.
   const client=await pool.connect();
   let insRow,replaced=[];
   try{
    await client.query('BEGIN');
    // Serialize concurrent uploads for the same application+type (advisory
    // xact lock covers concurrent INSERTs, which row locks alone cannot).
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`,[appRow.id+':'+docType]);
    const prev=(await client.query(`SELECT id FROM private_documents WHERE upgrade_application_id=$1 AND document_type=$2 AND status='active' ORDER BY created_at ASC FOR UPDATE`,[appRow.id,docType])).rows;
    while(prev.length>=maxN){
     const p=prev.shift();
     await client.query(`UPDATE private_documents SET status='replaced',updated_at=NOW(),retention_until=NOW()+INTERVAL '30 days' WHERE id=$1`,[p.id]);
     replaced.push(p.id);
    }
    insRow=(await client.query(`INSERT INTO private_documents(id,user_id,upgrade_application_id,application_type,document_type,storage_provider,object_key,mime_type,size_bytes,width,height,sha256)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING ${DOC_SAFE_COLS}`,
     [docId,req.user.id,appRow.id,t,docType,docStorage.MODE,objectKey,img.mimeType,img.sizeBytes,img.width,img.height,img.sha256])).rows[0];
    await client.query('COMMIT');
   }catch(txErr){
    try{await client.query('ROLLBACK');}catch(_){}
    // Metadata failed → remove the just-stored file so no orphan remains
    try{await docStorage.deleteObject(objectKey);}catch(_){}
    throw txErr;
   }finally{client.release();}
   for(const pid of replaced)await docLog(pid,req.user.id,'replace',req);
   await docLog(docId,req.user.id,'upload',req);
   res.status(201).json({...insRow,replaced});
  }catch(e){
   if(e.statusCode===400)return res.status(400).json({error:e.message});
   console.error('doc upload error:',e.message);res.status(500).json({error:'Server error'});
  }
 });
});

// GET /api/me/upgrades/:type/documents — list own active documents (metadata only)
app.get('/api/me/upgrades/:type/documents',auth,active,async(req,res)=>{
 try{
  const t=req.params.type;
  if(!UG_TYPES.includes(t))return res.status(400).json({error:'Invalid type'});
  const appRow=(await q(`SELECT id,status FROM upgrade_applications WHERE user_id=$1 AND type=$2 ORDER BY created_at DESC LIMIT 1`,[req.user.id,t])).rows[0];
  if(!appRow)return res.json({application:null,documents:[]});
  const docs=(await q(`SELECT ${DOC_SAFE_COLS} FROM private_documents WHERE upgrade_application_id=$1 AND user_id=$2 AND status='active' ORDER BY created_at ASC`,[appRow.id,req.user.id])).rows;
  res.json({application:{id:appRow.id,status:appRow.status},documents:docs});
 }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
});

// DELETE /api/me/upgrades/:type/documents/:documentId — soft remove (editable statuses only)
app.delete('/api/me/upgrades/:type/documents/:documentId',auth,active,async(req,res)=>{
 try{
  const t=req.params.type;
  if(!UG_TYPES.includes(t))return res.status(400).json({error:'Invalid type'});
  const d=(await q(`SELECT d.id,d.status,a.status AS app_status FROM private_documents d JOIN upgrade_applications a ON a.id=d.upgrade_application_id WHERE d.id=$1 AND d.user_id=$2 AND d.application_type=$3`,[req.params.documentId,req.user.id,t])).rows[0];
  if(!d||d.status!=='active')return res.status(404).json({error:'Document not found'});
  if(!UG_EDITABLE_STATUSES.includes(d.app_status))return res.status(409).json({error:'Documents cannot be changed while the application is '+d.app_status});
  await q(`UPDATE private_documents SET status='removed',removed_at=NOW(),updated_at=NOW(),retention_until=NOW()+INTERVAL '30 days' WHERE id=$1`,[d.id]);
  await docLog(d.id,req.user.id,'remove',req);
  res.json({ok:true});
 }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
});

// GET /api/owner/upgrades/:id/documents — owner review list (metadata only)
app.get('/api/owner/upgrades/:id/documents',auth,owner,async(req,res)=>{
 try{
  const docs=(await q(`SELECT ${DOC_SAFE_COLS} FROM private_documents WHERE upgrade_application_id=$1 AND status='active' ORDER BY created_at ASC`,[req.params.id])).rows;
  res.json(docs);
 }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
});

// GET /api/private-documents/:documentId — authenticated, audited access
// Applicant may view own documents; owner may view any (each view is logged).
app.get('/api/private-documents/:documentId',auth,async(req,res)=>{
 try{
  const d=(await q(`SELECT id,user_id,object_key,mime_type,status FROM private_documents WHERE id=$1`,[req.params.documentId])).rows[0];
  if(!d)return res.status(404).json({error:'Document not found'});
  const isOwnerRole=req.user.role==='owner',isSelf=d.user_id===req.user.id;
  if(!isOwnerRole&&!isSelf)return res.status(403).json({error:'Forbidden'});
  if(d.status!=='active')return res.status(410).json({error:'Document is no longer available'});
  await docLog(d.id,req.user.id,'view',req);
  res.setHeader('Cache-Control','private, no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  const access=await docStorage.getObjectAccess(d.object_key,d.mime_type);
  if(access.kind==='signedUrl')return res.json({url:access.url,expires_in:access.expiresIn});
  res.setHeader('Content-Type',d.mime_type);
  res.setHeader('Content-Disposition','inline');
  access.stream.on('error',()=>{if(!res.headersSent)res.status(404).json({error:'Document file missing'});});
  access.stream.pipe(res);
 }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
});

// ── Public Marketplace (no auth required — safe data only) ────────────────────
app.get('/api/public/marketplace',async(req,res)=>{
 try{
  const{q:sq,category,condition,location,min_price,max_price,sort='newest',page=1,limit=20}=req.query;
  const lim=Math.min(+limit||20,100),off=(Math.max(+page||1,1)-1)*lim;
  const wp=[],w=[`ml.status='active'`,`u.status='active'`]; // hide listings of deactivated/deleted/blocked sellers
  if(sq){wp.push(`%${sq}%`);const n=wp.length;w.push(`(ml.title ILIKE $${n} OR ml.description ILIKE $${n} OR ml.category ILIKE $${n} OR ml.location ILIKE $${n})`)}
  if(category){wp.push(category);w.push(`ml.category=$${wp.length}`)}
  if(condition){wp.push(condition);w.push(`ml.condition=$${wp.length}`)}
  if(location){wp.push(`%${location}%`);w.push(`ml.location ILIKE $${wp.length}`)}
  if(min_price&&+min_price>=0){wp.push(+min_price);w.push(`ml.price>=$${wp.length}`)}
  if(max_price&&+max_price>0){wp.push(+max_price);w.push(`ml.price<=$${wp.length}`)}
  const ws=w.join(' AND ');
  const ob={newest:'ml.created_at DESC',oldest:'ml.created_at ASC',price_asc:'ml.price ASC',price_desc:'ml.price DESC',most_viewed:'ml.views_count DESC'}[sort]||'ml.created_at DESC';
  const tot=+(await q(`SELECT count(*)::int n FROM marketplace_listings ml JOIN users u ON u.id=ml.seller_id WHERE ${ws}`,wp)).rows[0].n;
  const dp=[...wp,lim,off];const lN=dp.length-1,oN=dp.length;
  const rows=(await q(`SELECT ml.id,ml.title,ml.price,ml.category,ml.condition,ml.location,ml.status,ml.created_at,ml.views_count,ml.negotiable,ml.images->0 AS main_image,jsonb_array_length(ml.images)::int AS image_count,u.id AS seller_id,u.name AS seller_name,u.profile_photo_url AS seller_photo,${isVerifiedExpr()} AS is_verified FROM marketplace_listings ml JOIN users u ON u.id=ml.seller_id WHERE ${ws} ORDER BY ${ob} LIMIT $${lN} OFFSET $${oN}`,dp)).rows;
  res.json({data:rows,total:tot,page:+page,limit:lim,pages:Math.ceil(tot/lim)});
 }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
});

app.get('/api/public/marketplace/:id',async(req,res)=>{
 try{
  const r=await q(`SELECT ml.id,ml.title,ml.price,ml.category,ml.condition,ml.location,ml.status,ml.created_at,ml.updated_at,ml.views_count,ml.negotiable,ml.description,ml.images,jsonb_array_length(ml.images)::int AS image_count,u.id AS seller_id,u.name AS seller_name,u.profile_photo_url AS seller_photo,u.created_at AS seller_joined,(SELECT count(*)::int FROM marketplace_listings WHERE seller_id=u.id AND status='active') AS seller_listing_count,${isVerifiedExpr()} AS is_verified FROM marketplace_listings ml JOIN users u ON u.id=ml.seller_id WHERE ml.id=$1 AND ml.status NOT IN ('removed','hidden') AND u.status='active'`,[req.params.id]);
  if(!r.rowCount)return res.status(404).json({error:'Listing not found'});
  const l=r.rows[0];
  // Increment views for public visitors (no seller exclusion — no user context)
  await q(`UPDATE marketplace_listings SET views_count=views_count+1 WHERE id=$1`,[req.params.id]);
  l.views_count=(l.views_count||0)+1;
  // Never expose phone in public route
  res.json(l);
 }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
});

app.get('/api/public/sellers/:id',async(req,res)=>{
 try{
  const r=await q(`SELECT id,name,profile_photo_url,created_at,(SELECT count(*)::int FROM marketplace_listings WHERE seller_id=u.id AND status='active') AS active_listings,${isVerifiedExpr()} AS is_verified FROM users u WHERE id=$1 AND status='active'`,[req.params.id]);
  if(!r.rowCount)return res.status(404).json({error:'Seller not found'});
  res.json(r.rows[0]);
 }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
});

app.get('/api/public/sellers/:id/listings',async(req,res)=>{
 try{
  const lim=Math.min(+(req.query.limit)||20,100),off=(Math.max(+(req.query.page)||1,1)-1)*lim;
  const tot=+(await q(`SELECT count(*)::int n FROM marketplace_listings WHERE seller_id=$1 AND status='active'`,[req.params.id])).rows[0].n;
  const rows=(await q(`SELECT id,title,price,category,condition,location,status,created_at,views_count,negotiable,images->0 AS main_image,jsonb_array_length(images)::int AS image_count FROM marketplace_listings WHERE seller_id=$1 AND status='active' ORDER BY created_at DESC LIMIT $2 OFFSET $3`,[req.params.id,lim,off])).rows;
  res.json({data:rows,total:tot,page:+(req.query.page)||1,limit:lim,pages:Math.ceil(tot/lim)});
 }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
});

// ── Authenticated Marketplace ─────────────────────────────────────────────────
app.get('/api/marketplace',auth,active,async(req,res)=>{
 try{
  const{q:sq,category,condition,location,min_price,max_price,sort='newest',page=1,limit=20}=req.query;
  const lim=Math.min(+limit||20,100),off=(Math.max(+page||1,1)-1)*lim;
  const wp=[],w=[`ml.status='active'`,`u.status='active'`]; // hide listings of deactivated/deleted/blocked sellers
  if(sq){wp.push(`%${sq}%`);const n=wp.length;w.push(`(ml.title ILIKE $${n} OR ml.description ILIKE $${n} OR ml.category ILIKE $${n} OR ml.location ILIKE $${n})`)}
  if(category){wp.push(category);w.push(`ml.category=$${wp.length}`)}
  if(condition){wp.push(condition);w.push(`ml.condition=$${wp.length}`)}
  if(location){wp.push(`%${location}%`);w.push(`ml.location ILIKE $${wp.length}`)}
  if(min_price&&+min_price>=0){wp.push(+min_price);w.push(`ml.price>=$${wp.length}`)}
  if(max_price&&+max_price>0){wp.push(+max_price);w.push(`ml.price<=$${wp.length}`)}
  const ws=w.join(' AND ');
  const ob={newest:'ml.created_at DESC',oldest:'ml.created_at ASC',price_asc:'ml.price ASC',price_desc:'ml.price DESC',most_viewed:'ml.views_count DESC'}[sort]||'ml.created_at DESC';
  const tot=+(await q(`SELECT count(*)::int n FROM marketplace_listings ml JOIN users u ON u.id=ml.seller_id WHERE ${ws}`,wp)).rows[0].n;
  const dp=[...wp,req.user.id,lim,off];const uN=dp.length-2,lN=dp.length-1,oN=dp.length;
  const rows=(await q(`SELECT ml.id,ml.title,ml.price,ml.category,ml.condition,ml.location,ml.status,ml.created_at,ml.updated_at,ml.views_count,ml.negotiable,ml.seller_phone_visible,ml.images->0 AS main_image,jsonb_array_length(ml.images)::int AS image_count,u.id AS seller_id,u.name AS seller_name,u.profile_photo_url AS seller_photo,EXISTS(SELECT 1 FROM listing_favorites lf WHERE lf.listing_id=ml.id AND lf.user_id=$${uN}) AS is_favorited,${isVerifiedExpr()} AS is_verified FROM marketplace_listings ml JOIN users u ON u.id=ml.seller_id WHERE ${ws} ORDER BY ${ob} LIMIT $${lN} OFFSET $${oN}`,dp)).rows;
  res.json({data:rows,total:tot,page:+page,limit:lim,pages:Math.ceil(tot/lim)});
 }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
});

app.get('/api/marketplace/:id',auth,active,async(req,res)=>{
 try{
  const r=await q(`SELECT ml.*,u.id AS seller_id,u.name AS seller_name,u.profile_photo_url AS seller_photo,u.phone AS seller_phone,u.created_at AS seller_joined,(SELECT count(*)::int FROM marketplace_listings WHERE seller_id=u.id AND status='active') AS seller_listing_count,EXISTS(SELECT 1 FROM listing_favorites lf WHERE lf.listing_id=ml.id AND lf.user_id=$2) AS is_favorited,${isVerifiedExpr()} AS is_verified FROM marketplace_listings ml JOIN users u ON u.id=ml.seller_id WHERE ml.id=$1 AND ml.status<>'removed'`,[req.params.id,req.user.id]);
  if(!r.rowCount)return res.status(404).json({error:'Listing not found'});
  const l=r.rows[0];
  if(l.status==='hidden'&&req.user.id!==l.seller_id&&req.user.role!=='owner')return res.status(404).json({error:'Listing not found'});
  if(req.user.id!==l.seller_id&&req.user.role!=='owner'){
   await q(`UPDATE marketplace_listings SET views_count=views_count+1 WHERE id=$1`,[req.params.id]);
   l.views_count=(l.views_count||0)+1;
  }
  if(!l.seller_phone_visible)l.seller_phone=null;
  res.json(l);
 }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
});

app.post('/api/marketplace',auth,active,async(req,res)=>{
 try{
  const b=req.body||{};
  const title=String(b.title||'').trim(),desc=String(b.description||'').trim(),loc=String(b.location||'').trim(),price=+b.price;
  const imgs=Array.isArray(b.images)?b.images.slice(0,5):[];
  if(!title||title.length<3||title.length>100)return res.status(400).json({error:'Title must be 3–100 characters'});
  if(!price||price<=0)return res.status(400).json({error:'Price must be a positive number'});
  if(!b.category)return res.status(400).json({error:'Category is required'});
  if(!['Used','New'].includes(b.condition))return res.status(400).json({error:'Condition must be Used or New'});
  if(!desc||desc.length<10||desc.length>2000)return res.status(400).json({error:'Description must be 10–2000 characters'});
  if(!loc||loc.length<2)return res.status(400).json({error:'Location is required'});
  if(!imgs.length)return res.status(400).json({error:'At least one image is required'});
  const r=await q(`INSERT INTO marketplace_listings(seller_id,title,price,category,condition,description,location,images,negotiable,seller_phone_visible,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW()) RETURNING *`,[req.user.id,title,price,b.category,b.condition,desc,loc,JSON.stringify(imgs),!!b.negotiable,!!b.seller_phone_visible]);
  res.status(201).json(r.rows[0]);
 }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
});

app.patch('/api/marketplace/:id',auth,active,async(req,res)=>{
 try{
  const chk=await q(`SELECT seller_id FROM marketplace_listings WHERE id=$1`,[req.params.id]);
  if(!chk.rowCount)return res.status(404).json({error:'Not found'});
  if(chk.rows[0].seller_id!==req.user.id)return res.status(403).json({error:'Not your listing'});
  const b=req.body||{};
  const title=String(b.title||'').trim(),desc=String(b.description||'').trim(),loc=String(b.location||'').trim(),price=+b.price;
  const imgs=Array.isArray(b.images)?b.images.slice(0,5):null;
  if(!title||title.length<3||title.length>100)return res.status(400).json({error:'Title must be 3–100 characters'});
  if(!price||price<=0)return res.status(400).json({error:'Price must be a positive number'});
  if(!b.category)return res.status(400).json({error:'Category is required'});
  if(!['Used','New'].includes(b.condition))return res.status(400).json({error:'Condition must be Used or New'});
  if(!desc||desc.length<10||desc.length>2000)return res.status(400).json({error:'Description must be 10–2000 characters'});
  if(!loc||loc.length<2)return res.status(400).json({error:'Location is required'});
  if(imgs!==null&&!imgs.length)return res.status(400).json({error:'At least one image is required'});
  const r=await q(`UPDATE marketplace_listings SET title=$2,price=$3,category=$4,condition=$5,description=$6,location=$7,negotiable=$8,seller_phone_visible=$9,images=COALESCE($10,images),updated_at=NOW() WHERE id=$1 AND seller_id=$11 RETURNING *`,[req.params.id,title,price,b.category,b.condition,desc,loc,!!b.negotiable,!!b.seller_phone_visible,imgs?JSON.stringify(imgs):null,req.user.id]);
  if(!r.rowCount)return res.status(403).json({error:'Not your listing'});
  res.json(r.rows[0]);
 }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
});

app.patch('/api/marketplace/:id/status',auth,active,async(req,res)=>{
 try{
  const s=req.body.status;
  if(!['active','hidden','sold','removed'].includes(s))return res.status(400).json({error:'Invalid status'});
  const chk=await q(`SELECT seller_id,status FROM marketplace_listings WHERE id=$1`,[req.params.id]);
  if(!chk.rowCount)return res.status(404).json({error:'Not found'});
  if(chk.rows[0].seller_id!==req.user.id&&req.user.role!=='owner')return res.status(403).json({error:'Not your listing'});
  if(s==='sold'&&req.user.role==='owner')return res.status(403).json({error:'Owner cannot mark as sold'});
  const r=await q(`UPDATE marketplace_listings SET status=$2,updated_at=NOW() WHERE id=$1 RETURNING *`,[req.params.id,s]);
  res.json(r.rows[0]);
 }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
});

app.post('/api/marketplace/:id/favorite',auth,active,async(req,res)=>{
 try{
  if(!(await q(`SELECT 1 FROM marketplace_listings WHERE id=$1`,[req.params.id])).rowCount)return res.status(404).json({error:'Not found'});
  await q(`INSERT INTO listing_favorites(user_id,listing_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,[req.user.id,req.params.id]);
  res.json({ok:true});
 }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
});

app.delete('/api/marketplace/:id/favorite',auth,active,async(req,res)=>{
 try{
  await q(`DELETE FROM listing_favorites WHERE user_id=$1 AND listing_id=$2`,[req.user.id,req.params.id]);
  res.json({ok:true});
 }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
});

app.post('/api/marketplace/:id/report',auth,active,async(req,res)=>{
 try{
  const reasons=['scam','prohibited_item','wrong_category','duplicate','offensive_content','other'];
  const reason=String(req.body.reason||'');
  if(!reasons.includes(reason))return res.status(400).json({error:'Invalid reason'});
  if(!(await q(`SELECT 1 FROM marketplace_listings WHERE id=$1 AND status<>'removed'`,[req.params.id])).rowCount)return res.status(404).json({error:'Listing not found'});
  if((await q(`SELECT 1 FROM listing_reports WHERE listing_id=$1 AND reporter_id=$2 AND status='pending'`,[req.params.id,req.user.id])).rowCount)return res.status(409).json({error:'You already have a pending report for this listing'});
  await q(`INSERT INTO listing_reports(listing_id,reporter_id,reason,details) VALUES($1,$2,$3,$4)`,[req.params.id,req.user.id,reason,String(req.body.details||'').slice(0,500)]);
  res.status(201).json({ok:true});
 }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
});

// ── Sellers (auth required — includes phone for WhatsApp on seller profile) ───
app.get('/api/sellers/:id',auth,async(req,res)=>{
 try{
  const r=await q(`SELECT id,name,profile_photo_url,created_at,(SELECT count(*)::int FROM marketplace_listings WHERE seller_id=u.id AND status='active') AS active_listings,${isVerifiedExpr()} AS is_verified FROM users u WHERE id=$1 AND status='active'`,[req.params.id]);
  if(!r.rowCount)return res.status(404).json({error:'Seller not found'});
  res.json(r.rows[0]);
 }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
});

app.get('/api/sellers/:id/listings',auth,async(req,res)=>{
 try{
  const lim=Math.min(+(req.query.limit)||20,100),off=(Math.max(+(req.query.page)||1,1)-1)*lim;
  const tot=+(await q(`SELECT count(*)::int n FROM marketplace_listings WHERE seller_id=$1 AND status='active'`,[req.params.id])).rows[0].n;
  const rows=(await q(`SELECT id,title,price,category,condition,location,status,created_at,views_count,negotiable,images->0 AS main_image,jsonb_array_length(images)::int AS image_count FROM marketplace_listings WHERE seller_id=$1 AND status='active' ORDER BY created_at DESC LIMIT $2 OFFSET $3`,[req.params.id,lim,off])).rows;
  res.json({data:rows,total:tot,page:+(req.query.page)||1,limit:lim,pages:Math.ceil(tot/lim)});
 }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
});

// ── Owner ─────────────────────────────────────────────────────────────────────
app.get('/api/owner/dashboard',auth,owner,async(req,res)=>res.json({
 users:+(await q('SELECT count(*) n FROM users')).rows[0].n,
 pendingAccess:+(await q(`SELECT count(*) n FROM access_requests WHERE status='pending'`)).rows[0].n,
 pendingUpgrades:+(await q(`SELECT count(*) n FROM upgrade_applications WHERE status='pending'`)).rows[0].n,
 activeListings:+(await q(`SELECT count(*) n FROM marketplace_listings WHERE status='active'`)).rows[0].n,
 pendingReports:+(await q(`SELECT count(*) n FROM listing_reports WHERE status='pending'`)).rows[0].n,
 pendingGenericReports:+(await q(`SELECT count(*) n FROM reports WHERE status='pending'`)).rows[0].n,
 openRequests:+(await q(`SELECT count(*) n FROM service_requests WHERE status IN('pending','accepted')`)).rows[0].n,
 activeProfessionalProfiles:+(await q(`SELECT count(*) n FROM professional_profiles WHERE status='active'`)).rows[0].n,
 activeMerchantProfiles:+(await q(`SELECT count(*) n FROM merchant_profiles WHERE status='active'`)).rows[0].n,
 activeDriverProfiles:+(await q(`SELECT count(*) n FROM driver_profiles WHERE status='active'`)).rows[0].n,
 reviews:+(await q(`SELECT count(*) n FROM reviews`)).rows[0].n
}));

app.get('/api/owner/access',auth,owner,async(req,res)=>res.json((await q(`SELECT a.*,u.name,u.email,u.phone,u.profile_photo_url FROM access_requests a JOIN users u ON u.id=a.user_id ORDER BY a.created_at DESC`)).rows));
app.patch('/api/owner/access/:id',auth,owner,async(req,res)=>{
 let s=req.body.status;
 if(!['approved','rejected'].includes(s))return res.status(400).json({error:'Invalid'});
 let r=await q(`UPDATE access_requests SET status=$2,reviewed_at=NOW() WHERE id=$1 RETURNING *`,[req.params.id,s]);
 if(!r.rowCount)return res.status(404).json({error:'Not found'});
 await q(`UPDATE users SET status=$2 WHERE id=$1`,[r.rows[0].user_id,s==='approved'?'active':'rejected']);
 res.json(r.rows[0]);
});

// GET /api/owner/upgrades — filtered list, pending first, no documents
app.get('/api/owner/upgrades',auth,owner,async(req,res)=>{
 try{
  const{type,status,q:sq}=req.query;
  const wp=[],w=[];
  if(UG_TYPES.includes(type)){wp.push(type);w.push(`a.type=$${wp.length}`);}
  if(UG_STATUSES.includes(status)){wp.push(status);w.push(`a.status=$${wp.length}`);}
  if(sq){wp.push(`%${sq}%`);const n=wp.length;w.push(`(u.name ILIKE $${n} OR u.email ILIKE $${n} OR u.phone ILIKE $${n})`);}
  const ws=w.length?'WHERE '+w.join(' AND '):'';
  const r=await q(`SELECT a.id,a.user_id,a.type,a.status,a.review_note,a.submitted_at,a.reviewed_at,a.updated_at,a.created_at,u.name,u.email,u.phone FROM upgrade_applications a JOIN users u ON u.id=a.user_id ${ws} ORDER BY CASE a.status WHEN 'pending' THEN 0 WHEN 'corrections_requested' THEN 1 ELSE 2 END,COALESCE(a.submitted_at,a.created_at) DESC`,wp);
  res.json(r.rows);
 }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
});

// GET /api/owner/upgrades/:id — full application with documents
app.get('/api/owner/upgrades/:id',auth,owner,async(req,res)=>{
 try{
  const r=await q(`SELECT a.*,u.name,u.email,u.phone,u.capabilities FROM upgrade_applications a JOIN users u ON u.id=a.user_id WHERE a.id=$1`,[req.params.id]);
  if(!r.rowCount)return res.status(404).json({error:'Not found'});
  res.json(ugMergeSensitive(r.rows[0]));
 }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
});

// PATCH /api/owner/upgrades/:id/status — full moderation with note
app.patch('/api/owner/upgrades/:id/status',auth,owner,async(req,res)=>{
 try{
  const{status,note}=req.body;
  const valid=['approved','rejected','corrections_requested','suspended','restored'];
  if(!valid.includes(status))return res.status(400).json({error:'Invalid status'});
  if(['rejected','corrections_requested','suspended'].includes(status)&&!String(note||'').trim())return res.status(400).json({error:'A review note is required'});
  const cur=await q(`SELECT * FROM upgrade_applications WHERE id=$1`,[req.params.id]);
  if(!cur.rowCount)return res.status(404).json({error:'Not found'});
  const a=cur.rows[0];
  if(a.user_id===req.user.id)return res.status(403).json({error:'Cannot moderate your own application'});
  if(!(UG_TRANSITIONS[a.status]||[]).includes(status))return res.status(409).json({error:`Cannot ${status.replace('_',' ')} an application that is ${a.status}`});
  const newSt=status==='restored'?'approved':status;
  const r=await q(`UPDATE upgrade_applications SET status=$2,review_note=$3,reviewed_at=NOW(),reviewed_by=$4,updated_at=NOW() WHERE id=$1 RETURNING *`,[req.params.id,newSt,String(note||'').trim()||null,req.user.id]);
  if(status==='approved'||status==='restored'){
   await q(`UPDATE users SET capabilities=jsonb_set(capabilities,ARRAY[$2],'true',true) WHERE id=$1`,[a.user_id,a.type]);
  }else if(status==='suspended'){
   await q(`UPDATE users SET capabilities=jsonb_set(capabilities,ARRAY[$2],'false',true) WHERE id=$1`,[a.user_id,a.type]);
  }else if(status==='rejected'&&['approved','suspended'].includes(a.status)){
   await q(`UPDATE users SET capabilities=jsonb_set(capabilities,ARRAY[$2],'false',true) WHERE id=$1`,[a.user_id,a.type]);
  }
  await audit(req.user.id,'upgrade_'+status,'upgrade_application',req.params.id,note);
  res.json({id:r.rows[0].id,type:r.rows[0].type,status:r.rows[0].status,review_note:r.rows[0].review_note,reviewed_at:r.rows[0].reviewed_at});
 }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
});

// PATCH /api/owner/upgrades/:id — backward-compatible
app.patch('/api/owner/upgrades/:id',auth,owner,async(req,res)=>{
 try{
  const status=String(req.body.status||''),note=String(req.body.note||req.body.review_note||'').trim();
  const valid=['approved','rejected','corrections_requested','suspended','restored'];
  if(!valid.includes(status))return res.status(400).json({error:'Invalid status'});
  if(['rejected','corrections_requested','suspended'].includes(status)&&!note)return res.status(400).json({error:'A review note is required'});
  const cur=await q(`SELECT * FROM upgrade_applications WHERE id=$1`,[req.params.id]);
  if(!cur.rowCount)return res.status(404).json({error:'Not found'});
  const a=cur.rows[0];
  if(a.user_id===req.user.id)return res.status(403).json({error:'Cannot moderate your own application'});
  if(!(UG_TRANSITIONS[a.status]||[]).includes(status))return res.status(409).json({error:`Cannot ${status.replace('_',' ')} an application that is ${a.status}`});
  const newSt=status==='restored'?'approved':status;
  const r=await q(`UPDATE upgrade_applications SET status=$2,review_note=$3,reviewed_at=NOW(),reviewed_by=$4,updated_at=NOW() WHERE id=$1 RETURNING *`,[req.params.id,newSt,note||null,req.user.id]);
  if(status==='approved'||status==='restored')await q(`UPDATE users SET capabilities=jsonb_set(capabilities,ARRAY[$2],'true',true) WHERE id=$1`,[a.user_id,a.type]);
  else if(status==='suspended')await q(`UPDATE users SET capabilities=jsonb_set(capabilities,ARRAY[$2],'false',true) WHERE id=$1`,[a.user_id,a.type]);
  else if(status==='rejected'&&['approved','suspended'].includes(a.status))await q(`UPDATE users SET capabilities=jsonb_set(capabilities,ARRAY[$2],'false',true) WHERE id=$1`,[a.user_id,a.type]);
  const{sensitive_details,...safeRow}=r.rows[0];
  res.json(safeRow);
 }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
});

app.get('/api/owner/users',auth,owner,async(req,res)=>{
 try{
  const r=await q(`SELECT u.id,u.name,u.email,u.phone,u.role,u.status,u.email_verified,u.phone_verified,u.capabilities,u.created_at,u.profile_photo_url,count(ml.id)::int AS listing_count FROM users u LEFT JOIN marketplace_listings ml ON ml.seller_id=u.id GROUP BY u.id ORDER BY u.created_at DESC`);
  res.json(r.rows);
 }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
});

app.get('/api/owner/users/:id',auth,owner,async(req,res)=>{
 try{
  const r=await q(`SELECT u.id,u.name,u.email,u.phone,u.role,u.status,u.email_verified,u.phone_verified,u.capabilities,u.created_at,u.profile_photo_url,count(ml.id) FILTER(WHERE ml.status='active')::int AS active_listings,count(ml.id) FILTER(WHERE ml.status='hidden')::int AS hidden_listings,count(ml.id) FILTER(WHERE ml.status='removed')::int AS removed_listings,count(ml.id) FILTER(WHERE ml.status='sold')::int AS sold_listings,count(ml.id)::int AS total_listings FROM users u LEFT JOIN marketplace_listings ml ON ml.seller_id=u.id WHERE u.id=$1 GROUP BY u.id`,[req.params.id]);
  if(!r.rowCount)return res.status(404).json({error:'User not found'});
  res.json(r.rows[0]);
 }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
});

app.get('/api/owner/users/:id/listings',auth,owner,async(req,res)=>{
 try{
  const r=await q(`SELECT id,title,price,category,condition,location,status,created_at,updated_at,views_count,negotiable,jsonb_array_length(images)::int AS image_count,images->0 AS main_image,description FROM marketplace_listings WHERE seller_id=$1 ORDER BY created_at DESC`,[req.params.id]);
  res.json(r.rows);
 }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
});

// GET /api/owner/users/:id/upgrades — per-user list, no documents
app.get('/api/owner/users/:id/upgrades',auth,owner,async(req,res)=>{
 try{
  const r=await q(`SELECT id,user_id,type,status,review_note,submitted_at,reviewed_at,reviewed_by,updated_at,created_at FROM upgrade_applications WHERE user_id=$1 ORDER BY type,created_at DESC`,[req.params.id]);
  res.json(r.rows);
 }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
});

app.patch('/api/owner/users/:id/status',auth,owner,async(req,res)=>{
 try{
  const s=req.body.status;
  if(!['active','rejected','blocked'].includes(s))return res.status(400).json({error:'Invalid status'});
  const chk=await q('SELECT role FROM users WHERE id=$1',[req.params.id]);
  if(!chk.rowCount)return res.status(404).json({error:'User not found'});
  if(chk.rows[0].role==='owner')return res.status(403).json({error:'Cannot modify owner account'});
  const r=await q('UPDATE users SET status=$2 WHERE id=$1 RETURNING id,name,email,role,status',[req.params.id,s]);
  await audit(req.user.id,'set_user_status_'+s,'user',req.params.id,String(req.body.note||''));
  res.json(r.rows[0]);
 }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
});

app.get('/api/owner/listings/:id',auth,owner,async(req,res)=>{
 try{
  const r=await q(`SELECT ml.*,u.name AS seller_name,u.email AS seller_email,u.phone AS seller_phone,u.id AS seller_id FROM marketplace_listings ml JOIN users u ON u.id=ml.seller_id WHERE ml.id=$1`,[req.params.id]);
  if(!r.rowCount)return res.status(404).json({error:'Listing not found'});
  res.json(r.rows[0]);
 }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
});

app.patch('/api/owner/listings/:id/status',auth,owner,async(req,res)=>{
 try{
  const s=req.body.status;
  if(!['active','hidden','removed'].includes(s))return res.status(400).json({error:'Invalid status'});
  const r=await q('UPDATE marketplace_listings SET status=$2,updated_at=NOW() WHERE id=$1 RETURNING *',[req.params.id,s]);
  if(!r.rowCount)return res.status(404).json({error:'Listing not found'});
  await audit(req.user.id,'set_listing_status_'+s,'listing',req.params.id,'');
  res.json(r.rows[0]);
 }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
});

app.get('/api/owner/listing-reports',auth,owner,async(req,res)=>{
 try{
  const s=req.query.status||'pending';
  const valid=['pending','reviewed','dismissed','all'].includes(s)?s:'pending';
  const rows=(await q(`SELECT lr.*,ml.title AS listing_title,ml.status AS listing_status,u.name AS reporter_name FROM listing_reports lr JOIN marketplace_listings ml ON ml.id=lr.listing_id JOIN users u ON u.id=lr.reporter_id${valid!=='all'?` WHERE lr.status=$1`:''} ORDER BY lr.created_at DESC`,valid!=='all'?[valid]:[])).rows;
  res.json(rows);
 }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
});

app.patch('/api/owner/listing-reports/:id',auth,owner,async(req,res)=>{
 try{
  const s=req.body.status;
  if(!['reviewed','dismissed'].includes(s))return res.status(400).json({error:'Invalid status'});
  const r=await q(`UPDATE listing_reports SET status=$2,reviewed_at=NOW(),reviewed_by=$3 WHERE id=$1 RETURNING *`,[req.params.id,s,req.user.id]);
  if(!r.rowCount)return res.status(404).json({error:'Not found'});
  res.json(r.rows[0]);
 }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
});

// ── Public Professional profiles (Sprint 3A) ────────────────────────────────
// The verified application (upgrade_applications + private_documents) and this
// public profile are completely separate entities. This block never reads or
// writes private documents, and public media uses lib/publicMediaStorage.js —
// a separate storage abstraction that refuses the private-document buckets.
const pubMedia=require('./lib/publicMediaStorage');
const PP_EDITABLE=['display_name','headline','service_description','skills','county','town','service_area','availability','starting_price','pricing_unit','phone_visible','whatsapp_visible'];
const PP_LOCKED=['legal_name','full_name','fullName','id_number','nationalId','passport','application_status','review_note','moderation_note','capabilities','role','verified_category','profession_category','professionCategory','status','user_id','hidden_by','hidden_at'];
const PP_MAX_PORTFOLIO=12;
const PP_LOCK_MSG='Contact HAPA support to request a change to your verified profession category.';

// Eligibility: role customer, active (enforced by auth+active), capability true,
// AND an approved professional application.
const ppCap=(req,res,next)=>(req.user.capabilities||{}).professional===true?next():res.status(403).json({error:'Professional capability required'});
async function ppApprovedApp(userId){
 return (await q(`SELECT id,details FROM upgrade_applications WHERE user_id=$1 AND type='professional' AND status='approved' ORDER BY created_at DESC LIMIT 1`,[userId])).rows[0]||null;
}
const ppSafe=p=>({id:p.id,status:p.status,verified_category:p.verified_category,display_name:p.display_name,headline:p.headline,service_description:p.service_description,skills:p.skills,county:p.county,town:p.town,service_area:p.service_area,availability:p.availability,starting_price:p.starting_price,pricing_unit:p.pricing_unit,phone_visible:p.phone_visible,whatsapp_visible:p.whatsapp_visible,profile_photo_id:p.profile_photo_id,moderation_note:p.status==='owner_hidden'?p.moderation_note:null,created_at:p.created_at,updated_at:p.updated_at,published_at:p.published_at,paused_at:p.paused_at});
const PP_PUBLIC_MEDIA_BASE='/api/public/professional-media/';
const PP_OWNER_MEDIA_BASE='/api/me/professional-profile/media/';
const ppImgSafe=(i,base=PP_PUBLIC_MEDIA_BASE)=>({id:i.id,url:base+i.id,width:i.width,height:i.height,sort_order:i.sort_order});
async function ppImages(profileId,base=PP_PUBLIC_MEDIA_BASE){
 const r=await q(`SELECT id,width,height,sort_order,kind FROM professional_portfolio_images WHERE professional_profile_id=$1 AND status='active' ORDER BY sort_order ASC,created_at ASC`,[profileId]);
 return{portfolio:r.rows.filter(x=>x.kind==='portfolio').map(i=>ppImgSafe(i,base)),profilePhoto:r.rows.filter(x=>x.kind==='profile_photo').map(i=>ppImgSafe(i,base))[0]||null};
}
async function ppMine(userId){return(await q(`SELECT * FROM professional_profiles WHERE user_id=$1`,[userId])).rows[0]||null;}
// Authenticated owner payloads point image URLs at the owner-only media route,
// so the editor works while the profile is draft/paused/owner_hidden.
async function ppPayload(p){const im=await ppImages(p.id,PP_OWNER_MEDIA_BASE);return{profile:ppSafe(p),profile_photo:im.profilePhoto,portfolio:im.portfolio};}

app.get('/api/me/professional-profile',auth,active,ppCap,async(req,res)=>{
 try{const p=await ppMine(req.user.id);if(!p)return res.json({profile:null});res.json(await ppPayload(p));}
 catch(e){console.error(e);res.status(500).json({error:'Server error'})}
});

// Create draft, prefilled from the approved application (which stays untouched)
app.post('/api/me/professional-profile',auth,active,ppCap,async(req,res)=>{
 try{
  if(req.user.role!=='customer')return res.status(403).json({error:'Only customer accounts can hold a professional profile'});
  if(await ppMine(req.user.id))return res.status(409).json({error:'Profile already exists'});
  const a=await ppApprovedApp(req.user.id);
  if(!a)return res.status(403).json({error:'An approved Professional application is required'});
  const d=a.details||{};
  const skills=String(d.skills||'').split(',').map(s=>s.trim()).filter(Boolean).slice(0,20);
  const p=(await q(`INSERT INTO professional_profiles(user_id,application_id,verified_category,display_name,service_description,skills,starting_price,availability,county,town,service_area)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
   [req.user.id,a.id,String(d.professionCategory||'').slice(0,80),String(req.user.name||'').slice(0,80),String(d.serviceDescription||'').slice(0,2000),JSON.stringify(skills),
    d.startingPrice&&isFinite(+d.startingPrice)?+d.startingPrice:null,String(d.availability||'').slice(0,120),String(d.county||'').slice(0,80),String(d.town||'').slice(0,80),String(d.serviceArea||'').slice(0,200)])).rows[0];
  res.status(201).json(await ppPayload(p));
 }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
});

app.patch('/api/me/professional-profile',auth,active,ppCap,async(req,res)=>{
 try{
  const p=await ppMine(req.user.id);
  if(!p)return res.status(404).json({error:'Profile not found'});
  const body=req.body||{};
  const lockedHit=Object.keys(body).find(k=>PP_LOCKED.includes(k));
  if(lockedHit)return res.status(400).json({error:`Field "${lockedHit}" is verified and cannot be edited here. ${PP_LOCK_MSG}`});
  const sets=[],vals=[p.id];
  for(const k of PP_EDITABLE){
   if(!(k in body))continue;
   let v=body[k];
   if(k==='skills'){if(!Array.isArray(v))return res.status(400).json({error:'skills must be an array'});v=JSON.stringify(v.map(s=>String(s).trim().slice(0,60)).filter(Boolean).slice(0,20));}
   else if(k==='starting_price'){if(v===null||v==='')v=null;else{v=+v;if(!isFinite(v)||v<0||v>10000000)return res.status(400).json({error:'Invalid starting price'});}}
   else if(k==='phone_visible'||k==='whatsapp_visible')v=v===true;
   else{v=String(v==null?'':v).trim().slice(0,k==='service_description'?2000:200);}
   vals.push(v);sets.push(`${k}=$${vals.length}`);
  }
  if(!sets.length)return res.status(400).json({error:'No editable fields provided'});
  const r=(await q(`UPDATE professional_profiles SET ${sets.join(',')},updated_at=NOW() WHERE id=$1 RETURNING *`,vals)).rows[0];
  res.json(await ppPayload(r));
 }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
});

// Status transitions. Owner-hidden profiles cannot be self-restored.
async function ppTransition(req,res,from,to){
 try{
  const p=await ppMine(req.user.id);
  if(!p)return res.status(404).json({error:'Profile not found'});
  if(p.status==='owner_hidden')return res.status(403).json({error:'This profile was hidden by HAPA moderation. Contact HAPA support.'});
  if(!from.includes(p.status))return res.status(409).json({error:`Profile is ${p.status}`});
  if(to==='active'){
   if(!(await ppApprovedApp(req.user.id)))return res.status(403).json({error:'An approved Professional application is required to publish'});
   if(!(String(p.headline).trim()||String(p.service_description).trim()))return res.status(400).json({error:'Add a headline or service description before publishing'});
  }
  const r=(await q(`UPDATE professional_profiles SET status=$2,updated_at=NOW(),
    published_at=CASE WHEN $2='active' AND published_at IS NULL THEN NOW() ELSE published_at END,
    paused_at=CASE WHEN $2='paused' THEN NOW() ELSE paused_at END
    WHERE id=$1 RETURNING *`,[p.id,to])).rows[0];
  res.json(await ppPayload(r));
 }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
}
app.post('/api/me/professional-profile/publish',auth,active,ppCap,(req,res)=>ppTransition(req,res,['draft','paused'],'active'));
app.post('/api/me/professional-profile/pause',auth,active,ppCap,(req,res)=>ppTransition(req,res,['active'],'paused'));
app.post('/api/me/professional-profile/reactivate',auth,active,ppCap,(req,res)=>ppTransition(req,res,['paused'],'active'));

// Shared upload handler: multipart → byte-validated → sharp sanitize (auto-orient,
// EXIF/GPS stripped, resized, sha256) → public-media storage, PII-free object key.
async function ppStoreImage(req,kind,profile){
 const img=await sanitizeImage(req.file.buffer); // rejects SVG/malformed, JPEG/PNG/WebP(+HEIC) only
 const imageId=crypto.randomUUID();
 const storageKey=`professional/${profile.id}/${kind}/${imageId}.jpg`;
 await pubMedia.putObject(storageKey,img.buffer,img.mimeType);
 try{
  return(await q(`INSERT INTO professional_portfolio_images(id,professional_profile_id,kind,storage_provider,storage_key,mime_type,size_bytes,width,height,sha256,sort_order)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
   [imageId,profile.id,kind,pubMedia.MODE,storageKey,img.mimeType,img.sizeBytes,img.width,img.height,img.sha256,
    kind==='portfolio'?+(await q(`SELECT COALESCE(MAX(sort_order),-1)+1 n FROM professional_portfolio_images WHERE professional_profile_id=$1 AND kind='portfolio' AND status='active'`,[profile.id])).rows[0].n:0])).rows[0];
 }catch(e){try{await pubMedia.deleteObject(storageKey);}catch(_){}throw e;}
}
function ppUploadRoute(handler){
 return(req,res)=>docUpload.single('file')(req,res,async(err)=>{
  try{
   if(err)return res.status(400).json({error:err.code==='LIMIT_FILE_SIZE'?'File exceeds the 5 MB limit':'Upload failed'});
   if(!pubMedia.productionReady())return res.status(503).json({error:'Public media storage is not configured. Uploads are disabled.'});
   if(!req.file||!req.file.buffer)return res.status(400).json({error:'No file provided'});
   const p=await ppMine(req.user.id);
   if(!p)return res.status(404).json({error:'Profile not found'});
   await handler(req,res,p);
  }catch(e){
   if(e.statusCode===400)return res.status(400).json({error:e.message});
   console.error('public media upload error:',e.message);res.status(500).json({error:'Server error'});
  }
 });
}

// Profile photo (max 1): uploading replaces the previous one (soft-removed).
app.post('/api/me/professional-profile/profile-photo',auth,active,ppCap,ppUploadRoute(async(req,res,p)=>{
 const row=await ppStoreImage(req,'profile_photo',p);
 await q(`UPDATE professional_portfolio_images SET status='removed',removed_at=NOW() WHERE professional_profile_id=$1 AND kind='profile_photo' AND status='active' AND id<>$2`,[p.id,row.id]);
 await q(`UPDATE professional_profiles SET profile_photo_id=$2,updated_at=NOW() WHERE id=$1`,[p.id,row.id]);
 res.status(201).json(ppImgSafe(row,PP_OWNER_MEDIA_BASE));
}));
app.delete('/api/me/professional-profile/profile-photo',auth,active,ppCap,async(req,res)=>{
 try{
  const p=await ppMine(req.user.id);
  if(!p)return res.status(404).json({error:'Profile not found'});
  await q(`UPDATE professional_portfolio_images SET status='removed',removed_at=NOW() WHERE professional_profile_id=$1 AND kind='profile_photo' AND status='active'`,[p.id]);
  await q(`UPDATE professional_profiles SET profile_photo_id=NULL,updated_at=NOW() WHERE id=$1`,[p.id]);
  res.json({ok:true});
 }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
});

// Portfolio (max 12 active)
app.post('/api/me/professional-profile/portfolio',auth,active,ppCap,ppUploadRoute(async(req,res,p)=>{
 const n=+(await q(`SELECT count(*)::int n FROM professional_portfolio_images WHERE professional_profile_id=$1 AND kind='portfolio' AND status='active'`,[p.id])).rows[0].n;
 if(n>=PP_MAX_PORTFOLIO)return res.status(409).json({error:`Maximum ${PP_MAX_PORTFOLIO} portfolio photos`});
 res.status(201).json(ppImgSafe(await ppStoreImage(req,'portfolio',p),PP_OWNER_MEDIA_BASE));
}));
app.patch('/api/me/professional-profile/portfolio/order',auth,active,ppCap,async(req,res)=>{
 try{
  const ids=req.body.ids;
  if(!Array.isArray(ids)||!ids.length)return res.status(400).json({error:'ids array required'});
  const p=await ppMine(req.user.id);
  if(!p)return res.status(404).json({error:'Profile not found'});
  for(let i=0;i<ids.length;i++)await q(`UPDATE professional_portfolio_images SET sort_order=$3 WHERE id=$1 AND professional_profile_id=$2 AND kind='portfolio' AND status='active'`,[ids[i],p.id,i]);
  res.json({portfolio:(await ppImages(p.id,PP_OWNER_MEDIA_BASE)).portfolio});
 }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
});
app.delete('/api/me/professional-profile/portfolio/:imageId',auth,active,ppCap,async(req,res)=>{
 try{
  const p=await ppMine(req.user.id);
  if(!p)return res.status(404).json({error:'Profile not found'});
  const r=await q(`UPDATE professional_portfolio_images SET status='removed',removed_at=NOW() WHERE id=$1 AND professional_profile_id=$2 AND kind='portfolio' AND status='active' RETURNING id`,[req.params.imageId,p.id]);
  if(!r.rows.length)return res.status(404).json({error:'Photo not found'});
  res.json({ok:true});
 }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
});

// ── Public API — only status='active' profiles of active capability holders ──
const PP_PUBLIC_WHERE=`p.status='active' AND u.status='active' AND (u.capabilities->>'professional')='true'`;
function ppPublicView(p,images){
 return{id:p.id,display_name:p.display_name,hapa_verified:true,is_verified:p.is_verified===true,
  verified_category:p.verified_category,headline:p.headline,service_description:p.service_description,
  skills:p.skills,county:p.county,town:p.town,service_area:p.service_area,availability:p.availability,
  starting_price:p.starting_price,pricing_unit:p.pricing_unit,
  phone:p.phone_visible&&p.phone?p.phone:null,whatsapp:p.whatsapp_visible&&p.phone?p.phone:null,
  profile_photo:images.profilePhoto,portfolio:images.portfolio,member_since:p.created_at};
}
app.get('/api/public/professionals',async(req,res)=>{
 try{
  const vals=[];let where=PP_PUBLIC_WHERE;
  if(req.query.category){vals.push(String(req.query.category));where+=` AND p.verified_category ILIKE $${vals.length}`;}
  if(req.query.county){vals.push(String(req.query.county));where+=` AND p.county ILIKE $${vals.length}`;}
  if(req.query.q){vals.push('%'+String(req.query.q).slice(0,80)+'%');where+=` AND (p.display_name ILIKE $${vals.length} OR p.headline ILIKE $${vals.length} OR p.verified_category ILIKE $${vals.length} OR p.skills::text ILIKE $${vals.length} OR p.town ILIKE $${vals.length})`;}
  const rows=(await q(`SELECT p.*,u.phone,${isVerifiedExpr()} AS is_verified FROM professional_profiles p JOIN users u ON u.id=p.user_id WHERE ${where} ORDER BY p.published_at DESC NULLS LAST LIMIT 50`,vals)).rows;
  res.json(await Promise.all(rows.map(async p=>ppPublicView(p,await ppImages(p.id)))));
 }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
});
app.get('/api/public/professionals/:id',async(req,res)=>{
 try{
  const p=(await q(`SELECT p.*,u.phone,u.status AS user_status,${isVerifiedExpr()} AS is_verified FROM professional_profiles p JOIN users u ON u.id=p.user_id WHERE (p.id::text=$1 OR p.user_id::text=$1) AND ${PP_PUBLIC_WHERE}`,[req.params.id])).rows[0];
  if(!p)return res.status(404).json({error:'Professional not found'});
  res.json(ppPublicView(p,await ppImages(p.id)));
 }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
});
// Owner media bytes — the authenticated professional can always view their own
// images (draft/active/paused/owner_hidden). Never serves another user's media.
app.get('/api/me/professional-profile/media/:imageId',auth,active,ppCap,async(req,res)=>{
 try{
  const im=(await q(`SELECT i.storage_key,i.mime_type,i.sha256 FROM professional_portfolio_images i JOIN professional_profiles p ON p.id=i.professional_profile_id WHERE i.id::text=$1 AND i.status='active' AND p.user_id=$2`,[req.params.imageId,req.user.id])).rows[0];
  if(!im)return res.status(404).json({error:'Image not found'});
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Cache-Control','private, max-age=300');
  const etag='"'+im.sha256.slice(0,32)+'"';
  res.setHeader('ETag',etag);
  if(req.headers['if-none-match']===etag)return res.status(304).end();
  const access=await pubMedia.getObjectAccess(im.storage_key,im.mime_type);
  if(access.kind==='signedUrl')return res.redirect(302,access.url);
  res.setHeader('Content-Type',im.mime_type);
  access.stream.on('error',()=>{if(!res.headersSent)res.status(404).json({error:'Image file missing'});});
  access.stream.pipe(res);
 }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
});

// Public media bytes — only while the owning profile is publicly visible
app.get('/api/public/professional-media/:imageId',async(req,res)=>{
 try{
  const im=(await q(`SELECT i.storage_key,i.mime_type,i.sha256 FROM professional_portfolio_images i JOIN professional_profiles p ON p.id=i.professional_profile_id JOIN users u ON u.id=p.user_id WHERE i.id=$1 AND i.status='active' AND ${PP_PUBLIC_WHERE}`,[req.params.imageId])).rows[0];
  if(!im)return res.status(404).json({error:'Image not found'});
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Cache-Control','public, max-age=300');
  const etag='"'+im.sha256.slice(0,32)+'"';
  res.setHeader('ETag',etag);
  if(req.headers['if-none-match']===etag)return res.status(304).end();
  const access=await pubMedia.getObjectAccess(im.storage_key,im.mime_type);
  if(access.kind==='signedUrl')return res.redirect(302,access.url);
  res.setHeader('Content-Type',im.mime_type);
  access.stream.on('error',()=>{if(!res.headersSent)res.status(404).json({error:'Image file missing'});});
  access.stream.pipe(res);
 }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
});

// ── Owner moderation — hides only the public profile; never touches role,
// capabilities or the verified application. ─────────────────────────────────
app.get('/api/owner/professional-profiles',auth,owner,async(req,res)=>{
 try{
  const rows=(await q(`SELECT p.*,u.name AS account_name,u.email,u.status AS user_status FROM professional_profiles p JOIN users u ON u.id=p.user_id ORDER BY p.updated_at DESC LIMIT 200`)).rows;
  res.json(rows.map(p=>({...ppSafe(p),moderation_note:p.moderation_note,account_name:p.account_name,email:p.email,user_status:p.user_status,user_id:p.user_id})));
 }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
});
app.get('/api/owner/professional-profiles/:id',auth,owner,async(req,res)=>{
 try{
  const p=(await q(`SELECT p.*,u.name AS account_name,u.email,u.status AS user_status FROM professional_profiles p JOIN users u ON u.id=p.user_id WHERE p.id=$1`,[req.params.id])).rows[0];
  if(!p)return res.status(404).json({error:'Profile not found'});
  const im=await ppImages(p.id);
  res.json({...ppSafe(p),moderation_note:p.moderation_note,account_name:p.account_name,email:p.email,user_status:p.user_status,user_id:p.user_id,profile_photo:im.profilePhoto,portfolio:im.portfolio});
 }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
});
app.patch('/api/owner/professional-profiles/:id/status',auth,owner,async(req,res)=>{
 try{
  const{status,moderation_note}=req.body||{};
  if(!['owner_hidden','active'].includes(status))return res.status(400).json({error:'status must be owner_hidden or active'});
  const p=(await q(`SELECT * FROM professional_profiles WHERE id=$1`,[req.params.id])).rows[0];
  if(!p)return res.status(404).json({error:'Profile not found'});
  if(status==='owner_hidden'&&p.status==='owner_hidden')return res.status(409).json({error:'Already hidden'});
  if(status==='active'&&p.status!=='owner_hidden')return res.status(409).json({error:'Profile is not hidden'});
  // Restore returns the profile to the status it had BEFORE hiding (draft/paused/
  // active) — owner moderation must never publish a previously non-public profile.
  const restoreTo=['draft','active','paused'].includes(p.status_before_hidden)?p.status_before_hidden:'paused';
  const newStatus=status==='owner_hidden'?'owner_hidden':restoreTo;
  const r=(await q(`UPDATE professional_profiles SET status=$2,moderation_note=$3,updated_at=NOW(),
    status_before_hidden=CASE WHEN $2='owner_hidden' THEN $5 ELSE NULL END,
    hidden_at=CASE WHEN $2='owner_hidden' THEN NOW() ELSE NULL END,
    hidden_by=CASE WHEN $2='owner_hidden' THEN $4::uuid ELSE NULL END
    WHERE id=$1 RETURNING *`,[p.id,newStatus,moderation_note?String(moderation_note).slice(0,500):null,req.user.id,p.status])).rows[0];
  await audit(req.user.id,status==='owner_hidden'?'hide_professional_profile':'restore_professional_profile','professional_profile',p.id,moderation_note);
  res.json({...ppSafe(r),moderation_note:r.moderation_note});
 }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
});

// ── MVP modules: account, merchant, driver, unified requests/reviews/reports ─
const pm=require('./lib/providerMedia').init({q,auth,active});
pm.registerRoutes(app);
const moduleDeps={q,pool,auth,active,owner,docUpload,pm,audit,isVerifiedExpr,bcrypt,tok,safe,email,phone,strong,uploadLimiter,writeLimiter};
require('./routes/account')(app,moduleDeps);
require('./routes/merchant')(app,moduleDeps);
require('./routes/driver')(app,moduleDeps);
require('./routes/requests')(app,moduleDeps);

app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public/index.html')));
boot().then(()=>app.listen(PORT,'0.0.0.0',()=>console.log('HAPA v1.6 running on '+PORT))).catch(e=>{console.error(e);process.exit(1)});
