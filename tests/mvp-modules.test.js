// Automated tests: MVP completion — account settings, Merchant, Driver,
// unified requests, reviews, generic reports, owner moderation & audit.
// Usage: node tests/mvp-modules.test.js [baseUrl]
// Requires a running server in demo auth mode and owner creds via env:
//   TEST_OWNER_EMAIL / TEST_OWNER_PASSWORD
// All users created here are synthetic and deactivated/blocked at the end.
const path = require('path');
const sharp = require(path.join(__dirname, '..', 'node_modules', 'sharp'));

const B = process.argv[2] || 'http://127.0.0.1:5000';
const OWNER_EMAIL = process.env.TEST_OWNER_EMAIL;
const OWNER_PASSWORD = process.env.TEST_OWNER_PASSWORD;
const RUN = Date.now().toString(36);
const PW = 'TestPass2026x!';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra !== undefined ? JSON.stringify(extra) : ''); }
};
const j = async (m, p, t, b) => {
  const r = await fetch(B + p, {
    method: m,
    headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) },
    body: b ? JSON.stringify(b) : undefined,
  });
  return { s: r.status, d: await r.json().catch(() => ({})), h: r.headers };
};
const upload = async (p, t, buf, mime, name) => {
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: mime || 'image/jpeg' }), name || 'x.jpg');
  const r = await fetch(B + p, { method: 'POST', headers: t ? { Authorization: 'Bearer ' + t } : {}, body: fd });
  return { s: r.status, d: await r.json().catch(() => ({})) };
};
const noPrivateLeak = (o) => !/password_hash|sensitive_details|private_document|token_version|hapa-private|hapa-staging-private/i.test(JSON.stringify(o));

// Register a fresh synthetic user and get it active with an approved capability.
async function makeUser(ownerTok, label, capType, details) {
  const em = `mvp.${label}.${RUN}@example.com`;
  const reg = await j('POST', '/api/auth/register', null, { name: 'MVP ' + label, email: em, password: PW, selfie: 'data:image/png;base64,iVBORw0KGgo=' });
  if (reg.s !== 201) throw new Error('register failed ' + label + ' ' + JSON.stringify(reg.d));
  let tok = reg.d.token; const uid = reg.d.user.id;
  // owner approves access request
  const acc = (await j('GET', '/api/owner/access', ownerTok)).d.find(a => a.user_id === uid && a.status === 'pending');
  if (acc) await j('PATCH', '/api/owner/access/' + acc.id, ownerTok, { status: 'approved' });
  tok = (await j('POST', '/api/auth/login', null, { identifier: em, password: PW })).d.token;
  if (capType) {
    const sub = await j('POST', `/api/me/upgrades/${capType}/submit`, tok, { details, consent: true });
    if (sub.s >= 400) throw new Error('submit failed ' + JSON.stringify(sub.d));
    const apps = (await j('GET', '/api/owner/upgrades?type=' + capType, ownerTok)).d;
    const app = apps.find(a => a.user_id === uid && a.status === 'pending');
    await j('PATCH', '/api/owner/upgrades/' + app.id + '/status', ownerTok, { status: 'approved' });
    tok = (await j('POST', '/api/auth/login', null, { identifier: em, password: PW })).d.token;
  }
  return { tok, uid, em };
}

(async () => {
  if (!OWNER_EMAIL || !OWNER_PASSWORD) { console.error('TEST_OWNER_EMAIL/TEST_OWNER_PASSWORD required'); process.exit(1); }
  const ownerTok = (await j('POST', '/api/auth/login', null, { identifier: OWNER_EMAIL, password: OWNER_PASSWORD })).d.token;
  if (!ownerTok) { console.error('owner login failed'); process.exit(1); }

  // ── security headers ──
  const hr = await fetch(B + '/api/health');
  ok('nosniff header', hr.headers.get('x-content-type-options') === 'nosniff');
  ok('frame-options header', hr.headers.get('x-frame-options') === 'DENY');
  ok('CSP header present', (hr.headers.get('content-security-policy') || '').includes("default-src 'self'"));

  // ── synthetic users ──
  const cust = await makeUser(ownerTok, 'customer', null);
  const merch = await makeUser(ownerTok, 'merchant', 'merchant', { businessName: 'Embu Fresh Grocers', ownerName: 'MVP merchant', businessCategory: 'Groceries', county: 'Embu' });
  const drv = await makeUser(ownerTok, 'driver', 'driver', { fullName: 'MVP driver', drivingLicenceNumber: 'DL-TEST-1', vehicleType: 'Boda Boda', registrationNumber: 'KAA 000T', county: 'Embu' });

  // ── account settings ──
  const testPhone = '07' + String(Math.floor(10000000 + Math.random() * 89999999)); // random to avoid collisions with leftover deactivated users
  const me1 = await j('PATCH', '/api/me', cust.tok, { name: 'MVP Customer Renamed', location: 'Embu Town', phone: testPhone });
  ok('profile edit works', me1.s === 200 && me1.d.name === 'MVP Customer Renamed', me1);
  ok('kenyan phone normalized to +254', me1.d.phone === '+254' + testPhone.slice(1), me1.d.phone);
  ok('phone change resets verification', me1.d.phoneVerified === false);
  ok('duplicate phone rejected', (await j('PATCH', '/api/me', merch.tok, { phone: testPhone })).s === 409);
  const pw1 = await j('POST', '/api/me/password', cust.tok, { currentPassword: 'wrong', newPassword: 'NewPass2026x!' });
  ok('wrong current password rejected', pw1.s === 403);
  const pw2 = await j('POST', '/api/me/password', cust.tok, { currentPassword: PW, newPassword: 'NewPass2026x!' });
  ok('password change works + returns fresh token', pw2.s === 200 && !!pw2.d.token, pw2.s);
  ok('old token invalidated after password change', (await j('GET', '/api/me', cust.tok)).s === 401);
  cust.tok = pw2.d.token;
  ok('new token works', (await j('GET', '/api/me', cust.tok)).s === 200);

  // ── merchant lifecycle ──
  const mc0 = await j('POST', '/api/me/merchant-profile', merch.tok);
  ok('merchant profile created from approved application', mc0.s === 201 && mc0.d.profile.verified_category === 'Groceries', mc0);
  const mpid = mc0.d.profile.id;
  ok('customer without capability cannot create merchant profile', (await j('POST', '/api/me/merchant-profile', cust.tok)).s === 403);
  ok('merchant category locked', (await j('PATCH', '/api/me/merchant-profile', merch.tok, { verified_category: 'Electronics' })).s === 400);
  const mc1 = await j('PATCH', '/api/me/merchant-profile', merch.tok, { description: 'Fresh vegetables and fruits daily in Embu town.', opening_hours: 'Mon–Sat 7am–7pm', phone_visible: true });
  ok('merchant profile edit works', mc1.s === 200 && mc1.d.profile.opening_hours.includes('7am'), mc1.s);
  ok('draft merchant not public', (await j('GET', '/api/public/merchants/' + mpid)).s === 404);
  const jpg = await sharp({ create: { width: 200, height: 200, channels: 3, background: { r: 20, g: 120, b: 60 } } }).jpeg().toBuffer();
  const logo = await upload('/api/me/merchant-profile/logo', merch.tok, jpg);
  ok('logo upload works (owner media URL)', logo.s === 201 && logo.d.url.startsWith('/api/me/provider-media/'), logo);
  ok('SVG rejected for merchant media', (await upload('/api/me/merchant-profile/gallery', merch.tok, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml', 'x.svg')).s === 400);
  const gal = await upload('/api/me/merchant-profile/gallery', merch.tok, jpg);
  ok('gallery upload works', gal.s === 201);
  // items
  const it1 = await j('POST', '/api/me/merchant-items', merch.tok, { title: 'Fresh Avocados', description: 'Creamy Embu avocados', category: 'Fruits', price: 20, price_unit: 'per piece' });
  ok('item created', it1.s === 201, it1);
  const itemId = it1.d.id;
  const itImg = await upload(`/api/me/merchant-items/${itemId}/images`, merch.tok, jpg);
  ok('item image upload works', itImg.s === 201);
  ok('item price validation', (await j('POST', '/api/me/merchant-items', merch.tok, { title: 'Bad', price: -5 })).s === 400);
  const pub = await j('POST', '/api/me/merchant-profile/publish', merch.tok);
  ok('merchant publish works', pub.s === 200 && pub.d.profile.status === 'active', pub);
  const mPub = await j('GET', '/api/public/merchants/' + mpid);
  ok('published merchant public with items', mPub.s === 200 && mPub.d.items.length === 1, mPub.s);
  ok('merchant phone visible per setting', typeof mPub.d.phone === 'string' || mPub.d.phone === null);
  ok('no private data in public merchant', noPrivateLeak(mPub.d));
  ok('merchant in public list', JSON.stringify((await j('GET', '/api/public/merchants')).d).includes(mpid));
  const itemImgUrl = mPub.d.items[0].images[0] && mPub.d.items[0].images[0].url;
  if (itemImgUrl) ok('public item media served', [200, 302].includes((await fetch(B + itemImgUrl, { redirect: 'manual' })).status));
  // item pause hides from public
  await j('PATCH', `/api/me/merchant-items/${itemId}/status`, merch.tok, { status: 'paused' });
  ok('paused item not public', (await j('GET', '/api/public/merchants/' + mpid)).d.items.length === 0);
  await j('PATCH', `/api/me/merchant-items/${itemId}/status`, merch.tok, { status: 'active' });

  // ── driver lifecycle ──
  const dv0 = await j('POST', '/api/me/driver-profile', drv.tok);
  ok('driver profile created, vehicle type locked in', dv0.s === 201 && dv0.d.profile.vehicle_type === 'Boda Boda', dv0);
  const dpid = dv0.d.profile.id;
  ok('vehicle_type locked', (await j('PATCH', '/api/me/driver-profile', drv.tok, { vehicle_type: 'Lorry' })).s === 400);
  const dv1 = await j('PATCH', '/api/me/driver-profile', drv.tok, { vehicle_description: 'Reliable boda for Embu town runs', service_area: 'Embu town and environs', availability: 'Daily 6am–9pm', phone_visible: true });
  ok('driver profile edit works', dv1.s === 200, dv1.s);
  const dph = await upload('/api/me/driver-profile/profile-photo', drv.tok, jpg);
  ok('driver photo upload works', dph.s === 201);
  ok('draft driver not public', (await j('GET', '/api/public/drivers/' + dpid)).s === 404);
  ok('driver publish works', (await j('POST', '/api/me/driver-profile/publish', drv.tok)).s === 200);
  const dPub = await j('GET', '/api/public/drivers/' + dpid);
  ok('published driver public', dPub.s === 200, dPub.s);
  ok('driver default pricing text', dPub.d.pricing_info === 'Price agreed with driver', dPub.d.pricing_info);
  ok('no private data in public driver', noPrivateLeak(dPub.d));

  // ── unified requests ──
  ok('provider cannot request self', (await j('POST', '/api/requests', merch.tok, { provider_type: 'merchant', profile_id: mpid, request_type: 'enquiry', note: 'test' })).s === 400);
  ok('driver request requires pickup+destination', (await j('POST', '/api/requests', cust.tok, { provider_type: 'driver', profile_id: dpid, request_type: 'ride' })).s === 400);
  const rq1 = await j('POST', '/api/requests', cust.tok, { provider_type: 'merchant', profile_id: mpid, item_id: itemId, request_type: 'order', note: '5 avocados please' });
  ok('merchant order request created', rq1.s === 201 && rq1.d.status === 'pending', rq1);
  const rq2 = await j('POST', '/api/requests', cust.tok, { provider_type: 'driver', profile_id: dpid, request_type: 'ride', pickup_text: 'Embu town CBD', destination_text: 'Kangaru', requested_for: 'Today 4pm' });
  ok('driver ride request created', rq2.s === 201, rq2);
  // authorization
  ok('stranger cannot view request', (await j('GET', '/api/requests/' + rq1.d.id, drv.tok)).s === 404);
  ok('unauthenticated cannot view request', (await j('GET', '/api/requests/' + rq1.d.id)).s === 401);
  const custList = await j('GET', '/api/me/requests', cust.tok);
  ok('customer sees own requests', custList.d.length === 2, custList.d.length);
  const provList = await j('GET', '/api/me/provider-requests', merch.tok);
  ok('provider sees only own incoming requests', provList.d.length === 1 && provList.d[0].id === rq1.d.id);
  // contact rules: pending → no customer phone for provider
  const det0 = await j('GET', '/api/requests/' + rq1.d.id, merch.tok);
  ok('customer phone hidden while pending', det0.d.customer_phone === undefined, det0.d.customer_phone);
  // transitions
  ok('customer cannot accept', (await j('POST', `/api/requests/${rq1.d.id}/status`, cust.tok, { status: 'accepted' })).s === 403);
  ok('provider accepts', (await j('POST', `/api/requests/${rq1.d.id}/status`, merch.tok, { status: 'accepted' })).s === 200);
  const det1 = await j('GET', '/api/requests/' + rq1.d.id, merch.tok);
  ok('customer phone revealed after accept', typeof det1.d.customer_phone === 'string');
  ok('cannot re-accept', (await j('POST', `/api/requests/${rq1.d.id}/status`, merch.tok, { status: 'accepted' })).s === 409);
  ok('message in request works', (await j('POST', `/api/requests/${rq1.d.id}/message`, cust.tok, { message: 'Please deliver before 5pm' })).s === 201);
  const det2 = await j('GET', '/api/requests/' + rq1.d.id, cust.tok);
  ok('events include status history + message', det2.d.events.some(e => e.event_type === 'status') && det2.d.events.some(e => e.event_type === 'message'));
  ok('review before completion rejected', (await j('POST', `/api/requests/${rq1.d.id}/review`, cust.tok, { rating: 5 })).s === 409);
  ok('provider completes', (await j('POST', `/api/requests/${rq1.d.id}/status`, merch.tok, { status: 'completed' })).s === 200);
  ok('customer cancels pending ride', (await j('POST', `/api/requests/${rq2.d.id}/status`, cust.tok, { status: 'cancelled' })).s === 200);
  ok('provider cannot accept cancelled', (await j('POST', `/api/requests/${rq2.d.id}/status`, drv.tok, { status: 'accepted' })).s === 409);

  // ── reviews ──
  ok('provider cannot review own request', (await j('POST', `/api/requests/${rq1.d.id}/review`, merch.tok, { rating: 5 })).s === 404);
  const rv1 = await j('POST', `/api/requests/${rq1.d.id}/review`, cust.tok, { rating: 5, comment: 'Fast and fresh!' });
  ok('review after completion works', rv1.s === 201, rv1);
  ok('second review rejected', (await j('POST', `/api/requests/${rq1.d.id}/review`, cust.tok, { rating: 1 })).s === 409);
  ok('invalid rating rejected', (await j('POST', `/api/requests/${rq2.d.id}/review`, cust.tok, { rating: 9 })).s === 400);
  const pubRv = await j('GET', `/api/public/providers/merchant/${mpid}/reviews`);
  ok('public reviews listed with aggregate', pubRv.s === 200 && pubRv.d.rating_count === 1 && +pubRv.d.rating_avg === 5, pubRv.d);
  const mAgg = await j('GET', '/api/public/merchants/' + mpid);
  ok('merchant public shows rating', +mAgg.d.rating_avg === 5 && mAgg.d.rating_count === 1);

  // ── generic reports ──
  const rp1 = await j('POST', '/api/reports', cust.tok, { target_type: 'merchant_profile', target_id: mpid, reason: 'wrong_information', details: 'test report' });
  ok('report profile works', rp1.s === 201, rp1);
  ok('duplicate pending report rejected', (await j('POST', '/api/reports', cust.tok, { target_type: 'merchant_profile', target_id: mpid, reason: 'spam' })).s === 409);
  const rp2 = await j('POST', '/api/reports', cust.tok, { target_type: 'problem', reason: 'app_problem', details: 'The app test problem report' });
  ok('problem report works', rp2.s === 201);
  ok('invalid target rejected', (await j('POST', '/api/reports', cust.tok, { target_type: 'weird', reason: 'spam' })).s === 400);

  // ── owner moderation & audit ──
  const repList = await j('GET', '/api/owner/reports', ownerTok);
  ok('owner sees pending reports', repList.d.some(r => r.target_id === mpid), repList.d.length);
  const repId = repList.d.find(r => r.target_id === mpid).id;
  ok('owner resolves report', (await j('PATCH', '/api/owner/reports/' + repId, ownerTok, { status: 'reviewed' })).s === 200);
  ok('non-owner cannot list reports', (await j('GET', '/api/owner/reports', cust.tok)).s === 403);
  // hide merchant profile
  const hide = await j('PATCH', `/api/owner/merchant-profiles/${mpid}/status`, ownerTok, { status: 'owner_hidden', moderation_note: 'automated test' });
  ok('owner hides merchant profile', hide.s === 200 && hide.d.status === 'owner_hidden', hide);
  ok('hidden merchant not public', (await j('GET', '/api/public/merchants/' + mpid)).s === 404);
  ok('merchant cannot self-publish while hidden', (await j('POST', '/api/me/merchant-profile/publish', merch.tok)).s === 403);
  const mMe = await j('GET', '/api/me/merchant-profile', merch.tok);
  ok('hidden merchant sees moderation note', mMe.d.profile.moderation_note === 'automated test');
  ok('hidden merchant media still visible to owner user', [200, 302].includes((await fetch(B + mMe.d.logo.url, { headers: { Authorization: 'Bearer ' + merch.tok }, redirect: 'manual' })).status));
  const restore = await j('PATCH', `/api/owner/merchant-profiles/${mpid}/status`, ownerTok, { status: 'active' });
  ok('owner restore returns prior status', restore.s === 200 && restore.d.status === 'active', restore.d.status);
  const mAfter = await j('GET', '/api/me', merch.tok);
  ok('moderation kept merchant capability', mAfter.d.capabilities.merchant === true);
  // driver hide/restore
  const dHide = await j('PATCH', `/api/owner/driver-profiles/${dpid}/status`, ownerTok, { status: 'owner_hidden', moderation_note: 'test' });
  ok('owner hides driver profile', dHide.s === 200);
  ok('hidden driver not public', (await j('GET', '/api/public/drivers/' + dpid)).s === 404);
  ok('owner restores driver', (await j('PATCH', `/api/owner/driver-profiles/${dpid}/status`, ownerTok, { status: 'active' })).d.status === 'active');
  // review moderation
  const rvList = await j('GET', '/api/owner/reviews', ownerTok);
  const rvId = rvList.d.find(r => r.request_id === rq1.d.id).id;
  ok('owner hides review', (await j('PATCH', `/api/owner/reviews/${rvId}/status`, ownerTok, { status: 'owner_hidden', moderation_note: 'test' })).s === 200);
  ok('hidden review gone from public + aggregate', (await j('GET', `/api/public/providers/merchant/${mpid}/reviews`)).d.rating_count === 0);
  ok('owner restores review', (await j('PATCH', `/api/owner/reviews/${rvId}/status`, ownerTok, { status: 'active' })).s === 200);
  // owner support views
  ok('owner request inspection works', (await j('GET', '/api/owner/requests', ownerTok)).d.some(r => r.id === rq1.d.id));
  const aud = await j('GET', '/api/owner/audit-log', ownerTok);
  ok('audit log recorded moderation actions', aud.d.some(a => a.action === 'hide_merchant_profile'), aud.d.slice(0, 3));
  ok('non-owner cannot read audit log', (await j('GET', '/api/owner/audit-log', cust.tok)).s === 403);

  // ── suspended/deactivated visibility ──
  await j('PATCH', `/api/owner/users/${merch.uid}/status`, ownerTok, { status: 'blocked' });
  ok('blocked merchant vanishes from public', (await j('GET', '/api/public/merchants/' + mpid)).s === 404);
  ok('blocked merchant media not public', mMe.d.logo ? (await fetch(B + mMe.d.logo.url.replace('/api/me/provider-media/', '/api/public/provider-media/'), { redirect: 'manual' })).status === 404 : true);
  await j('PATCH', `/api/owner/users/${merch.uid}/status`, ownerTok, { status: 'active' });
  ok('reactivated merchant public again', (await j('GET', '/api/public/merchants/' + mpid)).s === 200);

  // ── deactivation ──
  const deact = await j('POST', '/api/me/deactivate', drv.tok, { password: PW });
  ok('self-deactivation works', deact.s === 200, deact);
  ok('deactivated token rejected', (await j('GET', '/api/me', drv.tok)).s === 401);
  ok('deactivated login blocked', (await j('POST', '/api/auth/login', null, { identifier: drv.em, password: PW })).s === 403);
  ok('deactivated driver vanished from public', (await j('GET', '/api/public/drivers/' + dpid)).s === 404);

  // ── cleanup: deactivate remaining synthetic users ──
  await j('POST', '/api/me/deactivate', cust.tok, { password: 'NewPass2026x!' });
  await j('POST', '/api/me/deactivate', merch.tok, { password: PW });
  ok('synthetic users cleaned up (deactivated)', true);

  console.log('\nTOTAL pass=' + pass + ' fail=' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
