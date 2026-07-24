const express = require('express');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 10000;
const JWT_SECRET = process.env.JWT_SECRET || 'CHANGE_ME_HAPA_SECRET_2026';
const DB_PATH = path.join(__dirname, 'data', 'db.json');
const OWNER_EMAIL = (process.env.OWNER_EMAIL || 'owner@hapa.co.ke').toLowerCase();
const OWNER_PASSWORD = process.env.OWNER_PASSWORD || 'HapaOwner2026!';

app.use(express.json({limit:'1mb'}));
app.use(express.static(path.join(__dirname, 'public')));

function loadDb(){
  try { return JSON.parse(fs.readFileSync(DB_PATH,'utf8')); }
  catch { return {users:[],transactions:[],orders:[],rides:[],settings:{currency:'KES',platformFeePct:10}}; }
}
function saveDb(db){ fs.mkdirSync(path.dirname(DB_PATH),{recursive:true}); fs.writeFileSync(DB_PATH, JSON.stringify(db,null,2)); }
function id(prefix='id'){ return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`; }
function publicUser(u){ const {passwordHash,...rest}=u; return rest; }
function tokenFor(u){ return jwt.sign({sub:u.id,role:u.role,email:u.email},JWT_SECRET,{expiresIn:'7d'}); }
function auth(req,res,next){
  const h=req.headers.authorization||''; const t=h.startsWith('Bearer ')?h.slice(7):null;
  if(!t) return res.status(401).json({error:'Login required'});
  try { req.auth=jwt.verify(t,JWT_SECRET); next(); } catch { res.status(401).json({error:'Session expired'}); }
}
function ownerOnly(req,res,next){ if(req.auth?.role!=='owner') return res.status(403).json({error:'Owner access required'}); next(); }

(function seedOwner(){
  const db=loadDb();
  if(!db.users.some(u=>u.role==='owner')){
    db.users.push({id:id('usr'),name:'HAPA Owner',email:OWNER_EMAIL,phone:'+254700000000',role:'owner',status:'active',wallet:0,passwordHash:bcrypt.hashSync(OWNER_PASSWORD,10),createdAt:new Date().toISOString()});
    saveDb(db);
  }
})();

app.get('/api/health',(req,res)=>res.json({ok:true,service:'HAPA',version:'1.0.0',payments:process.env.MPESA_CONSUMER_KEY?'mpesa-configured':'demo-mode'}));

app.post('/api/auth/register',(req,res)=>{
  const {name,email,password,phone,role='customer'}=req.body||{};
  const allowed=['customer','driver','merchant','partner'];
  if(!name||!email||!password) return res.status(400).json({error:'Name, email and password are required'});
  if(password.length<8) return res.status(400).json({error:'Password must have at least 8 characters'});
  if(!allowed.includes(role)) return res.status(400).json({error:'Invalid role'});
  const db=loadDb(); const clean=email.trim().toLowerCase();
  if(db.users.some(u=>u.email===clean)) return res.status(409).json({error:'Account already exists'});
  const user={id:id('usr'),name:name.trim(),email:clean,phone:phone||'',role,status:role==='customer'?'active':'pending',wallet:0,passwordHash:bcrypt.hashSync(password,10),createdAt:new Date().toISOString()};
  db.users.push(user); saveDb(db);
  res.status(201).json({token:tokenFor(user),user:publicUser(user),message:role==='customer'?'Account created':'Account created and awaiting owner approval'});
});

app.post('/api/auth/login',(req,res)=>{
  const {email,password}=req.body||{}; const db=loadDb();
  const user=db.users.find(u=>u.email===(email||'').trim().toLowerCase());
  if(!user||!bcrypt.compareSync(password||'',user.passwordHash)) return res.status(401).json({error:'Wrong email or password'});
  if(user.status==='blocked') return res.status(403).json({error:'Account blocked'});
  res.json({token:tokenFor(user),user:publicUser(user)});
});

app.get('/api/me',auth,(req,res)=>{ const u=loadDb().users.find(x=>x.id===req.auth.sub); if(!u)return res.status(404).json({error:'User not found'}); res.json(publicUser(u)); });

app.post('/api/wallet/topup',auth,(req,res)=>{
  const amount=Number(req.body?.amount); const method=req.body?.method||'mpesa';
  if(!Number.isFinite(amount)||amount<10||amount>150000) return res.status(400).json({error:'Amount must be between KES 10 and 150,000'});
  const db=loadDb(); const u=db.users.find(x=>x.id===req.auth.sub); if(!u)return res.status(404).json({error:'User not found'});
  const tx={id:id('tx'),userId:u.id,type:'topup',method,amount,status:'completed',reference:`HAPA${Date.now()}`,createdAt:new Date().toISOString(),demo:!process.env.MPESA_CONSUMER_KEY};
  u.wallet=Number(u.wallet||0)+amount; db.transactions.push(tx); saveDb(db);
  res.json({wallet:u.wallet,transaction:tx,message:tx.demo?'Demo payment completed. Add M-Pesa credentials in Render for real STK Push.':'Payment completed'});
});

app.post('/api/wallet/pay',auth,(req,res)=>{
  const amount=Number(req.body?.amount); const description=req.body?.description||'HAPA payment';
  const db=loadDb(); const u=db.users.find(x=>x.id===req.auth.sub);
  if(!u)return res.status(404).json({error:'User not found'});
  if(!Number.isFinite(amount)||amount<=0) return res.status(400).json({error:'Invalid amount'});
  if((u.wallet||0)<amount) return res.status(400).json({error:'Insufficient HAPA Wallet balance'});
  u.wallet-=amount; const tx={id:id('tx'),userId:u.id,type:'payment',method:'wallet',amount:-amount,status:'completed',description,reference:`HAPAPAY${Date.now()}`,createdAt:new Date().toISOString()}; db.transactions.push(tx); saveDb(db);
  res.json({wallet:u.wallet,transaction:tx});
});

app.get('/api/wallet/transactions',auth,(req,res)=>{ const db=loadDb(); res.json(db.transactions.filter(t=>t.userId===req.auth.sub).slice(-50).reverse()); });

app.post('/api/rides',auth,(req,res)=>{
  const {pickup,destination,type='boda',price}=req.body||{}; if(!pickup||!destination)return res.status(400).json({error:'Pickup and destination required'});
  const db=loadDb(); const ride={id:id('ride'),customerId:req.auth.sub,pickup,destination,type,price:Number(price)||150,status:'requested',createdAt:new Date().toISOString()}; db.rides.push(ride); saveDb(db); res.status(201).json(ride);
});
app.post('/api/orders',auth,(req,res)=>{
  const {merchant='HAPA Demo Kitchen',items=[],total=0}=req.body||{}; const db=loadDb(); const order={id:id('ord'),customerId:req.auth.sub,merchant,items,total:Number(total),status:'placed',createdAt:new Date().toISOString()}; db.orders.push(order); saveDb(db); res.status(201).json(order);
});

app.get('/api/owner/dashboard',auth,ownerOnly,(req,res)=>{
  const db=loadDb(); const totalVolume=db.transactions.filter(t=>t.status==='completed'&&t.amount>0).reduce((s,t)=>s+t.amount,0);
  res.json({users:db.users.length,customers:db.users.filter(u=>u.role==='customer').length,drivers:db.users.filter(u=>u.role==='driver').length,merchants:db.users.filter(u=>u.role==='merchant').length,pending:db.users.filter(u=>u.status==='pending').length,rides:db.rides.length,orders:db.orders.length,paymentVolume:totalVolume,transactions:db.transactions.length});
});
app.get('/api/owner/users',auth,ownerOnly,(req,res)=>res.json(loadDb().users.map(publicUser)));
app.patch('/api/owner/users/:id',auth,ownerOnly,(req,res)=>{
  const db=loadDb(); const u=db.users.find(x=>x.id===req.params.id); if(!u)return res.status(404).json({error:'User not found'});
  if(['active','pending','blocked'].includes(req.body?.status))u.status=req.body.status; saveDb(db); res.json(publicUser(u));
});

app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.listen(PORT,()=>console.log(`HAPA v1.0 running on ${PORT}`));
