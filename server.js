const express=require('express'),path=require('path'),fs=require('fs'),bcrypt=require('bcryptjs'),jwt=require('jsonwebtoken');
const {Pool}=require('pg');
const rateLimit=require('express-rate-limit');
const app=express(),PORT=+process.env.PORT||10000;
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.NODE_ENV==='production'?{rejectUnauthorized:false}:false});
const q=(t,p=[])=>pool.query(t,p), secret=process.env.JWT_SECRET||'CHANGE_ME', authMode=process.env.AUTH_MODE||'demo';

// ── Production safety gate ────────────────────────────────────────────────────
if(process.env.NODE_ENV==='production'){
 if(!process.env.JWT_SECRET||process.env.JWT_SECRET==='CHANGE_ME'){
  console.error('FATAL: JWT_SECRET must be set to a strong secret in production. Exiting.');
  process.exit(1);
 }
}

app.set('trust proxy',1);
app.use(express.json({limit:'10mb'}));
app.use(express.static(path.join(__dirname,'public')));

// ── Rate limiters ─────────────────────────────────────────────────────────────
const authLimiter=rateLimit({windowMs:15*60*1000,max:10,standardHeaders:true,legacyHeaders:false,message:{error:'Too many attempts. Please try again in 15 minutes.'}});
const otpLimiter=rateLimit({windowMs:10*60*1000,max:3,standardHeaders:true,legacyHeaders:false,message:{error:'Too many code requests. Please try again in 10 minutes.'}});

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

async function auth(req,res,next){try{let h=req.headers.authorization||'';let d=jwt.verify(h.slice(7),secret,{issuer:'hapa'});let r=await q('SELECT * FROM users WHERE id=$1',[d.sub]);if(!r.rowCount||r.rows[0].status==='blocked')throw 0;req.user=r.rows[0];next()}catch{res.status(401).json({error:'Login required'})}}
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

// ── Core ──────────────────────────────────────────────────────────────────────
app.get('/api/health',async(req,res)=>{await q('SELECT 1');res.json({ok:true,version:'1.6.0'})});

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

// ── Upgrades ──────────────────────────────────────────────────────────────────
app.post('/api/upgrades',auth,active,async(req,res)=>{
 let t=String(req.body.type||''),d=req.body.details||{};
 if(!['driver','merchant','professional'].includes(t))return res.status(400).json({error:'Invalid type'});
 let need=t==='driver'?['licenceNumber','licenceImage','vehicleRegistration','insuranceImage','insuranceExpiry','vehiclePhoto']:t==='merchant'?['businessName','businessCategory','businessAddress','storePhoto']:['profession','skills','location','profilePhoto'];
 if(need.some(k=>!d[k]))return res.status(400).json({error:'Required information/documents missing'});
 let r=await q(`INSERT INTO upgrade_applications(user_id,type,details) VALUES($1,$2,$3) RETURNING *`,[req.user.id,t,d]);
 res.status(201).json(r.rows[0]);
});

// ── Public Marketplace (no auth required — safe data only) ────────────────────
app.get('/api/public/marketplace',async(req,res)=>{
 try{
  const{q:sq,category,condition,location,min_price,max_price,sort='newest',page=1,limit=20}=req.query;
  const lim=Math.min(+limit||20,100),off=(Math.max(+page||1,1)-1)*lim;
  const wp=[],w=[`ml.status='active'`];
  if(sq){wp.push(`%${sq}%`);const n=wp.length;w.push(`(ml.title ILIKE $${n} OR ml.description ILIKE $${n} OR ml.category ILIKE $${n} OR ml.location ILIKE $${n})`)}
  if(category){wp.push(category);w.push(`ml.category=$${wp.length}`)}
  if(condition){wp.push(condition);w.push(`ml.condition=$${wp.length}`)}
  if(location){wp.push(`%${location}%`);w.push(`ml.location ILIKE $${wp.length}`)}
  if(min_price&&+min_price>=0){wp.push(+min_price);w.push(`ml.price>=$${wp.length}`)}
  if(max_price&&+max_price>0){wp.push(+max_price);w.push(`ml.price<=$${wp.length}`)}
  const ws=w.join(' AND ');
  const ob={newest:'ml.created_at DESC',oldest:'ml.created_at ASC',price_asc:'ml.price ASC',price_desc:'ml.price DESC',most_viewed:'ml.views_count DESC'}[sort]||'ml.created_at DESC';
  const tot=+(await q(`SELECT count(*)::int n FROM marketplace_listings ml WHERE ${ws}`,wp)).rows[0].n;
  const dp=[...wp,lim,off];const lN=dp.length-1,oN=dp.length;
  const rows=(await q(`SELECT ml.id,ml.title,ml.price,ml.category,ml.condition,ml.location,ml.status,ml.created_at,ml.views_count,ml.negotiable,ml.images->0 AS main_image,jsonb_array_length(ml.images)::int AS image_count,u.id AS seller_id,u.name AS seller_name,u.profile_photo_url AS seller_photo,${isVerifiedExpr()} AS is_verified FROM marketplace_listings ml JOIN users u ON u.id=ml.seller_id WHERE ${ws} ORDER BY ${ob} LIMIT $${lN} OFFSET $${oN}`,dp)).rows;
  res.json({data:rows,total:tot,page:+page,limit:lim,pages:Math.ceil(tot/lim)});
 }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
});

app.get('/api/public/marketplace/:id',async(req,res)=>{
 try{
  const r=await q(`SELECT ml.id,ml.title,ml.price,ml.category,ml.condition,ml.location,ml.status,ml.created_at,ml.updated_at,ml.views_count,ml.negotiable,ml.description,ml.images,jsonb_array_length(ml.images)::int AS image_count,u.id AS seller_id,u.name AS seller_name,u.profile_photo_url AS seller_photo,u.created_at AS seller_joined,(SELECT count(*)::int FROM marketplace_listings WHERE seller_id=u.id AND status='active') AS seller_listing_count,${isVerifiedExpr()} AS is_verified FROM marketplace_listings ml JOIN users u ON u.id=ml.seller_id WHERE ml.id=$1 AND ml.status NOT IN ('removed','hidden')`,[req.params.id]);
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
  const wp=[],w=[`ml.status='active'`];
  if(sq){wp.push(`%${sq}%`);const n=wp.length;w.push(`(ml.title ILIKE $${n} OR ml.description ILIKE $${n} OR ml.category ILIKE $${n} OR ml.location ILIKE $${n})`)}
  if(category){wp.push(category);w.push(`ml.category=$${wp.length}`)}
  if(condition){wp.push(condition);w.push(`ml.condition=$${wp.length}`)}
  if(location){wp.push(`%${location}%`);w.push(`ml.location ILIKE $${wp.length}`)}
  if(min_price&&+min_price>=0){wp.push(+min_price);w.push(`ml.price>=$${wp.length}`)}
  if(max_price&&+max_price>0){wp.push(+max_price);w.push(`ml.price<=$${wp.length}`)}
  const ws=w.join(' AND ');
  const ob={newest:'ml.created_at DESC',oldest:'ml.created_at ASC',price_asc:'ml.price ASC',price_desc:'ml.price DESC',most_viewed:'ml.views_count DESC'}[sort]||'ml.created_at DESC';
  const tot=+(await q(`SELECT count(*)::int n FROM marketplace_listings ml WHERE ${ws}`,wp)).rows[0].n;
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
 pendingReports:+(await q(`SELECT count(*) n FROM listing_reports WHERE status='pending'`)).rows[0].n
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

app.get('/api/owner/upgrades',auth,owner,async(req,res)=>res.json((await q(`SELECT a.*,u.name,u.email,u.phone FROM upgrade_applications a JOIN users u ON u.id=a.user_id ORDER BY a.created_at DESC`)).rows));
app.patch('/api/owner/upgrades/:id',auth,owner,async(req,res)=>{
 let s=req.body.status;
 if(!['approved','rejected'].includes(s))return res.status(400).json({error:'Invalid'});
 let r=await q(`UPDATE upgrade_applications SET status=$2,reviewed_at=NOW() WHERE id=$1 RETURNING *`,[req.params.id,s]);
 if(s==='approved')await q(`UPDATE users SET capabilities=jsonb_set(capabilities,ARRAY[$2],'true',true) WHERE id=$1`,[r.rows[0].user_id,r.rows[0].type]);
 res.json(r.rows[0]);
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

app.get('/api/owner/users/:id/upgrades',auth,owner,async(req,res)=>{
 try{
  const r=await q(`SELECT * FROM upgrade_applications WHERE user_id=$1 ORDER BY created_at DESC`,[req.params.id]);
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

app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public/index.html')));
boot().then(()=>app.listen(PORT,'0.0.0.0',()=>console.log('HAPA v1.6 running on '+PORT))).catch(e=>{console.error(e);process.exit(1)});
