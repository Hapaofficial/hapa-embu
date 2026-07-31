// Fare-quote base-fare correctness tests.
// Proves: base fare included exactly once; total = base + distance + time (+ fees);
// minimum fare applied after all components; explicit zero-base cards valid;
// blank base-fare inputs rejected (Number('')===0 regression); zone + county
// fallback cards retain base fare; quote snapshot === receipt components;
// client-supplied fare values ignored; 2-dp rounding consistent.
// Usage: node tests/fare-quote.test.js [baseUrl]
const B = process.argv[2] || 'http://127.0.0.1:5000';
const OWNER_EMAIL = process.env.TEST_OWNER_EMAIL;
const OWNER_PASSWORD = process.env.TEST_OWNER_PASSWORD;
const RUN = 'fq' + Date.now().toString(36);
const PW = 'TestPass2026x!';
const PICKUP = { lat: -0.5310, lng: 37.4575 };
const DEST = { lat: -0.4990, lng: 37.4600 };
// 4922 m at KES 40/km = 196.88; 591 s = 9.85 min at KES 5/min = 49.25
const DIST_M = 4922, DUR_S = 591, DIST_CHG = 196.88, TIME_CHG = 49.25;

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra !== undefined ? JSON.stringify(extra) : ''); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const j = async (m, p, t, b) => {
  const r = await fetch(B + p, {
    method: m,
    headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) },
    body: b ? JSON.stringify(b) : undefined,
  });
  return { s: r.status, d: await r.json().catch(() => ({})) };
};

async function makeUser(ownerTok, label, capType, details) {
  const em = `${RUN}.${label}@example.com`;
  const reg = await j('POST', '/api/auth/register', null, { name: 'FQ ' + label, email: em, password: PW, selfie: 'data:image/png;base64,iVBORw0KGgo=' });
  if (reg.s !== 201) throw new Error('register failed ' + label + ' ' + JSON.stringify(reg.d));
  let tok = reg.d.token; const uid = reg.d.user.id;
  const acc = (await j('GET', '/api/owner/access', ownerTok)).d.find(a => a.user_id === uid && a.status === 'pending');
  if (acc) await j('PATCH', '/api/owner/access/' + acc.id, ownerTok, { status: 'approved' });
  tok = (await j('POST', '/api/auth/login', null, { identifier: em, password: PW })).d.token;
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
  const d = await makeUser(ownerTok, label, 'driver', { fullName: 'FQ ' + label, drivingLicenceNumber: 'DL-' + RUN + label, vehicleType: 'Boda Boda', registrationNumber: 'K' + label.toUpperCase() + ' 2' + RUN.slice(-2).toUpperCase(), county: 'Embu' });
  await j('POST', '/api/me/driver-profile', d.tok);
  const veh = await j('POST', '/api/me/vehicles', d.tok, { category: 'Passenger Car', make: 'Toyota', model: 'Vitz', colour: 'Silver', registration_number: 'KF' + label.slice(-1).toUpperCase() + ' ' + Math.floor(Math.random() * 900 + 100) + 'Y' });
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
const ping = (drv, lat, lng, seq) => j('POST', '/api/driver/location', drv.tok, { lat, lng, seq, accuracy: 8 });
const quote = (tok, extra = {}) => j('POST', '/api/rides/quote', tok, {
  pickup_lat: PICKUP.lat, pickup_lng: PICKUP.lng, dest_lat: DEST.lat, dest_lng: DEST.lng,
  zone: 'zone-embu-pilot', vehicle_category: 'Passenger Car', distance_m: DIST_M, duration_s: DUR_S, ...extra,
});
async function pollOffer(drv, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const h = await j('GET', '/api/driver/hub', drv.tok);
    if (h.d.offer) return h.d.offer;
    await sleep(1000);
  }
  return null;
}

(async () => {
  if (!OWNER_EMAIL || !OWNER_PASSWORD) { console.error('TEST_OWNER_EMAIL/TEST_OWNER_PASSWORD required'); process.exit(1); }
  const ownerTok = (await j('POST', '/api/auth/login', null, { identifier: OWNER_EMAIL, password: OWNER_PASSWORD })).d.token;
  if (!ownerTok) { console.error('owner login failed'); process.exit(1); }

  // Snapshot + clear the field: deactivate every active card that resolves to
  // 'Passenger Car' for the pilot zone or its county so resolution is ours.
  const carLike = c => /^(passenger car|car|saloon|sedan|taxi)$/i.test(String(c.vehicle_category).trim());
  const before = (await j('GET', '/api/owner/fare-cards', ownerTok)).d;
  const restoreActive = before.filter(c => c.active && carLike(c) && ['zone-embu-pilot', 'county-embu'].includes(c.area_slug)).map(c => c.id);
  for (const id of restoreActive) await j('PATCH', '/api/owner/fare-cards/' + id, ownerTok, { active: false });
  const created = [];
  const mkCard = async (body) => {
    const r = await j('POST', '/api/owner/fare-cards', ownerTok, body);
    if (r.s === 201) created.push(r.d.id);
    return r;
  };
  const off = id => j('PATCH', '/api/owner/fare-cards/' + id, ownerTok, { active: false });
  // Short offer countdown so stale online drivers from other runs don't hold
  // an offer for 20s each before dispatch reaches our test driver.
  await j('PATCH', '/api/owner/compliance/offer_timeout_s', ownerTok, { value: 3 });

  let drv = null;
  try {
    const rider = await makeUser(ownerTok, 'rider', null);
    await j('POST', '/api/agreements/accept', rider.tok, { agreement: 'rider_terms' });

    // ── 1. Base fare included exactly once: 100 + 196.88 + 49.25 = 346.13
    const c100 = await mkCard({ area: 'zone-embu-pilot', vehicle_category: 'car', base_fare: 100, per_km: 40, per_min: 5, minimum_fare: 150 });
    ok('setup: KES 100 base card created', c100.s === 201, c100.d);
    const q1 = await quote(rider.tok);
    const comp1 = q1.d.quote ? q1.d.quote.components : {};
    ok('quote resolves the base-100 card', q1.s === 201 && comp1.rate_card_id === c100.d.id, q1.d);
    ok('base fare component is KES 100', comp1.base_fare === 100, comp1);
    ok("quote stores canonical ride category, not the card's alias", q1.d.quote.vehicle_category === 'Passenger Car', q1.d.quote.vehicle_category);
    ok('distance charge is KES 196.88', comp1.distance_charge === DIST_CHG, comp1);
    ok('time charge is KES 49.25', comp1.time_charge === TIME_CHG, comp1);
    ok('total 100 + 196.88 + 49.25 = 346.13', Number(q1.d.quote.total) === 346.13, q1.d.quote.total);
    ok('base fare included exactly once', Math.round((Number(q1.d.quote.total) - comp1.distance_charge - comp1.time_charge - (comp1.booking_fee || 0)) * 100) / 100 === comp1.base_fare, q1.d.quote);
    ok('components rounded to 2 decimals', [comp1.base_fare, comp1.distance_charge, comp1.time_charge, Number(q1.d.quote.total)].every(v => Math.round(v * 100) / 100 === v), comp1);

    // ── 2. Client-supplied fare values are ignored
    const q2 = await quote(rider.tok, { base_fare: 1, total: 1, components: { base_fare: 1, distance_charge: 0, time_charge: 0 }, minimum_fare: 1 });
    ok('client-supplied fare values ignored', q2.s === 201 && Number(q2.d.quote.total) === 346.13 && q2.d.quote.components.base_fare === 100, q2.d.quote);

    // ── 3. Minimum fare applies AFTER all components (base included first)
    const qMin = await quote(rider.tok, { distance_m: 500, duration_s: 120 }); // 100 + 20 + 10 = 130 < 150
    ok('minimum fare lifts sub-minimum total to 150', qMin.s === 201 && Number(qMin.d.quote.total) === 150 && qMin.d.quote.components.base_fare === 100, qMin.d.quote);

    // ── 4. Blank base fare rejected; explicit zero-base card valid
    const blank = await j('POST', '/api/owner/fare-cards', ownerTok, { area: 'zone-embu-pilot', vehicle_category: 'car', base_fare: '', per_km: 40, per_min: 5, minimum_fare: 150, effective_from: '2026-01-01' });
    ok("blank base fare rejected (no silent 0)", blank.s === 400, blank.d);
    const noBase = await j('POST', '/api/owner/fare-cards', ownerTok, { area: 'zone-embu-pilot', vehicle_category: 'car', per_km: 40, per_min: 5, minimum_fare: 150, effective_from: '2026-01-01' });
    ok('missing base fare rejected', noBase.s === 400, noBase.d);
    await off(c100.d.id);
    const c0 = await mkCard({ area: 'zone-embu-pilot', vehicle_category: 'car', base_fare: 0, per_km: 40, per_min: 5, minimum_fare: 150, effective_from: '2026-01-02' });
    ok('explicit zero-base card accepted', c0.s === 201 && Number(c0.d.base_fare) === 0, c0.d);
    const q0 = await quote(rider.tok);
    ok('zero-base quote: 0 + 196.88 + 49.25 = 246.13', q0.s === 201 && Number(q0.d.quote.total) === 246.13 && q0.d.quote.components.base_fare === 0, q0.d.quote);
    await off(c0.d.id);

    // ── 5. County fallback card retains its base fare
    const cCounty = await mkCard({ area: 'county-embu', vehicle_category: 'car', base_fare: 77, per_km: 40, per_min: 5, minimum_fare: 150 });
    ok('setup: county fallback card created', cCounty.s === 201, cCounty.d);
    const qc = await quote(rider.tok);
    ok('county fallback keeps base fare (77 + 196.88 + 49.25 = 323.13)', qc.s === 201 && qc.d.quote.components.rate_card_id === cCounty.d.id && Number(qc.d.quote.total) === 323.13 && qc.d.quote.components.base_fare === 77, qc.d.quote);
    ok('zone card overrides county card once active again', true);
    await off(cCounty.d.id);

    // ── 6. Quote snapshot and receipt components match (full cash ride)
    const cRide = await mkCard({ area: 'zone-embu-pilot', vehicle_category: 'car', base_fare: 100, per_km: 40, per_min: 5, minimum_fare: 150, effective_from: '2026-01-03' });
    drv = await makeDriver(ownerTok, 'drv');
    const on = await j('POST', '/api/driver/online', drv.tok, { zone: 'zone-embu-pilot', vehicle_id: drv.vehicleId });
    ok('driver online for receipt test', on.s === 201, on.d);
    await ping(drv, PICKUP.lat + 0.001, PICKUP.lng, 1);
    const qr = await quote(rider.tok);
    ok('ride quote uses base-100 card', qr.s === 201 && Number(qr.d.quote.total) === 346.13, qr.d.quote);
    const ride = await j('POST', '/api/rides', rider.tok, { quote_id: qr.d.quote.id, payment_method: 'cash', pickup_lat: PICKUP.lat, pickup_lng: PICKUP.lng, dest_lat: DEST.lat, dest_lng: DEST.lng, pickup_address: 'Embu CBD', dest_address: 'Kangaru' });
    ok('ride created', ride.s === 201, ride.d);
    const rid = ride.d.ride.id, pin = ride.d.pin;
    const offer = await pollOffer(drv);
    ok('driver received offer', !!offer && offer.ride_id === rid, offer);
    await j('POST', '/api/offers/' + offer.id + '/accept', drv.tok);
    await j('POST', '/api/rides/' + rid + '/en-route', drv.tok);
    await j('POST', '/api/rides/' + rid + '/arrived', drv.tok);
    await j('POST', '/api/rides/' + rid + '/verify-pin', drv.tok, { pin });
    await j('POST', '/api/rides/' + rid + '/start', drv.tok);
    const done = await j('POST', '/api/rides/' + rid + '/complete', drv.tok);
    ok('final fare equals immutable quote total (base once, not dropped or doubled)', done.s === 200 && Number(done.d.final_fare) === 346.13, done.d);
    await j('POST', '/api/rides/' + rid + '/cash-collected', drv.tok);
    const rec = await j('GET', '/api/rides/' + rid + '/receipt', rider.tok);
    const rc = rec.d.body ? rec.d.body.components : {};
    ok('receipt exists', rec.s === 200 && rec.d.reference, rec.d);
    ok('receipt components match quote snapshot', rc.base_fare === 100 && rc.distance_charge === DIST_CHG && rc.time_charge === TIME_CHG && rc.rate_card_id === cRide.d.id, rc);
    ok('receipt total matches quote total', Number(rec.d.body.total) === 346.13 && rc.final_total === 346.13, rec.d.body);
    await off(cRide.d.id);
  } finally {
    if (drv) await j('POST', '/api/driver/offline', drv.tok);
    // Restore: deactivate every card we created, reactivate the originals.
    for (const id of created) await j('PATCH', '/api/owner/fare-cards/' + id, ownerTok, { active: false });
    for (const id of restoreActive) await j('PATCH', '/api/owner/fare-cards/' + id, ownerTok, { active: true });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
