
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 8080;
const DB_PATH = process.env.HAPA_DB_PATH || path.join(__dirname, 'data', 'db.json');
const WEB_ROOT = path.join(__dirname, '..', 'apps', 'web');

function loadDB() {
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}
function saveDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}
function send(res, status, data, type='application/json') {
  res.writeHead(status, {
    'Content-Type': type,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS'
  });
  res.end(type === 'application/json' ? JSON.stringify(data) : data);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
    });
  });
}
function id(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2,6);
}
function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(WEB_ROOT, rel));
  if (!file.startsWith(WEB_ROOT)) return send(res, 403, {error:'Forbidden'});
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return false;
  const ext = path.extname(file);
  const types = {
    '.html':'text/html; charset=utf-8',
    '.css':'text/css; charset=utf-8',
    '.js':'application/javascript; charset=utf-8',
    '.json':'application/json',
    '.svg':'image/svg+xml'
  };
  send(res, 200, fs.readFileSync(file), types[ext] || 'application/octet-stream');
  return true;
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  const db = loadDB();

  try {

    if (p === '/api/login' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.phone || !body.pin) return send(res,400,{error:'phone and pin are required'});
      const user = db.users.find(x=>x.phone===body.phone);
      if (!user) return send(res,404,{error:'User not found'});
      const token = id('session_');
      db.sessions = db.sessions || [];
      db.sessions.unshift({token,userId:user.id,createdAt:new Date().toISOString()});
      saveDB(db);
      return send(res,200,{token,user});
    }

    if (p === '/api/wallets' && req.method === 'GET') {
      return send(res,200,db.wallets || []);
    }

    if (p === '/api/notifications' && req.method === 'GET') {
      return send(res,200,db.notifications || []);
    }

    if (p === '/api/partners/export.csv' && req.method === 'GET') {
      const rows = [['name','phone','type','details','status','createdAt']];
      for (const x of db.partnerLeads) rows.push([x.name,x.phone,x.type,x.details||'',x.status||'new',x.createdAt||'']);
      const csv = rows.map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
      return send(res,200,csv,'text/csv; charset=utf-8');
    }

    if (p.startsWith('/api/partners/') && req.method === 'PATCH') {
      const leadId = p.split('/').pop();
      const lead = db.partnerLeads.find(x=>x.id===leadId);
      if (!lead) return send(res,404,{error:'Partner lead not found'});
      Object.assign(lead, await readBody(req)); saveDB(db); return send(res,200,lead);
    }

    if (p.startsWith('/api/orders/') && req.method === 'PATCH') {
      const orderId = p.split('/').pop();
      const order = db.orders.find(x=>x.id===orderId);
      if (!order) return send(res,404,{error:'Order not found'});
      Object.assign(order, await readBody(req)); saveDB(db); return send(res,200,order);
    }

    if (p === '/api/earnings' && req.method === 'GET') {
      const completed = db.rides.filter(x=>x.status==='completed');
      const gross = completed.reduce((s,x)=>s+(Number(x.fareEstimate)||0),0);
      const percent = (db.commissions && db.commissions.ridePercent) || 15;
      const fee = Math.round(gross*percent/100);
      return send(res,200,{completedRides:completed.length,gross,platformFee:fee,net:gross-fee,commissionPercent:percent});
    }

    if (p === '/api/health') return send(res, 200, {ok:true, service:'HAPA API', time:new Date().toISOString()});
    if (p === '/api/bootstrap') return send(res, 200, {
      drivers: db.drivers,
      marketplace: db.marketplace,
      restaurants: db.restaurants,
      stats: {
        rides: db.rides.length,
        orders: db.orders.length,
        leads: db.partnerLeads.length,
        onlineDrivers: db.drivers.filter(x=>x.online).length
      }
    });

    if (p === '/api/rides' && req.method === 'GET') return send(res, 200, db.rides);
    if (p === '/api/rides' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.type || !body.destination) return send(res, 400, {error:'type and destination are required'});
      const ride = {
        id:id('ride_'),
        type:body.type,
        pickup:body.pickup || 'Embu Town',
        destination:body.destination,
        customerName:body.customerName || 'Guest',
        status:'searching',
        fareEstimate: body.type === 'boda' ? 180 : body.type === 'courier' ? 250 : 420,
        createdAt:new Date().toISOString()
      };
      db.rides.unshift(ride); saveDB(db); return send(res, 201, ride);
    }

    if (p.startsWith('/api/rides/') && req.method === 'PATCH') {
      const rideId = p.split('/').pop();
      const ride = db.rides.find(x=>x.id===rideId);
      if (!ride) return send(res,404,{error:'Ride not found'});
      Object.assign(ride, await readBody(req)); saveDB(db); return send(res,200,ride);
    }

    if (p === '/api/orders' && req.method === 'GET') return send(res,200,db.orders);
    if (p === '/api/orders' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.items || !body.items.length) return send(res,400,{error:'items required'});
      const total = body.items.reduce((s,x)=>s+(Number(x.price)||0)*(Number(x.qty)||1),0);
      const order = {
        id:id('order_'),
        restaurantId:body.restaurantId || 'r1',
        items:body.items,
        total,
        customerName:body.customerName || 'Guest',
        status:'received',
        createdAt:new Date().toISOString()
      };
      db.orders.unshift(order); saveDB(db); return send(res,201,order);
    }

    if (p === '/api/marketplace' && req.method === 'GET') return send(res,200,db.marketplace);
    if (p === '/api/marketplace' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.title || !body.price) return send(res,400,{error:'title and price required'});
      const item = {id:id('m_'),title:body.title,price:Number(body.price),seller:body.seller||'Guest',category:body.category||'Other'};
      db.marketplace.unshift(item); saveDB(db); return send(res,201,item);
    }

    if (p === '/api/partners' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.name || !body.phone || !body.type) return send(res,400,{error:'name, phone and type required'});
      const lead = {id:id('lead_'),...body,status:'new',createdAt:new Date().toISOString()};
      db.partnerLeads.unshift(lead); saveDB(db); return send(res,201,lead);
    }
    if (p === '/api/partners' && req.method === 'GET') return send(res,200,db.partnerLeads);

    if (p === '/api/admin/reset-demo' && req.method === 'POST') {
      db.rides=[]; db.orders=[]; db.partnerLeads=[]; saveDB(db);
      return send(res,200,{ok:true});
    }

    if (p.startsWith('/api/')) return send(res,404,{error:'API route not found'});
    if (serveStatic(req,res,p)) return;
    return send(res,404,'Not found','text/plain; charset=utf-8');
  } catch (e) {
    console.error(e);
    return send(res,500,{error:'Server error',details:e.message});
  }
});

server.listen(PORT, () => {
  console.log(`HAPA running on http://localhost:${PORT}`);
});
