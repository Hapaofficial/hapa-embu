const express = require('express');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');

const app = express();
const PORT = Number(process.env.PORT || 10000);
const JWT_SECRET = String(process.env.JWT_SECRET || '');
const OWNER_EMAIL = String(process.env.OWNER_EMAIL || '').trim().toLowerCase();
const OWNER_PASSWORD = String(process.env.OWNER_PASSWORD || '');
const OWNER_NAME = String(process.env.OWNER_NAME || 'HAPA Owner').trim();
const PAYMENT_MODE = String(process.env.PAYMENT_MODE || 'demo').toLowerCase();
const RECOVERY_MODE = String(process.env.RECOVERY_MODE || 'demo').toLowerCase();
const RESEND_API_KEY = String(process.env.RESEND_API_KEY || '');
const RESET_EMAIL_FROM = String(process.env.RESET_EMAIL_FROM || '');
const TWILIO_ACCOUNT_SID = String(process.env.TWILIO_ACCOUNT_SID || '');
const TWILIO_AUTH_TOKEN = String(process.env.TWILIO_AUTH_TOKEN || '');
const TWILIO_FROM_NUMBER = String(process.env.TWILIO_FROM_NUMBER || '');
const DATABASE_URL = String(process.env.DATABASE_URL || '');
const IS_PROD = process.env.NODE_ENV === 'production' || Boolean(process.env.RENDER);

const MPESA_CONFIGURED = Boolean(process.env.MPESA_CONSUMER_KEY && process.env.MPESA_CONSUMER_SECRET && process.env.MPESA_SHORTCODE && process.env.MPESA_PASSKEY && process.env.MPESA_CALLBACK_URL);
const CARD_CONFIGURED = Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PUBLISHABLE_KEY);

if (!DATABASE_URL) { console.error('DATABASE_URL is required.'); process.exit(1); }
if (JWT_SECRET.length < 32) { console.error('JWT_SECRET must be at least 32 characters.'); process.exit(1); }

const pool = new Pool({ connectionString: DATABASE_URL, ssl: false, max: 10, idleTimeoutMillis: 30000 });
const q = (text, params=[]) => pool.query(text, params);

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname,'public'), { etag:true, maxAge:'5m' }));

const authLimiter = rateLimit({ windowMs: 10*60*1000, limit: 60, standardHeaders:'draft-7', legacyHeaders:false });
app.use('/api/auth', authLimiter);

const cleanEmail=v=>String(v||'').trim().toLowerCase();
const cleanPhone=v=>{let x=String(v||'').trim().replace(/[\s()-]/g,''); if(x.startsWith('0'))x='+254'+x.slice(1); if(x.startsWith('254'))x='+'+x; return x};
const validPhone=v=>/^\+[1-9]\d{7,14}$/.test(cleanPhone(v));
const strongPassword=p=>typeof p==='string' && p.length>=12 && /[A-Z]/.test(p) && /[a-z]/.test(p) && /\d/.test(p);
const publicUser=u=>({ id:u.id,name:u.name,email:u.email,phone:u.phone,address:u.address,role:u.role,status:u.status,wallet:Number(u.wallet_balance||0),language:u.language,profilePhotoUrl:u.profile_photo_url,emailVerified:u.email_verified,privacy:u.privacy,notificationPrefs:u.notifications,createdAt:u.created_at });
const tokenFor=u=>jwt.sign({sub:u.id,role:u.role,email:u.email,tv:Number(u.token_version||0)},JWT_SECRET,{expiresIn:'7d',issuer:'hapa-embu'});
function setSession(res,u){ res.cookie('hapa_session',tokenFor(u),{httpOnly:true,secure:IS_PROD,sameSite:'lax',maxAge:7*24*60*60*1000,path:'/'}); }
function clearSession(res){ res.clearCookie('hapa_session',{httpOnly:true,secure:IS_PROD,sameSite:'lax',path:'/'}); }

async function auth(req,res,next){
  try{
    const bearer=(req.headers.authorization||'').startsWith('Bearer ')?req.headers.authorization.slice(7):'';
    const t=req.cookies.hapa_session||bearer;
    if(!t) return res.status(401).json({error:'Login required'});
    const d=jwt.verify(t,JWT_SECRET,{issuer:'hapa-embu'});
    const r=await q('SELECT * FROM users WHERE id=$1',[d.sub]);
    if(!r.rowCount || r.rows[0].status==='blocked') return res.status(401).json({error:'Account unavailable'});
    const u=r.rows[0];
    if(Number(d.tv||0)!==Number(u.token_version||0)) return res.status(401).json({error:'Session expired'});
    req.user=u; next();
  }catch{ clearSession(res); res.status(401).json({error:'Session expired'}); }
}
const ownerOnly=(req,res,next)=>req.user?.role==='owner'?next():res.status(403).json({error:'Owner access required'});


async function sendRecoveryCode(channel,destination,code){
  if(RECOVERY_MODE==='demo') return {sent:true,demo:true};
  if(channel==='email'){
    if(!RESEND_API_KEY||!RESET_EMAIL_FROM) throw new Error('Email recovery provider is not configured');
    const r=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${RESEND_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({from:RESET_EMAIL_FROM,to:[destination],subject:'HAPA password reset code',text:`Your HAPA password reset code is ${code}. It expires in 10 minutes.`})});
    if(!r.ok) throw new Error('Email delivery failed');
    return {sent:true};
  }
  if(channel==='phone'){
    if(!TWILIO_ACCOUNT_SID||!TWILIO_AUTH_TOKEN||!TWILIO_FROM_NUMBER) throw new Error('SMS recovery provider is not configured');
    const body=new URLSearchParams({To:destination,From:TWILIO_FROM_NUMBER,Body:`Your HAPA password reset code is ${code}. It expires in 10 minutes.`});
    const r=await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,{method:'POST',headers:{Authorization:'Basic '+Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64'),'Content-Type':'application/x-www-form-urlencoded'},body});
    if(!r.ok) throw new Error('SMS delivery failed');
    return {sent:true};
  }
  throw new Error('Invalid recovery channel');
}

async function migrate(){
  const sql=fs.readFileSync(path.join(__dirname,'database','schema.sql'),'utf8');
  await q(sql);
  const cnt=await q('SELECT COUNT(*)::int c FROM users');
  if(cnt.rows[0].c===0) await importLegacyJson();
  let owner=(await q("SELECT * FROM users WHERE role='owner' ORDER BY created_at LIMIT 1")).rows[0];
  if(!owner && OWNER_EMAIL && strongPassword(OWNER_PASSWORD)){
    const hash=await bcrypt.hash(OWNER_PASSWORD,12);
    const r=await q(`INSERT INTO users(name,email,role,status,password_hash,email_verified) VALUES($1,$2,'owner','active',$3,true) RETURNING *`,[OWNER_NAME,OWNER_EMAIL,hash]);
    owner=r.rows[0]; console.log('Owner account created from Render environment variables.');
  }
  if(!owner) console.warn('Owner not configured. Add OWNER_EMAIL and a strong OWNER_PASSWORD in Render.');
  await q(`UPDATE settings SET data=jsonb_set(data,'{payments,mode}',to_jsonb($1::text),true),updated_at=NOW() WHERE id=1`,[PAYMENT_MODE]);
}

async function importLegacyJson(){
  const legacy=path.join(__dirname,'data','db.json');
  if(!fs.existsSync(legacy)) return;
  try{
    const d=JSON.parse(fs.readFileSync(legacy,'utf8'));
    if(d.settings) await q('UPDATE settings SET data=$1::jsonb,updated_at=NOW() WHERE id=1',[JSON.stringify(d.settings)]);
    for(const u of (d.users||[])){
      if(!u.email || !u.passwordHash) continue;
      await q(`INSERT INTO users(id,name,email,phone,address,role,status,password_hash,token_version,wallet_balance,language,notifications,created_at,updated_at)
        VALUES(CASE WHEN $1::text ~ '^[0-9a-fA-F-]{36}$' THEN $1::uuid ELSE gen_random_uuid() END,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,COALESCE($13::timestamptz,NOW()),NOW()) ON CONFLICT(email) DO NOTHING`,
        [u.id||'',u.name||'User',cleanEmail(u.email),u.phone||'',u.address||'',u.role||'customer',u.status||'active',u.passwordHash,Number(u.tokenVersion||0),Number(u.wallet||0),u.language||'en',JSON.stringify(u.notificationPrefs||{}),u.createdAt||null]);
    }
    console.log('Legacy JSON data migration completed.');
  }catch(e){ console.warn('Legacy migration skipped:',e.message); }
}

app.get('/api/health',async(req,res)=>{ await q('SELECT 1'); const c=await q('SELECT COUNT(*)::int users FROM users'); res.json({ok:true,service:'HAPA',version:'1.5.0',database:'postgres',users:c.rows[0].users,paymentMode:PAYMENT_MODE,providers:{wallet:true,mpesaConfigured:MPESA_CONFIGURED,cardConfigured:CARD_CONFIGURED}}); });

app.post('/api/auth/register',async(req,res)=>{
  try{
    const {name,email,password,phone,role='customer',application={}}=req.body||{};
    const allowed=['customer','driver','merchant','partner'];
    const em=cleanEmail(email), ph=cleanPhone(phone);
    if(!String(name||'').trim()||(!em&&!ph)||!strongPassword(password)) return res.status(400).json({error:'Name, email or phone, and strong password are required'});
    if(em && !em.includes('@')) return res.status(400).json({error:'Invalid email'});
    if(ph && !validPhone(ph)) return res.status(400).json({error:'Invalid phone number'});
    if(!allowed.includes(role)) return res.status(400).json({error:'Invalid account type'});
    const hash=await bcrypt.hash(password,12),status=role==='customer'?'active':'pending';
    if(ph){const dup=await q(`SELECT 1 FROM users WHERE phone=$1 LIMIT 1`,[ph]);if(dup.rowCount)return res.status(409).json({error:'Phone number already in use'});}
    const r=await q(`INSERT INTO users(name,email,phone,role,status,password_hash) VALUES($1,NULLIF($2,''),$3,$4,$5,$6) RETURNING *`,[String(name).trim(),em,ph,role,status,hash]);
    const u=r.rows[0];
    if(role!=='customer') await q(`INSERT INTO applications(user_id,type,details) VALUES($1,$2,$3::jsonb)`,[u.id,role,JSON.stringify(application||{})]);
    setSession(res,u); res.status(201).json({user:publicUser(u),message:role==='customer'?'Account created':'Application submitted for owner approval'});
  }catch(e){ if(e.code==='23505')return res.status(409).json({error:'Account already exists'}); console.error(e);res.status(500).json({error:'Registration failed'}); }
});

app.post('/api/auth/login',async(req,res)=>{
  const identifier=String(req.body?.identifier||req.body?.email||'').trim(), email=cleanEmail(identifier), phone=cleanPhone(identifier);
  const r=identifier.includes('@')?await q('SELECT * FROM users WHERE email=$1',[email]):await q('SELECT * FROM users WHERE phone=$1',[phone]); const u=r.rows[0];
  const ok=u&&await bcrypt.compare(String(req.body?.password||''),u.password_hash);
  await q(`INSERT INTO login_history(user_id,attempted_email,ip,user_agent,success) VALUES($1,$2,$3,$4,$5)`,[u?.id||null,identifier,req.ip,String(req.headers['user-agent']||'').slice(0,500),!!ok]).catch(()=>{});
  if(!ok)return res.status(401).json({error:'Wrong email/phone or password'});
  if(u.status==='blocked')return res.status(403).json({error:'Account blocked'});
  setSession(res,u);res.json({user:publicUser(u)});
});

app.post('/api/auth/forgot-password',async(req,res)=>{
  const identifier=String(req.body?.identifier||'').trim();
  const channel=identifier.includes('@')?'email':'phone';
  const destination=channel==='email'?cleanEmail(identifier):cleanPhone(identifier);
  const r=channel==='email'?await q('SELECT * FROM users WHERE email=$1',[destination]):await q('SELECT * FROM users WHERE phone=$1',[destination]);
  const generic={ok:true,message:'If an account matches, a reset code has been sent.'};
  if(!r.rowCount)return res.json(generic);
  const u=r.rows[0], code=String(Math.floor(100000+Math.random()*900000)), hash=await bcrypt.hash(code,10);
  await q(`UPDATE password_reset_codes SET used_at=NOW() WHERE user_id=$1 AND used_at IS NULL`,[u.id]);
  await q(`INSERT INTO password_reset_codes(user_id,channel,destination,code_hash,expires_at) VALUES($1,$2,$3,$4,NOW()+INTERVAL '10 minutes')`,[u.id,channel,destination,hash]);
  try{const sent=await sendRecoveryCode(channel,destination,code); return res.json({...generic,...(sent.demo?{demoCode:code}:{}),channel});}
  catch(e){console.error('Recovery delivery failed',e.message);return res.status(503).json({error:'Password recovery provider is not configured or unavailable'});}
});
app.post('/api/auth/reset-password',async(req,res)=>{
  const identifier=String(req.body?.identifier||'').trim(), code=String(req.body?.code||'').trim(), password=String(req.body?.newPassword||'');
  if(!/^\d{6}$/.test(code))return res.status(400).json({error:'Enter the 6-digit code'});
  if(!strongPassword(password))return res.status(400).json({error:'Password must have 12+ characters, uppercase, lowercase and a number'});
  const channel=identifier.includes('@')?'email':'phone', destination=channel==='email'?cleanEmail(identifier):cleanPhone(identifier);
  const ur=channel==='email'?await q('SELECT * FROM users WHERE email=$1',[destination]):await q('SELECT * FROM users WHERE phone=$1',[destination]);
  if(!ur.rowCount)return res.status(400).json({error:'Invalid or expired reset code'});
  const u=ur.rows[0], rr=await q(`SELECT * FROM password_reset_codes WHERE user_id=$1 AND channel=$2 AND destination=$3 AND used_at IS NULL AND expires_at>NOW() ORDER BY created_at DESC LIMIT 1`,[u.id,channel,destination]);
  if(!rr.rowCount)return res.status(400).json({error:'Invalid or expired reset code'});
  const rec=rr.rows[0]; if(rec.attempts>=5)return res.status(429).json({error:'Too many attempts. Request a new code.'});
  const ok=await bcrypt.compare(code,rec.code_hash); if(!ok){await q('UPDATE password_reset_codes SET attempts=attempts+1 WHERE id=$1',[rec.id]);return res.status(400).json({error:'Invalid or expired reset code'});}
  const hash=await bcrypt.hash(password,12), client=await pool.connect();
  try{await client.query('BEGIN');await client.query(`UPDATE users SET password_hash=$2,token_version=token_version+1,updated_at=NOW() WHERE id=$1`,[u.id,hash]);await client.query(`UPDATE password_reset_codes SET used_at=NOW() WHERE id=$1`,[rec.id]);await client.query('COMMIT');clearSession(res);res.json({ok:true,message:'Password changed. You can now log in.'});}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
});

app.post('/api/auth/logout',(req,res)=>{clearSession(res);res.json({ok:true});});
app.get('/api/me',auth,(req,res)=>res.json(publicUser(req.user)));

app.patch('/api/me/profile',auth,async(req,res)=>{
  const b=req.body||{},name=String(b.name||'').trim(); if(!name)return res.status(400).json({error:'Name is required'});
  const r=await q(`UPDATE users SET name=$2,phone=$3,address=$4,language=$5,profile_photo_url=$6,privacy=$7::jsonb,notifications=$8::jsonb,updated_at=NOW() WHERE id=$1 RETURNING *`,[req.user.id,name,String(b.phone||'').trim(),String(b.address||'').trim(),['en','sw'].includes(b.language)?b.language:'en',String(b.profilePhotoUrl||'').trim(),JSON.stringify(b.privacy||req.user.privacy||{}),JSON.stringify(b.notificationPrefs||req.user.notifications||{})]);
  res.json(publicUser(r.rows[0]));
});
app.post('/api/me/change-email',auth,async(req,res)=>{
  const e=cleanEmail(req.body?.newEmail); if(!e.includes('@'))return res.status(400).json({error:'Invalid email'});
  if(!await bcrypt.compare(String(req.body?.currentPassword||''),req.user.password_hash))return res.status(401).json({error:'Current password is incorrect'});
  try{await q(`UPDATE users SET email=$2,token_version=token_version+1,email_verified=false,updated_at=NOW() WHERE id=$1`,[req.user.id,e]);clearSession(res);res.json({ok:true,message:'Email changed. Please log in again.'});}catch(x){if(x.code==='23505')return res.status(409).json({error:'Email already in use'});throw x;}
});
app.post('/api/me/change-password',auth,async(req,res)=>{
  const cur=String(req.body?.currentPassword||''),n=String(req.body?.newPassword||''); if(!strongPassword(n))return res.status(400).json({error:'Password must have 12+ characters, uppercase, lowercase and a number'});
  if(!await bcrypt.compare(cur,req.user.password_hash))return res.status(401).json({error:'Current password is incorrect'});
  const hash=await bcrypt.hash(n,12);await q(`UPDATE users SET password_hash=$2,token_version=token_version+1,updated_at=NOW() WHERE id=$1`,[req.user.id,hash]);clearSession(res);res.json({ok:true,message:'Password changed. Please log in again.'});
});
app.post('/api/me/logout-all',auth,async(req,res)=>{await q('UPDATE users SET token_version=token_version+1 WHERE id=$1',[req.user.id]);clearSession(res);res.json({ok:true});});
app.get('/api/me/login-history',auth,async(req,res)=>{const r=await q(`SELECT id,ip,user_agent,success,created_at FROM login_history WHERE user_id=$1 ORDER BY created_at DESC LIMIT 30`,[req.user.id]);res.json(r.rows);});

app.get('/api/settings/public',async(req,res)=>{const r=await q('SELECT data FROM settings WHERE id=1');const s=r.rows[0].data;res.json({appName:s.appName,tagline:s.tagline,currency:s.currency,language:s.language,supportEmail:s.supportEmail,supportPhone:s.supportPhone,servicePrices:s.servicePrices,paymentMethods:{wallet:!!s.payments.walletEnabled,mpesa:!!(s.payments.mpesaEnabled&&MPESA_CONFIGURED),card:!!(s.payments.cardEnabled&&CARD_CONFIGURED),cash:!!s.payments.cashEnabled},paymentMode:PAYMENT_MODE});});
app.get('/api/payments/status',auth,async(req,res)=>{const s=(await q('SELECT data FROM settings WHERE id=1')).rows[0].data;res.json({mode:PAYMENT_MODE,wallet:{enabled:!!s.payments.walletEnabled,configured:true},mpesa:{enabled:!!s.payments.mpesaEnabled,configured:MPESA_CONFIGURED},card:{enabled:!!s.payments.cardEnabled,configured:CARD_CONFIGURED},cash:{enabled:!!s.payments.cashEnabled,configured:true}});});

app.post('/api/wallet/topup',auth,async(req,res)=>{
  const amount=Number(req.body?.amount),method=String(req.body?.method||'demo'); if(!Number.isFinite(amount)||amount<10||amount>150000)return res.status(400).json({error:'Amount must be between KES 10 and 150,000'});
  if(PAYMENT_MODE!=='demo')return res.status(501).json({error:'Live payment callbacks are not active yet'});
  const ref=`HAPA-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;const client=await pool.connect();
  try{await client.query('BEGIN');const u=await client.query(`UPDATE users SET wallet_balance=wallet_balance+$2,updated_at=NOW() WHERE id=$1 RETURNING wallet_balance`,[req.user.id,amount]);await client.query(`INSERT INTO transactions(user_id,type,method,amount,status,reference,description,metadata) VALUES($1,'topup',$2,$3,'completed',$4,'Demo top-up','{"demo":true}'::jsonb)`,[req.user.id,method,amount,ref]);await client.query('COMMIT');res.json({wallet:Number(u.rows[0].wallet_balance),message:'Test payment completed. No real money was charged.'});}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
});
app.post('/api/wallet/pay',auth,async(req,res)=>{
  const amount=Number(req.body?.amount),desc=String(req.body?.description||'HAPA payment');if(!Number.isFinite(amount)||amount<=0)return res.status(400).json({error:'Invalid amount'});const client=await pool.connect();
  try{await client.query('BEGIN');const lock=await client.query('SELECT wallet_balance FROM users WHERE id=$1 FOR UPDATE',[req.user.id]);if(Number(lock.rows[0].wallet_balance)<amount){await client.query('ROLLBACK');return res.status(400).json({error:'Insufficient HAPA Wallet balance'});}const u=await client.query('UPDATE users SET wallet_balance=wallet_balance-$2,updated_at=NOW() WHERE id=$1 RETURNING wallet_balance',[req.user.id,amount]);await client.query(`INSERT INTO transactions(user_id,type,method,amount,status,reference,description) VALUES($1,'payment','wallet',$2,'completed',$3,$4)`,[req.user.id,-amount,`HAPA-PAY-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,desc]);await client.query('COMMIT');res.json({wallet:Number(u.rows[0].wallet_balance)});}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
});
app.get('/api/wallet/transactions',auth,async(req,res)=>{const r=await q(`SELECT id,type,method,amount,status,reference,description,created_at AS "createdAt" FROM transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100`,[req.user.id]);res.json(r.rows.map(x=>({...x,amount:Number(x.amount)})));});

app.post('/api/rides',auth,async(req,res)=>{const type=['boda','car','courier'].includes(req.body?.type)?req.body.type:'boda',pickup=String(req.body?.pickup||'').trim(),destination=String(req.body?.destination||'').trim();if(!pickup||!destination)return res.status(400).json({error:'Pickup and destination required'});const s=(await q('SELECT data FROM settings WHERE id=1')).rows[0].data;const r=await q(`INSERT INTO rides(customer_id,ride_type,pickup_text,destination_text,fare_estimate) VALUES($1,$2,$3,$4,$5) RETURNING id,ride_type AS type,pickup_text AS pickup,destination_text AS destination,fare_estimate AS price,status,created_at AS "createdAt"`,[req.user.id,type,pickup,destination,Number(s.servicePrices[type]||150)]);r.rows[0].price=Number(r.rows[0].price);res.status(201).json(r.rows[0]);});
app.get('/api/rides/mine',auth,async(req,res)=>{const r=await q(`SELECT id,ride_type AS type,pickup_text AS pickup,destination_text AS destination,fare_estimate AS price,status,created_at AS "createdAt" FROM rides WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 50`,[req.user.id]);res.json(r.rows.map(x=>({...x,price:Number(x.price)})));});
app.post('/api/orders',auth,async(req,res)=>{const items=Array.isArray(req.body?.items)?req.body.items:[],total=Number(req.body?.total||0);if(total<0)return res.status(400).json({error:'Invalid total'});const r=await q(`INSERT INTO orders(customer_id,merchant_name,items,total) VALUES($1,$2,$3::jsonb,$4) RETURNING id,merchant_name AS merchant,items,total,status,created_at AS "createdAt"`,[req.user.id,String(req.body?.merchant||'HAPA Demo Kitchen'),JSON.stringify(items),total]);r.rows[0].total=Number(r.rows[0].total);res.status(201).json(r.rows[0]);});
app.get('/api/orders/mine',auth,async(req,res)=>{const r=await q(`SELECT id,merchant_name AS merchant,items,total,status,created_at AS "createdAt" FROM orders WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 50`,[req.user.id]);res.json(r.rows.map(x=>({...x,total:Number(x.total)})));});

app.get('/api/owner/dashboard',auth,ownerOnly,async(req,res)=>{const [u,a,r,o,t]=await Promise.all([q(`SELECT COUNT(*)::int users,COUNT(*) FILTER(WHERE role='customer')::int customers,COUNT(*) FILTER(WHERE role='driver')::int drivers,COUNT(*) FILTER(WHERE role='merchant')::int merchants,COUNT(*) FILTER(WHERE role='partner')::int partners,COUNT(*) FILTER(WHERE status='pending')::int pending FROM users`),q(`SELECT COUNT(*)::int applications FROM applications WHERE status='pending'`),q('SELECT COUNT(*)::int rides FROM rides'),q('SELECT COUNT(*)::int orders FROM orders'),q(`SELECT COUNT(*)::int transactions,COALESCE(SUM(CASE WHEN amount>0 THEN amount ELSE 0 END),0)::numeric wallet_volume FROM transactions`)]);res.json({...u.rows[0],pendingApplications:a.rows[0].applications,rides:r.rows[0].rides,orders:o.rows[0].orders,transactions:t.rows[0].transactions,walletVolume:Number(t.rows[0].wallet_volume)});});
app.get('/api/owner/users',auth,ownerOnly,async(req,res)=>{const r=await q(`SELECT id,name,email,phone,role,status,wallet_balance AS wallet,email_verified AS "emailVerified",created_at AS "createdAt" FROM users ORDER BY created_at DESC`);res.json(r.rows.map(x=>({...x,wallet:Number(x.wallet)})));});
app.patch('/api/owner/users/:id',auth,ownerOnly,async(req,res)=>{if(!['active','pending','blocked'].includes(req.body?.status))return res.status(400).json({error:'Invalid status'});const r=await q(`UPDATE users SET status=$2,updated_at=NOW() WHERE id=$1 AND role<>'owner' RETURNING id,name,email,role,status`,[req.params.id,req.body.status]);if(!r.rowCount)return res.status(404).json({error:'User not found'});res.json(r.rows[0]);});
app.get('/api/owner/applications',auth,ownerOnly,async(req,res)=>{const r=await q(`SELECT a.*,u.name,u.email,u.phone FROM applications a JOIN users u ON u.id=a.user_id ORDER BY a.created_at DESC`);res.json(r.rows);});
app.patch('/api/owner/applications/:id',auth,ownerOnly,async(req,res)=>{const status=req.body?.status;if(!['approved','rejected'].includes(status))return res.status(400).json({error:'Invalid status'});const r=await q(`UPDATE applications SET status=$2,owner_note=$3,reviewed_at=NOW() WHERE id=$1 RETURNING *`,[req.params.id,status,String(req.body?.ownerNote||'')]);if(!r.rowCount)return res.status(404).json({error:'Application not found'});await q(`UPDATE users SET status=$2,updated_at=NOW() WHERE id=$1`,[r.rows[0].user_id,status==='approved'?'active':'blocked']);res.json(r.rows[0]);});
app.get('/api/owner/settings',auth,ownerOnly,async(req,res)=>{const s=(await q('SELECT data FROM settings WHERE id=1')).rows[0].data;res.json({...s,providerStatus:{mpesaConfigured:MPESA_CONFIGURED,cardConfigured:CARD_CONFIGURED,paymentMode:PAYMENT_MODE}});});
app.patch('/api/owner/settings',auth,ownerOnly,async(req,res)=>{const old=(await q('SELECT data FROM settings WHERE id=1')).rows[0].data,b=req.body||{};const s={...old,appName:String(b.appName||old.appName).trim().slice(0,40),tagline:String(b.tagline||old.tagline).trim().slice(0,120),supportEmail:cleanEmail(b.supportEmail),supportPhone:String(b.supportPhone||'').trim().slice(0,30),businessAddress:String(b.businessAddress||'').trim().slice(0,160),currency:['KES','USD'].includes(b.currency)?b.currency:old.currency,timezone:['Africa/Nairobi','America/New_York'].includes(b.timezone)?b.timezone:old.timezone,language:['en','sw'].includes(b.language)?b.language:old.language,platformFeePct:Math.min(40,Math.max(0,Number(b.platformFeePct||0))),servicePrices:{boda:Math.max(0,Number(b.servicePrices?.boda||0)),car:Math.max(0,Number(b.servicePrices?.car||0)),courier:Math.max(0,Number(b.servicePrices?.courier||0))},payments:{...old.payments,walletEnabled:!!b.payments?.walletEnabled,mpesaEnabled:!!b.payments?.mpesaEnabled,cardEnabled:!!b.payments?.cardEnabled,cashEnabled:!!b.payments?.cashEnabled,mode:PAYMENT_MODE}};await q('UPDATE settings SET data=$1::jsonb,updated_at=NOW() WHERE id=1',[JSON.stringify(s)]);res.json(s);});

app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
migrate().then(()=>app.listen(PORT,'0.0.0.0',()=>console.log(`HAPA v1.5 running on port ${PORT} with PostgreSQL`))).catch(e=>{console.error('Startup failed',e);process.exit(1)});
