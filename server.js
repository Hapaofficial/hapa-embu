const express = require('express');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = Number(process.env.PORT || 10000);
const DB_PATH = path.join(__dirname, 'data', 'db.json');
const JWT_SECRET = process.env.JWT_SECRET || 'CHANGE_THIS_IN_RENDER_NOW';
const OWNER_EMAIL = String(process.env.OWNER_EMAIL || '').trim().toLowerCase();
const OWNER_PASSWORD = String(process.env.OWNER_PASSWORD || '');
const OWNER_NAME = String(process.env.OWNER_NAME || 'HAPA Owner').trim();
const PAYMENT_MODE = String(process.env.PAYMENT_MODE || 'demo').toLowerCase();

const MPESA_CONFIGURED = Boolean(
  process.env.MPESA_CONSUMER_KEY &&
  process.env.MPESA_CONSUMER_SECRET &&
  process.env.MPESA_SHORTCODE &&
  process.env.MPESA_PASSKEY &&
  process.env.MPESA_CALLBACK_URL
);
const CARD_CONFIGURED = Boolean(
  process.env.STRIPE_SECRET_KEY &&
  process.env.STRIPE_PUBLISHABLE_KEY
);

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  maxAge: '5m'
}));

function defaultDb() {
  return {
    users: [], transactions: [], orders: [], rides: [],
    settings: {
      appName: 'HAPA',
      tagline: 'Everything local — Embu, Kenya',
      currency: 'KES',
      timezone: 'Africa/Nairobi',
      language: 'en',
      supportEmail: '',
      supportPhone: '',
      businessAddress: 'Embu, Kenya',
      platformFeePct: 10,
      servicePrices: { boda: 150, car: 350, courier: 200 },
      payments: {
        mode: PAYMENT_MODE,
        walletEnabled: true,
        mpesaEnabled: false,
        cardEnabled: false,
        cashEnabled: true
      }
    }
  };
}
function loadDb() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    const d = defaultDb();
    return {
      ...d,
      ...parsed,
      settings: {
        ...d.settings,
        ...(parsed.settings || {}),
        servicePrices: {...d.settings.servicePrices, ...(parsed.settings?.servicePrices || {})},
        payments: {...d.settings.payments, ...(parsed.settings?.payments || {})}
      }
    };
  } catch {
    return defaultDb();
  }
}
function saveDb(db) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}
function id(prefix='id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,9)}`;
}
function cleanEmail(v) {
  return String(v || '').trim().toLowerCase();
}
function publicUser(u) {
  const { passwordHash, tokenVersion, ...safe } = u;
  return safe;
}
function tokenFor(u) {
  return jwt.sign(
    { sub: u.id, role: u.role, email: u.email, tv: Number(u.tokenVersion || 0) },
    JWT_SECRET,
    { expiresIn: '7d', issuer: 'hapa-embu' }
  );
}
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!t) return res.status(401).json({ error: 'Login required' });
  try {
    const decoded = jwt.verify(t, JWT_SECRET, { issuer: 'hapa-embu' });
    const db = loadDb();
    const user = db.users.find(u => u.id === decoded.sub);
    if (!user || user.status === 'blocked') return res.status(401).json({ error: 'Account unavailable' });
    if (Number(decoded.tv || 0) !== Number(user.tokenVersion || 0)) {
      return res.status(401).json({ error: 'Session expired. Please log in again.' });
    }
    req.auth = decoded;
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: 'Session expired. Please log in again.' });
  }
}
function ownerOnly(req, res, next) {
  if (req.user?.role !== 'owner') return res.status(403).json({ error: 'Owner access required' });
  next();
}
function validatePassword(p) {
  return typeof p === 'string' &&
    p.length >= 12 &&
    /[A-Z]/.test(p) &&
    /[a-z]/.test(p) &&
    /\d/.test(p);
}

(function syncOwner() {
  const db = loadDb();
  let owner = db.users.find(u => u.role === 'owner');
  if (!owner && OWNER_EMAIL && validatePassword(OWNER_PASSWORD)) {
    owner = {
      id: id('usr'),
      name: OWNER_NAME,
      email: OWNER_EMAIL,
      phone: '',
      address: '',
      role: 'owner',
      status: 'active',
      wallet: 0,
      language: 'en',
      notificationPrefs: { email: true, push: true, sms: false, marketing: false },
      passwordHash: bcrypt.hashSync(OWNER_PASSWORD, 12),
      tokenVersion: 0,
      createdAt: new Date().toISOString()
    };
    db.users.push(owner);
    saveDb(db);
    console.log('Owner account created from Render environment variables.');
  } else if (!owner) {
    console.warn('Owner not configured. Add OWNER_EMAIL and a strong OWNER_PASSWORD in Render.');
  }
})();

app.get('/api/health', (req, res) => {
  const db = loadDb();
  res.json({
    ok: true,
    service: 'HAPA',
    version: '1.2.0',
    ownerConfigured: db.users.some(u => u.role === 'owner'),
    paymentMode: PAYMENT_MODE,
    providers: {
      wallet: true,
      mpesaConfigured: MPESA_CONFIGURED,
      cardConfigured: CARD_CONFIGURED
    }
  });
});

app.post('/api/auth/register', (req, res) => {
  const { name, email, password, phone, role='customer' } = req.body || {};
  const allowedRoles = ['customer', 'driver', 'merchant', 'partner'];
  if (!String(name || '').trim() || !cleanEmail(email) || !password) {
    return res.status(400).json({ error: 'Name, email and password are required' });
  }
  if (!validatePassword(password)) {
    return res.status(400).json({ error: 'Password must have 12+ characters, uppercase, lowercase and a number' });
  }
  if (!allowedRoles.includes(role)) return res.status(400).json({ error: 'Invalid account type' });
  const db = loadDb();
  const normalized = cleanEmail(email);
  if (db.users.some(u => u.email === normalized)) return res.status(409).json({ error: 'Account already exists' });

  const user = {
    id: id('usr'),
    name: String(name).trim(),
    email: normalized,
    phone: String(phone || '').trim(),
    address: '',
    role,
    status: role === 'customer' ? 'active' : 'pending',
    wallet: 0,
    language: 'en',
    notificationPrefs: { email: true, push: true, sms: false, marketing: false },
    passwordHash: bcrypt.hashSync(password, 12),
    tokenVersion: 0,
    createdAt: new Date().toISOString()
  };
  db.users.push(user);
  saveDb(db);
  res.status(201).json({
    token: tokenFor(user),
    user: publicUser(user),
    message: role === 'customer' ? 'Account created' : 'Account created and awaiting owner approval'
  });
});

app.post('/api/auth/login', (req, res) => {
  const db = loadDb();
  const user = db.users.find(u => u.email === cleanEmail(req.body?.email));
  if (!user || !bcrypt.compareSync(String(req.body?.password || ''), user.passwordHash)) {
    return res.status(401).json({ error: 'Wrong email or password' });
  }
  if (user.status === 'blocked') return res.status(403).json({ error: 'Account blocked' });
  res.json({ token: tokenFor(user), user: publicUser(user) });
});

app.get('/api/me', auth, (req, res) => res.json(publicUser(req.user)));

app.patch('/api/me/profile', auth, (req, res) => {
  const db = loadDb();
  const u = db.users.find(x => x.id === req.user.id);
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name is required' });
  u.name = name;
  u.phone = String(req.body?.phone || '').trim();
  u.address = String(req.body?.address || '').trim();
  u.language = ['en','sw'].includes(req.body?.language) ? req.body.language : (u.language || 'en');
  u.notificationPrefs = {
    email: Boolean(req.body?.notificationPrefs?.email),
    push: Boolean(req.body?.notificationPrefs?.push),
    sms: Boolean(req.body?.notificationPrefs?.sms),
    marketing: Boolean(req.body?.notificationPrefs?.marketing)
  };
  u.updatedAt = new Date().toISOString();
  saveDb(db);
  res.json(publicUser(u));
});

app.post('/api/me/change-email', auth, (req, res) => {
  const newEmail = cleanEmail(req.body?.newEmail);
  const currentPassword = String(req.body?.currentPassword || '');
  if (!newEmail || !newEmail.includes('@')) return res.status(400).json({ error: 'Enter a valid email address' });
  if (!bcrypt.compareSync(currentPassword, req.user.passwordHash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  const db = loadDb();
  if (db.users.some(u => u.email === newEmail && u.id !== req.user.id)) {
    return res.status(409).json({ error: 'This email is already in use' });
  }
  const u = db.users.find(x => x.id === req.user.id);
  u.email = newEmail;
  u.tokenVersion = Number(u.tokenVersion || 0) + 1;
  u.updatedAt = new Date().toISOString();
  saveDb(db);
  res.json({ ok: true, message: 'Email changed. Please log in again.' });
});

app.post('/api/me/change-password', auth, (req, res) => {
  const currentPassword = String(req.body?.currentPassword || '');
  const newPassword = String(req.body?.newPassword || '');
  if (!validatePassword(newPassword)) {
    return res.status(400).json({ error: 'New password must have 12+ characters, uppercase, lowercase and a number' });
  }
  if (!bcrypt.compareSync(currentPassword, req.user.passwordHash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  const db = loadDb();
  const u = db.users.find(x => x.id === req.user.id);
  u.passwordHash = bcrypt.hashSync(newPassword, 12);
  u.tokenVersion = Number(u.tokenVersion || 0) + 1;
  u.updatedAt = new Date().toISOString();
  saveDb(db);
  res.json({ ok: true, message: 'Password changed. Please log in again.' });
});

app.post('/api/me/logout-all', auth, (req, res) => {
  const db = loadDb();
  const u = db.users.find(x => x.id === req.user.id);
  u.tokenVersion = Number(u.tokenVersion || 0) + 1;
  u.updatedAt = new Date().toISOString();
  saveDb(db);
  res.json({ ok: true });
});

app.get('/api/settings/public', (req, res) => {
  const s = loadDb().settings;
  res.json({
    appName: s.appName,
    tagline: s.tagline,
    currency: s.currency,
    language: s.language,
    supportEmail: s.supportEmail,
    supportPhone: s.supportPhone,
    servicePrices: s.servicePrices,
    paymentMethods: {
      wallet: Boolean(s.payments.walletEnabled),
      mpesa: Boolean(s.payments.mpesaEnabled && MPESA_CONFIGURED),
      card: Boolean(s.payments.cardEnabled && CARD_CONFIGURED),
      cash: Boolean(s.payments.cashEnabled)
    },
    paymentMode: PAYMENT_MODE
  });
});

app.get('/api/payments/status', auth, (req, res) => {
  const s = loadDb().settings;
  res.json({
    mode: PAYMENT_MODE,
    wallet: { enabled: Boolean(s.payments.walletEnabled), configured: true },
    mpesa: { enabled: Boolean(s.payments.mpesaEnabled), configured: MPESA_CONFIGURED },
    card: { enabled: Boolean(s.payments.cardEnabled), configured: CARD_CONFIGURED },
    cash: { enabled: Boolean(s.payments.cashEnabled), configured: true }
  });
});

app.post('/api/wallet/topup', auth, (req, res) => {
  const amount = Number(req.body?.amount);
  const method = String(req.body?.method || 'wallet');
  if (!Number.isFinite(amount) || amount < 10 || amount > 150000) {
    return res.status(400).json({ error: 'Amount must be between KES 10 and 150,000' });
  }
  const db = loadDb();
  const settings = db.settings.payments;
  const allowed = {
    wallet: settings.walletEnabled,
    demo: PAYMENT_MODE === 'demo',
    mpesa: settings.mpesaEnabled && MPESA_CONFIGURED,
    card: settings.cardEnabled && CARD_CONFIGURED
  };
  if (!allowed[method]) {
    if (method === 'mpesa') return res.status(400).json({ error: 'M-Pesa is not configured yet' });
    if (method === 'card') return res.status(400).json({ error: 'Card payments are not configured yet' });
    return res.status(400).json({ error: 'Payment method unavailable' });
  }

  const u = db.users.find(x => x.id === req.user.id);
  const demo = PAYMENT_MODE !== 'live' || method === 'demo';

  // This package intentionally does not fabricate real external payment success.
  // In demo mode it credits the wallet so the complete app flow can be tested.
  if (!demo && (method === 'mpesa' || method === 'card')) {
    return res.status(501).json({
      error: 'Provider credentials are detected, but live charging requires the provider callback/webhook integration.'
    });
  }

  const tx = {
    id: id('tx'), userId: u.id, type: 'topup', method, amount,
    status: 'completed', demo: true, reference: `HAPA-${Date.now()}`,
    createdAt: new Date().toISOString()
  };
  u.wallet = Number(u.wallet || 0) + amount;
  db.transactions.push(tx);
  saveDb(db);
  res.json({
    wallet: u.wallet,
    transaction: tx,
    message: 'Test payment completed. No real money was charged.'
  });
});

app.post('/api/wallet/pay', auth, (req, res) => {
  const amount = Number(req.body?.amount);
  const description = String(req.body?.description || 'HAPA payment');
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
  const db = loadDb();
  const u = db.users.find(x => x.id === req.user.id);
  if (Number(u.wallet || 0) < amount) return res.status(400).json({ error: 'Insufficient HAPA Wallet balance' });
  u.wallet -= amount;
  const tx = {
    id: id('tx'), userId: u.id, type: 'payment', method: 'wallet',
    amount: -amount, status: 'completed', description,
    reference: `HAPA-PAY-${Date.now()}`, createdAt: new Date().toISOString()
  };
  db.transactions.push(tx);
  saveDb(db);
  res.json({ wallet: u.wallet, transaction: tx });
});

app.get('/api/wallet/transactions', auth, (req, res) => {
  const db = loadDb();
  res.json(db.transactions.filter(t => t.userId === req.user.id).slice(-100).reverse());
});

app.post('/api/rides', auth, (req, res) => {
  const db = loadDb();
  const type = ['boda','car','courier'].includes(req.body?.type) ? req.body.type : 'boda';
  const pickup = String(req.body?.pickup || '').trim();
  const destination = String(req.body?.destination || '').trim();
  if (!pickup || !destination) return res.status(400).json({ error: 'Pickup and destination required' });
  const ride = {
    id: id('ride'),
    customerId: req.user.id,
    pickup,
    destination,
    type,
    price: Number(db.settings.servicePrices[type] || 150),
    status: 'requested',
    createdAt: new Date().toISOString()
  };
  db.rides.push(ride);
  saveDb(db);
  res.status(201).json(ride);
});

app.post('/api/orders', auth, (req, res) => {
  const db = loadDb();
  const order = {
    id: id('ord'),
    customerId: req.user.id,
    merchant: String(req.body?.merchant || 'HAPA Demo Kitchen'),
    items: Array.isArray(req.body?.items) ? req.body.items : [],
    total: Number(req.body?.total || 0),
    status: 'placed',
    createdAt: new Date().toISOString()
  };
  db.orders.push(order);
  saveDb(db);
  res.status(201).json(order);
});

app.get('/api/owner/dashboard', auth, ownerOnly, (req, res) => {
  const db = loadDb();
  res.json({
    users: db.users.length,
    customers: db.users.filter(u => u.role === 'customer').length,
    drivers: db.users.filter(u => u.role === 'driver').length,
    merchants: db.users.filter(u => u.role === 'merchant').length,
    partners: db.users.filter(u => u.role === 'partner').length,
    pending: db.users.filter(u => u.status === 'pending').length,
    rides: db.rides.length,
    orders: db.orders.length,
    transactions: db.transactions.length,
    walletVolume: db.transactions.filter(t => t.status === 'completed' && t.amount > 0).reduce((a,t)=>a+t.amount,0)
  });
});

app.get('/api/owner/users', auth, ownerOnly, (req, res) => {
  res.json(loadDb().users.map(publicUser));
});

app.patch('/api/owner/users/:id', auth, ownerOnly, (req, res) => {
  const db = loadDb();
  const u = db.users.find(x => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  if (u.role === 'owner') return res.status(400).json({ error: 'Owner account cannot be blocked here' });
  if (['active','pending','blocked'].includes(req.body?.status)) u.status = req.body.status;
  u.updatedAt = new Date().toISOString();
  saveDb(db);
  res.json(publicUser(u));
});

app.get('/api/owner/settings', auth, ownerOnly, (req, res) => {
  const db = loadDb();
  res.json({
    ...db.settings,
    providerStatus: {
      mpesaConfigured: MPESA_CONFIGURED,
      cardConfigured: CARD_CONFIGURED,
      paymentMode: PAYMENT_MODE
    }
  });
});

app.patch('/api/owner/settings', auth, ownerOnly, (req, res) => {
  const db = loadDb();
  const s = db.settings;
  const b = req.body || {};
  s.appName = String(b.appName || s.appName).trim().slice(0, 40);
  s.tagline = String(b.tagline || s.tagline).trim().slice(0, 120);
  s.supportEmail = cleanEmail(b.supportEmail);
  s.supportPhone = String(b.supportPhone || '').trim().slice(0, 30);
  s.businessAddress = String(b.businessAddress || '').trim().slice(0, 160);
  s.currency = ['KES','USD'].includes(b.currency) ? b.currency : s.currency;
  s.timezone = ['Africa/Nairobi','America/New_York'].includes(b.timezone) ? b.timezone : s.timezone;
  s.language = ['en','sw'].includes(b.language) ? b.language : s.language;
  s.platformFeePct = Math.min(40, Math.max(0, Number(b.platformFeePct || 0)));
  s.servicePrices = {
    boda: Math.max(0, Number(b.servicePrices?.boda || 0)),
    car: Math.max(0, Number(b.servicePrices?.car || 0)),
    courier: Math.max(0, Number(b.servicePrices?.courier || 0))
  };
  s.payments = {
    ...s.payments,
    walletEnabled: Boolean(b.payments?.walletEnabled),
    mpesaEnabled: Boolean(b.payments?.mpesaEnabled),
    cardEnabled: Boolean(b.payments?.cardEnabled),
    cashEnabled: Boolean(b.payments?.cashEnabled),
    mode: PAYMENT_MODE
  };
  saveDb(db);
  res.json(s);
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, '0.0.0.0', () => {
  console.log(`HAPA v1.2 running on port ${PORT}`);
});
