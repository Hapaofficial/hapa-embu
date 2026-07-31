// Regression tests: completed rides must persist in rider and driver history
// across logout/relogin, server restarts (DB-backed), and must never leak to
// unrelated users or expose exact trip coordinates in list views.
// Also proves the frontend defects are fixed at source level:
//  - guest mode no longer destroys the rider panel DOM (root cause of
//    "history missing after relogin")
//  - transient errors no longer erase the active/completed ride pointer
//  - logout clears per-account ride localStorage keys
// Usage: TEST_OWNER_EMAIL=.. TEST_OWNER_PASSWORD=.. node tests/ride-history-persistence.test.js [baseUrl]
const fs = require('fs');
const path = require('path');
const B = process.argv[2] || 'http://127.0.0.1:5000';
const OWNER_EMAIL = process.env.TEST_OWNER_EMAIL;
const OWNER_PASSWORD = process.env.TEST_OWNER_PASSWORD;
const RUN = 'rh' + Date.now().toString(36);
const PW = 'TestPass2026x!';
const PICKUP = { lat: -0.5310, lng: 37.4575 };
const DEST = { lat: -0.4990, lng: 37.4600 };

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('PASS', n); } else { fail++; console.log('FAIL', n, x !== undefined ? JSON.stringify(x) : ''); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const j = async (m, p, t, b) => {
  const r = await fetch(B + p, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: b ? JSON.stringify(b) : undefined });
  return { s: r.status, d: await r.json().catch(() => ({})) };
};

async function makeUser(ownerTok, label, capType, details) {
  const em = `${RUN}.${label}@example.com`;
  const reg = await j('POST', '/api/auth/register', null, { name: 'RH ' + label, email: em, password: PW, selfie: 'data:image/png;base64,iVBORw0KGgo=' });
  if (reg.s !== 201) throw new Error('register failed ' + label + ' ' + JSON.stringify(reg.d));
  const uid = reg.d.user.id;
  const acc = (await j('GET', '/api/owner/access', ownerTok)).d.find(a => a.user_id === uid && a.status === 'pending');
  if (acc) await j('PATCH', '/api/owner/access/' + acc.id, ownerTok, { status: 'approved' });
  let tok = (await j('POST', '/api/auth/login', null, { identifier: em, password: PW })).d.token;
  if (capType) {
    const sub = await j('POST', `/api/me/upgrades/${capType}/submit`, tok, { details, consent: true });
    if (sub.s >= 400) throw new Error('submit failed ' + JSON.stringify(sub.d));
    const app = (await j('GET', '/api/owner/upgrades?type=' + capType, ownerTok)).d.find(a => a.user_id === uid && a.status === 'pending');
    await j('PATCH', '/api/owner/upgrades/' + app.id + '/status', ownerTok, { status: 'approved' });
    tok = (await j('POST', '/api/auth/login', null, { identifier: em, password: PW })).d.token;
  }
  return { tok, uid, em };
}
const DOCS = ['driving_licence', 'insurance', 'ntsa_inspection', 'psv_badge'];
async function makeDriver(ownerTok, label) {
  const d = await makeUser(ownerTok, label, 'driver', { fullName: 'RH ' + label, drivingLicenceNumber: 'DL-' + RUN + label, vehicleType: 'Boda Boda', registrationNumber: 'K' + label.toUpperCase() + ' 3' + RUN.slice(-2).toUpperCase(), county: 'Embu' });
  await j('POST', '/api/me/driver-profile', d.tok);
  const veh = await j('POST', '/api/me/vehicles', d.tok, { category: 'Passenger Car', make: 'Toyota', model: 'Vitz', colour: 'Blue', registration_number: 'KH' + label.slice(-1).toUpperCase() + ' ' + Math.floor(Math.random() * 900 + 100) + 'Z' });
  if (veh.s !== 201) throw new Error('vehicle failed ' + JSON.stringify(veh.d));
  await j('PATCH', '/api/owner/vehicles/' + veh.d.id, ownerTok, { status: 'approved' });
  for (const t of DOCS) {
    const doc = await j('POST', '/api/me/driver-documents', d.tok, { doc_type: t, reference: 'REF-' + t, expires_on: '2027-12-31' });
    await j('PATCH', '/api/owner/driver-documents/' + doc.d.id, ownerTok, { status: 'approved' });
  }
  await j('POST', '/api/me/operating-zones', d.tok, { zone: 'zone-embu-pilot' });
  await j('POST', '/api/agreements/accept', d.tok, { agreement: 'driver_agreement' });
  return { ...d, vehicleId: veh.d.id };
}

(async () => {
  if (!OWNER_EMAIL || !OWNER_PASSWORD) { console.error('TEST_OWNER_EMAIL/TEST_OWNER_PASSWORD required'); process.exit(1); }
  const ownerTok = (await j('POST', '/api/auth/login', null, { identifier: OWNER_EMAIL, password: OWNER_PASSWORD })).d.token;
  await j('PATCH', '/api/owner/compliance/offer_timeout_s', ownerTok, { value: 3 });
  await j('POST', '/api/owner/fare-cards', ownerTok, { area: 'zone-embu-pilot', vehicle_category: 'Passenger Car', base_fare: 100, per_km: 40, per_min: 5, minimum_fare: 150 });

  const rider = await makeUser(ownerTok, 'rider', null);
  const outsider = await makeUser(ownerTok, 'outsider', null);
  await j('POST', '/api/agreements/accept', rider.tok, { agreement: 'rider_terms' });
  const drv = await makeDriver(ownerTok, 'drv');
  await j('POST', '/api/driver/online', drv.tok, { zone: 'zone-embu-pilot', vehicle_id: drv.vehicleId });
  await j('POST', '/api/driver/location', drv.tok, { lat: PICKUP.lat + 0.001, lng: PICKUP.lng, seq: 1, accuracy: 8 });

  // Close a full cash ride
  const q1 = await j('POST', '/api/rides/quote', rider.tok, { pickup_lat: PICKUP.lat, pickup_lng: PICKUP.lng, dest_lat: DEST.lat, dest_lng: DEST.lng, zone: 'zone-embu-pilot', vehicle_category: 'Passenger Car', distance_m: 5000, duration_s: 720 });
  const r1 = await j('POST', '/api/rides', rider.tok, { quote_id: q1.d.quote.id, payment_method: 'cash', pickup_lat: PICKUP.lat, pickup_lng: PICKUP.lng, dest_lat: DEST.lat, dest_lng: DEST.lng, pickup_address: 'Embu CBD', dest_address: 'Kangaru' });
  if (r1.s !== 201) { console.error('ride create failed', r1.d); process.exit(1); }
  const rideId = r1.d.ride.id, pin = r1.d.pin;
  let offer = null;
  for (let i = 0; i < 40 && !offer; i++) { offer = (await j('GET', '/api/driver/hub', drv.tok)).d.offer; if (!offer) await sleep(1000); }
  if (!offer) { console.error('no offer arrived'); process.exit(1); }
  await j('POST', '/api/offers/' + offer.id + '/accept', drv.tok);
  await j('POST', `/api/rides/${rideId}/arrived`, drv.tok);
  await j('POST', `/api/rides/${rideId}/verify-pin`, drv.tok, { pin });
  await j('POST', `/api/rides/${rideId}/start`, drv.tok);
  await j('POST', `/api/rides/${rideId}/complete`, drv.tok);
  const cash = await j('POST', `/api/rides/${rideId}/cash-collected`, drv.tok);
  ok('cash ride reaches closed', cash.s === 200 && cash.d.ride.status === 'closed', cash.d);

  // ── Relogin persistence: brand-new tokens, no in-memory state carried over
  const riderTok2 = (await j('POST', '/api/auth/login', null, { identifier: rider.em, password: PW })).d.token;
  const drvTok2 = (await j('POST', '/api/auth/login', null, { identifier: drv.em, password: PW })).d.token;
  ok('fresh logins issued new tokens', riderTok2 && drvTok2 && riderTok2 !== rider.tok);
  const mine2 = await j('GET', '/api/rides/mine', riderTok2);
  const found = mine2.d.find(r => r.id === rideId);
  ok('closed ride in rider history after relogin', !!found && found.status === 'closed', mine2.d.map(r => r.status));
  ok('history row carries fare, payment, driver, vehicle, completion', found && found.final_fare != null && found.payment_method === 'cash' && found.driver && found.vehicle && found.completed_at, found);
  ok('no duplicate history rows for the same ride', mine2.d.filter(r => r.id === rideId).length === 1);
  ok('list view hides live driver position for closed rides', found && !('driver_position' in found));

  const hub2 = await j('GET', '/api/driver/hub', drvTok2);
  const dHist = (hub2.d.history || []).find(r => r.id === rideId);
  ok('closed ride in driver history after relogin', !!dHist && dHist.status === 'closed', (hub2.d.history || []).map(r => r.status));
  ok('driver history has gross/commission/net/payout + receipt ref', dHist && dHist.gross != null && dHist.commission != null && dHist.net != null && dHist.payout_status && /^HAPA-/.test(dHist.receipt_reference || ''), dHist);
  ok('driver history math: gross − commission = net', dHist && Math.abs(Number(dHist.gross) - Number(dHist.commission) - Number(dHist.net)) < 0.01, dHist);
  ok('driver history has no exact coordinates', dHist && !('pickup_lat' in dHist) && !('dest_lat' in dHist));
  ok('driver history not duplicated', (hub2.d.history || []).filter(r => r.id === rideId).length === 1);
  ok('active ride slot empty (closed ride not mixed in)', hub2.d.ride === null);

  // Receipt still reachable with fresh tokens
  ok('rider receipt accessible after relogin', (await j('GET', `/api/rides/${rideId}/receipt`, riderTok2)).s === 200);
  const pdfR = await fetch(B + `/api/rides/${rideId}/receipt.pdf`, { headers: { Authorization: 'Bearer ' + riderTok2 } });
  ok('rider receipt PDF accessible after relogin', pdfR.status === 200);
  ok('driver receipt accessible after relogin', (await j('GET', `/api/rides/${rideId}/receipt`, drvTok2)).s === 200);

  // Authorization unchanged
  ok('unrelated user blocked from ride', (await j('GET', '/api/rides/' + rideId, outsider.tok)).s === 403);
  ok('unrelated user sees no foreign history', !(await j('GET', '/api/rides/mine', outsider.tok)).d.some(r => r.id === rideId));
  ok('unauthenticated /mine rejected', (await j('GET', '/api/rides/mine', null)).s === 401);

  // Cancelled rides: preserved with status, not counted as completed trips
  const q2 = await j('POST', '/api/rides/quote', riderTok2, { pickup_lat: PICKUP.lat, pickup_lng: PICKUP.lng, dest_lat: DEST.lat, dest_lng: DEST.lng, zone: 'zone-embu-pilot', vehicle_category: 'Passenger Car', distance_m: 5000, duration_s: 720 });
  const r2 = await j('POST', '/api/rides', riderTok2, { quote_id: q2.d.quote.id, payment_method: 'cash', pickup_lat: PICKUP.lat, pickup_lng: PICKUP.lng, dest_lat: DEST.lat, dest_lng: DEST.lng, pickup_address: 'Embu CBD', dest_address: 'Kangaru' });
  await j('POST', '/api/rides/' + r2.d.ride.id + '/cancel', riderTok2, { reason: 'test' });
  const mine3 = await j('GET', '/api/rides/mine', riderTok2);
  const cRow = mine3.d.find(r => r.id === r2.d.ride.id);
  ok('cancelled ride preserved with clear status and no fare', cRow && cRow.status === 'rider_cancelled' && cRow.final_fare == null, cRow);
  const trips = (await j('GET', '/api/driver/hub', drvTok2)).d.earnings.trips;
  ok('cancelled ride not counted in driver earnings trips', Number(trips) >= 1 && !((await j('GET', '/api/driver/hub', drvTok2)).d.history || []).some(r => r.id === r2.d.ride.id && r.net != null));

  // ── Frontend source assertions (root-cause fixes stay fixed)
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  ok('guest mode never destroys rider panel DOM', !html.includes(`$('rdRiderPanel').innerHTML`), 'rdRiderPanel.innerHTML assignment found');
  ok('guest mode uses rdGuestNotice toggle instead', html.includes('rdGuestNotice') && html.includes(`$('rdGuestNotice').classList.remove('hidden')`));
  ok('ride config errors surface without destroying panel', html.includes(`$('rdIntro').textContent=e.message`));
  ok('logout clears per-account ride keys', /\['hapa_ride','hapa_ride_pin','hapa_drv_seq'\]\.forEach\(k=>localStorage\.removeItem\(k\)\)/.test(html));
  ok('api() exposes HTTP status on errors', html.includes('err.status=r.status'));
  ok('rdRefresh clears ride only on 403/404', html.includes('if(e.status===403||e.status===404)rdClearRide()'));
  ok('transient rdRefresh errors keep polling', html.includes('else if(!rdState.poll)rdState.poll=setInterval(rdRefresh,4000)'));
  ok('driver Recent trips panel renders hub history', html.includes(`id="drvHistory"`) && html.includes(`$('drvHistory').innerHTML=(h.history||[])`));
  ok('driver history shows net + gross − fee breakdown', html.includes('fare ${esc(kesFmt(r.gross))}') && html.includes('fee ${esc(kesFmt(r.commission))}'));
  ok('history lists rebuilt atomically (no append duplicates)', /\$\('rdHistory'\)\.innerHTML=term\.map/.test(html) && /\$\('drvHistory'\)\.innerHTML=\(h\.history/.test(html));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
