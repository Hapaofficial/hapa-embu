const express=require('express'),path=require('path'),fs=require('fs'),bcrypt=require('bcryptjs'),jwt=require('jsonwebtoken');
const {Pool}=require('pg'); const app=express(),PORT=+process.env.PORT||10000;
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.NODE_ENV==='production'?{rejectUnauthorized:false}:false});
const q=(t,p=[])=>pool.query(t,p), secret=process.env.JWT_SECRET||'CHANGE_ME', authMode=process.env.AUTH_MODE||'demo';
app.set('trust proxy',1); app.use(express.json({limit:'3mb'})); app.use(express.static(path.join(__dirname,'public')));
const email=v=>String(v||'').trim().toLowerCase()||null;
const phone=v=>{let s=String(v||'').replace(/[^\d+]/g,'');if(!s)return null;if(s.startsWith('0'))s='+254'+s.slice(1);if(s.startsWith('254'))s='+'+s;return s};
const strong=p=>String(p||'').length>=10&&/[A-Za-z]/.test(p)&&/\d/.test(p);
const safe=u=>({id:u.id,name:u.name,email:u.email,phone:u.phone,role:u.role,status:u.status,wallet:+u.wallet_balance||0,
 profilePhotoUrl:u.profile_photo_url,emailVerified:u.email_verified,phoneVerified:u.phone_verified,capabilities:u.capabilities||{}});
const tok=u=>jwt.sign({sub:u.id,tv:+u.token_version||0},secret,{expiresIn:'7d',issuer:'hapa'});
async function auth(req,res,next){try{let h=req.headers.authorization||'';let d=jwt.verify(h.slice(7),secret,{issuer:'hapa'});let r=await q('SELECT * FROM users WHERE id=$1',[d.sub]);if(!r.rowCount||r.rows[0].status==='blocked'||+d.tv!==+r.rows[0].token_version)throw 0;req.user=r.rows[0];next()}catch{res.status(401).json({error:'Login required'})}}
const owner=(req,res,next)=>req.user.role==='owner'?next():res.status(403).json({error:'Owner only'});
const active=(req,res,next)=>(req.user.role==='owner'||req.user.status==='active')?next():res.status(403).json({error:'Account not active'});
async function code(userId,channel,purpose){let c=String(Math.floor(100000+Math.random()*900000));await q(`INSERT INTO verification_codes(user_id,channel,purpose,code,expires_at) VALUES($1,$2,$3,$4,NOW()+interval '10 min')`,[userId,channel,purpose,c]);return c}

async function boot(){
 await q(fs.readFileSync(path.join(__dirname,'sql/schema.sql'),'utf8'));
 const primaryOwnerEmail=email(process.env.PRIMARY_OWNER_EMAIL||'Trader2027@protonmail.com');
 const moreenEmail='moreentrader@gmail.com';
 const ownerPassword=process.env.OWNER_PASSWORD||'';
 await q('BEGIN');
 try{
  // Exactly one Owner: Piotr's account. Every other old Owner is demoted.
  await q(`UPDATE users SET role='customer', status=CASE WHEN status='blocked' THEN 'blocked' ELSE 'active' END, token_version=token_version+1 WHERE role='owner' AND lower(coalesce(email,''))<>lower($1)`,[primaryOwnerEmail]);
  // Explicitly repair Moreen's existing account and invalidate any old Owner session.
  await q(`UPDATE users SET role='customer', status='active', token_version=token_version+1 WHERE lower(coalesce(email,''))=lower($1)`,[moreenEmail]);
  let r=await q(`SELECT * FROM users WHERE lower(coalesce(email,''))=lower($1) LIMIT 1`,[primaryOwnerEmail]);
  if(r.rowCount){
   await q(`UPDATE users SET role='owner',status='active',email_verified=true,phone_verified=true WHERE id=$1`,[r.rows[0].id]);
  }else if(strong(ownerPassword)){
   let h=await bcrypt.hash(ownerPassword,12);
   await q(`INSERT INTO users(name,email,role,status,password_hash,email_verified,phone_verified) VALUES($1,$2,'owner','active',$3,true,true)`,[process.env.OWNER_NAME||'HAPA Owner',primaryOwnerEmail,h]);
  }else{
   throw new Error('Primary Owner account missing and OWNER_PASSWORD is not configured');
  }
  await q('COMMIT');
 }catch(e){await q('ROLLBACK');throw e}
}
app.get('/api/health',async(req,res)=>{await q('SELECT 1');res.json({ok:true,version:'1.6.0'})});
app.post('/api/auth/register',async(req,res)=>{
 try{
  let n=String(req.body.name||'').trim(),e=email(req.body.email),p=phone(req.body.phone),pw=String(req.body.password||''),selfie=String(req.body.selfie||'');
  if(!n||(!e&&!p)||!strong(pw)||!selfie)return res.status(400).json({error:'Name, phone or email, password and selfie required'});
  if(e&&(await q('SELECT 1 FROM users WHERE lower(email)=lower($1)',[e])).rowCount)return res.status(409).json({error:'Email already used'});
  if(p&&(await q('SELECT 1 FROM users WHERE phone=$1',[p])).rowCount)return res.status(409).json({error:'Phone already used'});
  let h=await bcrypt.hash(pw,12),r=await q(`INSERT INTO users(name,email,phone,role,status,password_hash,profile_photo_url) VALUES($1,$2,$3,'customer','pending',$4,$5) RETURNING *`,[n,e,p,h,selfie]),u=r.rows[0];
  await q(`INSERT INTO access_requests(user_id) VALUES($1)`,[u.id]); let ch=p?'phone':'email',c=await code(u.id,ch,'verify');
  res.status(201).json({token:tok(u),user:safe(u),channel:ch,demoCode:authMode==='demo'?c:undefined});
 }catch(e){console.error(e);res.status(500).json({error:'Registration failed'})}
});
app.post('/api/auth/login',async(req,res)=>{
 let id=String(req.body.identifier||'').trim(),e=email(id),p=phone(id),r=await q(`SELECT * FROM users WHERE lower(coalesce(email,''))=lower($1) OR phone=$2 LIMIT 1`,[e||'',p||'']),u=r.rows[0];
 if(!u||!await bcrypt.compare(String(req.body.password||''),u.password_hash))return res.status(401).json({error:'Wrong login or password'});
 if(u.status==='blocked')return res.status(403).json({error:'Account blocked'});res.json({token:tok(u),user:safe(u)})
});
app.post('/api/auth/verify',auth,async(req,res)=>{
 let r=await q(`SELECT * FROM verification_codes WHERE user_id=$1 AND purpose='verify' AND used_at IS NULL AND expires_at>NOW() ORDER BY expires_at DESC LIMIT 1`,[req.user.id]);
 if(!r.rowCount||r.rows[0].code!==String(req.body.code||''))return res.status(400).json({error:'Invalid code'});
 await q('UPDATE verification_codes SET used_at=NOW() WHERE id=$1',[r.rows[0].id]);
 await q(`UPDATE users SET ${r.rows[0].channel==='phone'?'phone_verified':'email_verified'}=true WHERE id=$1`,[req.user.id]);res.json({ok:true})
});
app.post('/api/auth/forgot',async(req,res)=>{
 let id=String(req.body.identifier||''),e=email(id),p=phone(id),r=await q(`SELECT * FROM users WHERE lower(coalesce(email,''))=lower($1) OR phone=$2 LIMIT 1`,[e||'',p||'']);
 if(!r.rowCount)return res.json({ok:true});let ch=p&&r.rows[0].phone===p?'phone':'email',c=await code(r.rows[0].id,ch,'reset');
 res.json({ok:true,demoCode:authMode==='demo'?c:undefined})
});
app.post('/api/auth/reset',async(req,res)=>{
 let id=String(req.body.identifier||''),e=email(id),p=phone(id),u=(await q(`SELECT * FROM users WHERE lower(coalesce(email,''))=lower($1) OR phone=$2 LIMIT 1`,[e||'',p||''])).rows[0];
 if(!u||!strong(req.body.newPassword))return res.status(400).json({error:'Invalid reset'});
 let c=(await q(`SELECT * FROM verification_codes WHERE user_id=$1 AND purpose='reset' AND used_at IS NULL AND expires_at>NOW() ORDER BY expires_at DESC LIMIT 1`,[u.id])).rows[0];
 if(!c||c.code!==String(req.body.code||''))return res.status(400).json({error:'Invalid code'});let h=await bcrypt.hash(req.body.newPassword,12);
 await q('UPDATE users SET password_hash=$2,token_version=token_version+1 WHERE id=$1',[u.id,h]);await q('UPDATE verification_codes SET used_at=NOW() WHERE id=$1',[c.id]);res.json({ok:true})
});
app.get('/api/me',auth,(req,res)=>res.json(safe(req.user)));
app.post('/api/me/request-again',auth,async(req,res)=>{if((await q(`SELECT 1 FROM access_requests WHERE user_id=$1 AND status='pending'`,[req.user.id])).rowCount)return res.status(409).json({error:'Already pending'});await q(`INSERT INTO access_requests(user_id) VALUES($1)`,[req.user.id]);await q(`UPDATE users SET status='pending' WHERE id=$1`,[req.user.id]);res.json({ok:true})});
app.post('/api/upgrades',auth,active,async(req,res)=>{
 let t=String(req.body.type||''),d=req.body.details||{};if(!['driver','merchant','professional'].includes(t))return res.status(400).json({error:'Invalid type'});
 let need=t==='driver'?['licenceNumber','licenceImage','vehicleRegistration','insuranceImage','insuranceExpiry','vehiclePhoto']:t==='merchant'?['businessName','businessCategory','businessAddress','storePhoto']:['profession','skills','location','profilePhoto'];
 if(need.some(k=>!d[k]))return res.status(400).json({error:'Required information/documents missing'});
 let r=await q(`INSERT INTO upgrade_applications(user_id,type,details) VALUES($1,$2,$3) RETURNING *`,[req.user.id,t,d]);res.status(201).json(r.rows[0])
});
app.get('/api/marketplace',auth,active,async(req,res)=>res.json((await q(`SELECT m.*,u.name seller_name FROM marketplace_listings m JOIN users u ON u.id=m.seller_id WHERE m.status='active' ORDER BY m.created_at DESC`)).rows));
app.post('/api/marketplace',auth,active,async(req,res)=>{let b=req.body||{};let r=await q(`INSERT INTO marketplace_listings(seller_id,title,price,category,condition,description,location,images) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[req.user.id,b.title,+b.price,b.category||'Other',b.condition||'Used',b.description||'',b.location||'Embu',b.images||[]]);res.status(201).json(r.rows[0])});
app.get('/api/owner/dashboard',auth,owner,async(req,res)=>res.json({users:+(await q('SELECT count(*) n FROM users')).rows[0].n,pendingAccess:+(await q(`SELECT count(*) n FROM access_requests WHERE status='pending'`)).rows[0].n,pendingUpgrades:+(await q(`SELECT count(*) n FROM upgrade_applications WHERE status='pending'`)).rows[0].n,marketplace:+(await q(`SELECT count(*) n FROM marketplace_listings WHERE status='active'`)).rows[0].n}));
app.get('/api/owner/access',auth,owner,async(req,res)=>res.json((await q(`SELECT a.*,u.name,u.email,u.phone,u.profile_photo_url FROM access_requests a JOIN users u ON u.id=a.user_id ORDER BY a.created_at DESC`)).rows));
app.patch('/api/owner/access/:id',auth,owner,async(req,res)=>{let s=req.body.status;if(!['approved','rejected'].includes(s))return res.status(400).json({error:'Invalid'});let r=await q(`UPDATE access_requests SET status=$2,reviewed_at=NOW() WHERE id=$1 RETURNING *`,[req.params.id,s]);if(!r.rowCount)return res.status(404).json({error:'Not found'});await q(`UPDATE users SET status=$2 WHERE id=$1`,[r.rows[0].user_id,s==='approved'?'active':'rejected']);res.json(r.rows[0])});
app.get('/api/owner/upgrades',auth,owner,async(req,res)=>res.json((await q(`SELECT a.*,u.name,u.email,u.phone FROM upgrade_applications a JOIN users u ON u.id=a.user_id ORDER BY a.created_at DESC`)).rows));
app.patch('/api/owner/upgrades/:id',auth,owner,async(req,res)=>{let s=req.body.status;if(!['approved','rejected'].includes(s))return res.status(400).json({error:'Invalid'});let r=await q(`UPDATE upgrade_applications SET status=$2,reviewed_at=NOW() WHERE id=$1 RETURNING *`,[req.params.id,s]);if(s==='approved')await q(`UPDATE users SET capabilities=jsonb_set(capabilities,ARRAY[$2],'true',true) WHERE id=$1`,[r.rows[0].user_id,r.rows[0].type]);res.json(r.rows[0])});
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public/index.html')));
boot().then(()=>app.listen(PORT,'0.0.0.0',()=>console.log('HAPA v1.6 running on '+PORT))).catch(e=>{console.error(e);process.exit(1)});
