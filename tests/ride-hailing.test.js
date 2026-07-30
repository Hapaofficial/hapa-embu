// Real-time ride-hailing E2E tests: dispatch, offers, state machine, PIN,
// cash + mock M-Pesa payments, receipts, ratings, chat, safety, owner ops,
// feature gates, and location privacy.
// Usage: node tests/ride-hailing.test.js [baseUrl]
const B = process.argv[2] || 'http://127.0.0.1:5000';
const OWNER_EMAIL = process.env.TEST_OWNER_EMAIL;
const OWNER_PASSWORD = process.env.TEST_OWNER_PASSWORD;
const RUN = 'rh' + Date.now().toString(36);
const PW = 'TestPass2026x!';
const PICKUP = { lat: -0.5310, lng: 37.4575 }; // Embu town
const DEST = { lat: -0.4990, lng: 37.4600 };   // Kangaru direction

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
  const reg = await j('POST', '/api/auth/register', null, { name: 'RH ' + label, email: em, password: PW, selfie: 'data:image/png;base64,iVBORw0KGgo=' });
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
async function makeDriver(ownerTok, label, opts = {}) {
  const d = await makeUser(ownerTok, label, 'driver', { fullName: 'RH ' + label, drivingLicenceNumber: 'DL-' + RUN + label, vehicleType: 'Boda Boda', registrationNumber: 'K' + label.toUpperCase() + ' 1' + RUN.slice(-2).toUpperCase(), county: 'Embu' });
  await j('POST', '/api/me/driver-profile', d.tok);
  const veh = await j('POST', '/api/me/vehicles', d.tok, { category: 'Passenger Car', make: 'Toyota', model: 'Vitz', colour: 'Silver', registration_number: 'KD' + label.slice(-1).toUpperCase() + ' ' + Math.floor(Math.random() * 900 + 100) + 'X' });
  if (veh.s !== 201) throw new Error('vehicle failed ' + JSON.stringify(veh.d));
  await j('PATCH', '/api/owner/vehicles/' + veh.d.id, ownerTok, { status: 'approved' });
  for (const t of DOCS) {
    const exp = (opts.expiredDoc === t) ? '2025-01-01' : '2027-12-31';
    const doc = await j('POST', '/api/me/driver-documents', d.tok, { doc_type: t, reference: 'REF-' + t, expires_on: exp });
    await j('PATCH', '/api/owner/driver-documents/' + doc.d.id, ownerTok, { status: 'approved' });
  }
  await j('POST', '/api/me/operating-zones', d.tok, { zone: 'zone-embu-pilot' });
  await j('POST', '/api/agreements/accept', d.tok, { agreement: 'driver_agreement' });
  return { ...d, vehicleId: veh.d.id };
}
const ping = (drv, lat, lng, seq) => j('POST', '/api/driver/location', drv.tok, { lat, lng, seq, accuracy: 8 });
async function getQuote(tok) {
  return j('POST', '/api/rides/quote', tok, { pickup_lat: PICKUP.lat, pickup_lng: PICKUP.lng, dest_lat: DEST.lat, dest_lng: DEST.lng, zone: 'zone-embu-pilot', vehicle_category: 'Passenger Car', distance_m: 5000, duration_s: 720 });
}
async function pollOffer(drv, tries = 8) {
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

  // Test setup: fast offer timeouts, pilot rate card for Passenger Car
  await j('PATCH', '/api/owner/compliance/offer_timeout_s', ownerTok, { value: 3 });
  await j('POST', '/api/owner/fare-cards', ownerTok, { area: 'zone-embu-pilot', vehicle_category: 'Passenger Car', base_fare: 100, per_km: 40, per_min: 5, minimum_fare: 150 });

  // ── 1. Config, gates, agreements
  const rider = await makeUser(ownerTok, 'rider', null);
  const cfgR = await j('GET', '/api/rides/config', rider.tok);
  ok('ride config available to users', cfgR.s === 200 && cfgR.d.enabled === true, cfgR.d);
  ok('boda passenger rides disabled for pilot', !cfgR.d.categories.some(c => /boda/i.test(c)));
  ok('mock routing clearly flagged without Maps key', typeof cfgR.d.mock_routing === 'boolean');
  const gates = await j('GET', '/api/owner/ride-gates', ownerTok);
  ok('owner activation gates report', gates.s === 200 && Array.isArray(gates.d.gates) && gates.d.gates.length >= 6, gates.d);
  ok('gates endpoint is owner-only', (await j('GET', '/api/owner/ride-gates', rider.tok)).s === 403);

  // ── 2. Quote: immutable snapshot, validation
  const badQ = await j('POST', '/api/rides/quote', rider.tok, { pickup_lat: 51.5, pickup_lng: -0.1, dest_lat: DEST.lat, dest_lng: DEST.lng });
  ok('quote rejects non-Kenya coordinates', badQ.s === 400);
  const q1 = await getQuote(rider.tok);
  ok('quote created with components + expiry', q1.s === 201 && q1.d.quote.total > 0 && q1.d.quote.components.base_fare === 100 && q1.d.quote.expires_at, q1.d);
  ok('quote total = base+booking+dist+time (min applied)', Number(q1.d.quote.total) === Math.max(150, 100 + 0 + 5 * 40 + 12 * 5), q1.d.quote.total);
  ok('commission capped at legal max', Number(q1.d.quote.components.commission_pct) <= 18, q1.d.quote.components);

  // ── 3. Rider terms gate, then no-driver flow
  const preTerms = await j('POST', '/api/rides', rider.tok, { quote_id: q1.d.quote.id, pickup_lat: PICKUP.lat, pickup_lng: PICKUP.lng, dest_lat: DEST.lat, dest_lng: DEST.lng, pickup_address: 'Embu CBD', dest_address: 'Kangaru' });
  ok('ride blocked until rider terms accepted', preTerms.s === 403 && preTerms.d.code === 'agreement_required', preTerms.d);
  await j('POST', '/api/agreements/accept', rider.tok, { agreement: 'rider_terms' });
  const idem = 'idem-' + RUN;
  const r1 = await j('POST', '/api/rides', rider.tok, { quote_id: q1.d.quote.id, idempotency_key: idem, pickup_lat: PICKUP.lat, pickup_lng: PICKUP.lng, dest_lat: DEST.lat, dest_lng: DEST.lng, pickup_address: 'Embu CBD', dest_address: 'Kangaru' });
  ok('ride created with 4-digit PIN', r1.s === 201 && /^\d{4}$/.test(r1.d.pin), r1.d);
  const ride1 = r1.d.ride.id;
  await sleep(2500);
  let v = await j('GET', '/api/rides/' + ride1, rider.tok);
  ok('no drivers online -> no_driver_available', v.d.ride.status === 'no_driver_available', v.d.ride.status);
  const dup = await j('POST', '/api/rides', rider.tok, { quote_id: q1.d.quote.id, idempotency_key: idem, pickup_lat: PICKUP.lat, pickup_lng: PICKUP.lng, dest_lat: DEST.lat, dest_lng: DEST.lng });
  ok('idempotency key returns same ride, no dup', dup.s === 200 && dup.d.duplicate === true && dup.d.ride.id === ride1, dup.d);

  // ── 4. Driver onboarding gates
  const noDocs = await makeUser(ownerTok, 'nodocs', 'driver', { fullName: 'RH nodocs', drivingLicenceNumber: 'DL-ND-' + RUN, vehicleType: 'Boda Boda', registrationNumber: 'KND 001Z', county: 'Embu' });
  const ndVeh = await j('POST', '/api/me/vehicles', noDocs.tok, { category: 'Passenger Car', registration_number: 'KND 900Q' });
  await j('PATCH', '/api/owner/vehicles/' + ndVeh.d.id, ownerTok, { status: 'approved' });
  await j('POST', '/api/me/operating-zones', noDocs.tok, { zone: 'zone-embu-pilot' });
  await j('POST', '/api/agreements/accept', noDocs.tok, { agreement: 'driver_agreement' });
  const ndOn = await j('POST', '/api/driver/online', noDocs.tok, { zone: 'zone-embu-pilot', vehicle_id: ndVeh.d.id });
  ok('missing documents block going online', ndOn.s === 403 && ndOn.d.reasons.some(r => /document/i.test(r)), ndOn.d);

  const expDrv = await makeDriver(ownerTok, 'expdoc', { expiredDoc: 'insurance' });
  const expOn = await j('POST', '/api/driver/online', expDrv.tok, { zone: 'zone-embu-pilot', vehicle_id: expDrv.vehicleId });
  ok('expired mandatory document blocks going online', expOn.s === 403 && expOn.d.reasons.some(r => /document/i.test(r)), expOn.d);

  const bodaVeh = await j('POST', '/api/me/vehicles', expDrv.tok, { category: 'Boda Boda', registration_number: 'KMC 555B' });
  ok('boda vehicle rejected while flag is off', bodaVeh.s === 400, bodaVeh.d);

  // ── 5. Driver A full flow: online, presence, offers
  const A = await makeDriver(ownerTok, 'drva');
  const onA = await j('POST', '/api/driver/online', A.tok, { zone: 'zone-embu-pilot', vehicle_id: A.vehicleId });
  ok('eligible driver goes online', onA.s === 201 && onA.d.session, onA.d);
  ok('double online rejected', (await j('POST', '/api/driver/online', A.tok, { zone: 'zone-embu-pilot', vehicle_id: A.vehicleId })).s === 409);
  ok('bad coordinates rejected', (await ping(A, 99, 200, 1)).s === 400);
  ok('location accepted while online', (await ping(A, PICKUP.lat + 0.001, PICKUP.lng, 2)).s === 200);
  ok('stale/out-of-order location rejected', (await ping(A, PICKUP.lat, PICKUP.lng, 1)).s === 409);

  // Retry the no-driver ride -> offer -> decline -> accept cycle
  const retry = await j('POST', '/api/rides/' + ride1 + '/retry', rider.tok);
  ok('rider can retry after no_driver_available', retry.s === 200 && retry.d.ride.status === 'searching', retry.d);
  let offer = await pollOffer(A);
  ok('nearest online driver receives timed offer', !!offer && offer.ride_id === ride1 && offer.quote_total, offer);
  ok('offer decline moves on', (await j('POST', '/api/offers/' + offer.id + '/decline', A.tok)).s === 200);
  await sleep(2500);
  v = await j('GET', '/api/rides/' + ride1, rider.tok);
  ok('declined by only driver -> no_driver_available', v.d.ride.status === 'no_driver_available', v.d.ride.status);
  await ping(A, PICKUP.lat + 0.001, PICKUP.lng, 3);
  await j('POST', '/api/rides/' + ride1 + '/retry', rider.tok);
  offer = await pollOffer(A);
  ok('retry re-dispatches to same driver', !!offer, offer);
  const acc = await j('POST', '/api/offers/' + offer.id + '/accept', A.tok);
  ok('driver accepts -> driver_assigned', acc.s === 200 && acc.d.ride.status === 'driver_assigned', acc.d);
  ok('second accept of same offer rejected', (await j('POST', '/api/offers/' + offer.id + '/accept', A.tok)).s === 409);

  // Rider sees driver + vehicle but never phone/documents
  v = await j('GET', '/api/rides/' + ride1, rider.tok);
  ok('rider sees driver name, vehicle, rating', v.d.ride.driver && v.d.ride.vehicle && v.d.ride.vehicle.registration_number, v.d.ride);
  ok('no phone/email/docs leaked to rider', !JSON.stringify(v.d.ride).match(/phone|email|licence_number|password/i), Object.keys(v.d.ride.driver || {}));
  ok('outsider cannot view ride', (await j('GET', '/api/rides/' + ride1, expDrv.tok)).s === 403);

  // ── 6. Lifecycle with PIN
  ok('start blocked before PIN', (await j('POST', '/api/rides/' + ride1 + '/start', A.tok)).s === 409);
  ok('en-route', (await j('POST', '/api/rides/' + ride1 + '/en-route', A.tok)).s === 200);
  ok('rider cannot drive the state machine', (await j('POST', '/api/rides/' + ride1 + '/arrived', rider.tok)).s === 403);
  ok('arrived', (await j('POST', '/api/rides/' + ride1 + '/arrived', A.tok)).s === 200);
  const wrongPin = await j('POST', '/api/rides/' + ride1 + '/verify-pin', A.tok, { pin: r1.d.pin === '0000' ? '9999' : '0000' });
  ok('wrong PIN rejected with attempts left', wrongPin.s === 400 && wrongPin.d.attempts_left >= 0, wrongPin.d);
  ok('correct PIN verifies', (await j('POST', '/api/rides/' + ride1 + '/verify-pin', A.tok, { pin: r1.d.pin })).s === 200);
  ok('ride starts', (await j('POST', '/api/rides/' + ride1 + '/start', A.tok)).s === 200);

  // Location samples flow to rider view during active ride
  await ping(A, PICKUP.lat + 0.005, PICKUP.lng + 0.002, 4);
  v = await j('GET', '/api/rides/' + ride1, rider.tok);
  ok('rider sees live driver position during trip', v.d.ride.driver_position && v.d.ride.driver_position.lat, v.d.ride.driver_position);

  // Chat: participants only
  ok('rider sends message', (await j('POST', '/api/rides/' + ride1 + '/messages', rider.tok, { body: 'Naona gari, asante!' })).s === 201);
  ok('driver sends message', (await j('POST', '/api/rides/' + ride1 + '/messages', A.tok, { body: 'Karibu.' })).s === 201);
  ok('outsider cannot read chat', (await j('GET', '/api/rides/' + ride1 + '/messages', expDrv.tok)).s === 403);
  ok('participants read chat', (await j('GET', '/api/rides/' + ride1 + '/messages', rider.tok)).d.length === 2);

  // Share trip: public minimal view
  const share = await j('POST', '/api/rides/' + ride1 + '/share', rider.tok);
  ok('rider creates share link', share.s === 201 && share.d.token, share.d);
  const pubTrip = await j('GET', '/api/public/trip/' + share.d.token);
  ok('public trip page shows status + vehicle only', pubTrip.s === 200 && pubTrip.d.vehicle && !JSON.stringify(pubTrip.d).match(/pickup_lat|phone|email|pin/i), pubTrip.d);
  await j('POST', '/api/rides/' + ride1 + '/share/revoke', rider.tok);
  ok('revoked share link stops working', (await j('GET', '/api/public/trip/' + share.d.token)).s === 404);

  // ── 7. Complete + cash payment + receipt + ratings
  const comp = await j('POST', '/api/rides/' + ride1 + '/complete', A.tok);
  ok('complete -> payment_pending with final fare', comp.s === 200 && comp.d.ride.status === 'payment_pending' && Number(comp.d.final_fare) > 0, comp.d);
  ok('rider cannot cancel after completion', (await j('POST', '/api/rides/' + ride1 + '/cancel', rider.tok)).s === 409);
  const cash = await j('POST', '/api/rides/' + ride1 + '/cash-collected', A.tok);
  ok('cash confirmed -> closed', cash.s === 200 && cash.d.ride.status === 'closed', cash.d);
  ok('cash double-confirm rejected', (await j('POST', '/api/rides/' + ride1 + '/cash-collected', A.tok)).s === 409);
  const rec = await j('GET', '/api/rides/' + ride1 + '/receipt', rider.tok);
  ok('receipt with HAPA reference + breakdown', rec.s === 200 && /^HAPA-/.test(rec.d.reference) && rec.d.body.components && rec.d.body.commission >= 0, rec.d);
  const hubA = await j('GET', '/api/driver/hub', A.tok);
  ok('driver earnings ledger updated (net = gross - commission)', Number(hubA.d.earnings.trips) === 1 && Number(hubA.d.earnings.total) > 0 && Number(hubA.d.earnings.total) < Number(comp.d.final_fare), hubA.d.earnings);
  ok('rider rates driver', (await j('POST', '/api/rides/' + ride1 + '/rate', rider.tok, { rating: 5, comment: 'Safi sana' })).s === 201);
  ok('driver rates rider', (await j('POST', '/api/rides/' + ride1 + '/rate', A.tok, { rating: 4 })).s === 201);
  ok('duplicate rating rejected', (await j('POST', '/api/rides/' + ride1 + '/rate', rider.tok, { rating: 1 })).s === 409);

  // ── 8. M-Pesa (mock mode, idempotent callback path)
  await ping(A, PICKUP.lat + 0.001, PICKUP.lng, 5);
  const q2 = await getQuote(rider.tok);
  const r2 = await j('POST', '/api/rides', rider.tok, { quote_id: q2.d.quote.id, payment_method: 'mpesa', pickup_lat: PICKUP.lat, pickup_lng: PICKUP.lng, dest_lat: DEST.lat, dest_lng: DEST.lng, pickup_address: 'Embu CBD', dest_address: 'Kangaru' });
  ok('mpesa ride created', r2.s === 201, r2.d);
  const of2 = await pollOffer(A);
  await j('POST', '/api/offers/' + of2.id + '/accept', A.tok);
  await j('POST', '/api/rides/' + r2.d.ride.id + '/arrived', A.tok);
  await j('POST', '/api/rides/' + r2.d.ride.id + '/verify-pin', A.tok, { pin: r2.d.pin });
  await j('POST', '/api/rides/' + r2.d.ride.id + '/start', A.tok);
  await j('POST', '/api/rides/' + r2.d.ride.id + '/complete', A.tok);
  const badPhone = await j('POST', '/api/rides/' + r2.d.ride.id + '/pay-mpesa', rider.tok, { phone: '0712' });
  ok('invalid phone rejected', badPhone.s === 400);
  const pay = await j('POST', '/api/rides/' + r2.d.ride.id + '/pay-mpesa', rider.tok, { phone: '254712345678' });
  ok('mock STK initiated and labelled', pay.s === 202 && pay.d.mode === 'mock' && /MOCK/i.test(pay.d.note), pay.d);
  ok('double payment initiation rejected', (await j('POST', '/api/rides/' + r2.d.ride.id + '/pay-mpesa', rider.tok, { phone: '254712345678' })).s === 409);
  await sleep(2500);
  v = await j('GET', '/api/rides/' + r2.d.ride.id, rider.tok);
  ok('mock callback confirms payment -> closed', v.d.ride.status === 'closed', v.d.ride.status);
  const rec2 = await j('GET', '/api/rides/' + r2.d.ride.id + '/receipt', rider.tok);
  ok('mpesa receipt records method + provider ref', rec2.d.body.payment_method === 'mpesa' && rec2.d.body.payment_ref, rec2.d.body);
  ok('garbage callback acknowledged without crash', (await j('POST', '/api/payments/mpesa/callback', null, { junk: true })).s === 200);
  const hubA2 = await j('GET', '/api/driver/hub', A.tok);
  ok('exactly one ledger entry per ride (idempotent finalize)', Number(hubA2.d.earnings.trips) === 2, hubA2.d.earnings);

  // ── 9. Offer expiry -> next driver; rider cancel with pending offer
  const Bdrv = await makeDriver(ownerTok, 'drvb');
  await j('POST', '/api/driver/online', Bdrv.tok, { zone: 'zone-embu-pilot', vehicle_id: Bdrv.vehicleId });
  await ping(Bdrv, PICKUP.lat + 0.02, PICKUP.lng, 1); // farther than A
  await ping(A, PICKUP.lat + 0.001, PICKUP.lng, 6);
  const q3 = await getQuote(rider.tok);
  const r3 = await j('POST', '/api/rides', rider.tok, { quote_id: q3.d.quote.id, pickup_lat: PICKUP.lat, pickup_lng: PICKUP.lng, dest_lat: DEST.lat, dest_lng: DEST.lng });
  const ofA = await pollOffer(A);
  ok('nearest driver offered first', !!ofA && ofA.ride_id === r3.d.ride.id, ofA);
  // A ignores; offer expires (3s) and B gets the next round
  const ofB = await pollOffer(Bdrv, 10);
  ok('expired offer advances to next driver', !!ofB && ofB.ride_id === r3.d.ride.id && ofB.round === 2, ofB);
  const cancel3 = await j('POST', '/api/rides/' + r3.d.ride.id + '/cancel', rider.tok, { reason: 'Changed plans' });
  ok('rider cancels during search', cancel3.s === 200 && cancel3.d.ride.status === 'rider_cancelled', cancel3.d);
  ok('pending offer withdrawn on cancel', (await j('GET', '/api/driver/hub', Bdrv.tok)).d.offer === null);
  const ofBAccept = await j('POST', '/api/offers/' + ofB.id + '/accept', Bdrv.tok);
  ok('accepting a withdrawn offer fails (no double assignment)', ofBAccept.s === 409, ofBAccept.d);

  // ── 10. Driver cancel requires reason; safety incident
  await ping(A, PICKUP.lat + 0.001, PICKUP.lng, 7);
  const q4 = await getQuote(rider.tok);
  const r4 = await j('POST', '/api/rides', rider.tok, { quote_id: q4.d.quote.id, pickup_lat: PICKUP.lat, pickup_lng: PICKUP.lng, dest_lat: DEST.lat, dest_lng: DEST.lng });
  const of4 = await pollOffer(A) || await pollOffer(Bdrv);
  const winner = of4 && (await j('GET', '/api/driver/hub', A.tok)).d.offer ? A : Bdrv;
  await j('POST', '/api/offers/' + of4.id + '/accept', winner.tok);
  ok('driver cancel without reason rejected', (await j('POST', '/api/rides/' + r4.d.ride.id + '/cancel', winner.tok)).s === 400);
  ok('driver cancel with reason works', (await j('POST', '/api/rides/' + r4.d.ride.id + '/cancel', winner.tok, { reason: 'Puncture' })).s === 200);
  const inc = await j('POST', '/api/safety/incidents', rider.tok, { ride_id: r4.d.ride.id, kind: 'other', description: 'Test incident' });
  ok('participant reports incident', inc.s === 201, inc.d);
  ok('owner resolves incident (audited)', (await j('PATCH', '/api/owner/incidents/' + inc.d.id, ownerTok, { status: 'resolved', note: 'Handled' })).s === 200);
  const emerg = await j('GET', '/api/rides/' + r4.d.ride.id + '/emergency', rider.tok);
  ok('emergency info endpoint responds', emerg.s === 200 && 'emergency_phone' in emerg.d, emerg.d);

  // ── 11. Trusted contacts
  const tc = await j('POST', '/api/me/trusted-contacts', rider.tok, { name: 'Mama', phone: '254700000001' });
  ok('trusted contact added', tc.s === 201, tc.d);
  ok('trusted contacts listed', (await j('GET', '/api/me/trusted-contacts', rider.tok)).d.length === 1);

  // ── 12. Owner ops: dashboard, ride detail, audited cancel
  const dash = await j('GET', '/api/owner/transport', ownerTok);
  ok('owner transport dashboard', dash.s === 200 && dash.d.stats.online_drivers >= 2 && dash.d.rides.length >= 4, dash.d.stats);
  ok('transport dashboard is owner-only', (await j('GET', '/api/owner/transport', rider.tok)).s === 403);
  const det = await j('GET', '/api/owner/rides/' + ride1, ownerTok);
  ok('owner ride detail: full timeline + payments + receipt', det.s === 200 && det.d.events.length >= 5 && det.d.receipt, { events: det.d.events?.length });
  await ping(A, PICKUP.lat + 0.001, PICKUP.lng, 8);
  const q5 = await getQuote(rider.tok);
  const r5 = await j('POST', '/api/rides', rider.tok, { quote_id: q5.d.quote.id, pickup_lat: PICKUP.lat, pickup_lng: PICKUP.lng, dest_lat: DEST.lat, dest_lng: DEST.lng });
  ok('owner cancel requires support note', (await j('POST', '/api/owner/rides/' + r5.d.ride.id + '/cancel', ownerTok)).s === 400);
  ok('owner cancels with note (audited)', (await j('POST', '/api/owner/rides/' + r5.d.ride.id + '/cancel', ownerTok, { note: 'Test ops cancellation' })).s === 200);

  // ── 13. Compliance guardrails + feature gate
  ok('commission above NTSA cap rejected', (await j('PATCH', '/api/owner/compliance/commission_max_pct', ownerTok, { value: 25 })).s === 400);
  ok('compliance settings listed with notes', (await j('GET', '/api/owner/compliance', ownerTok)).d.some(s => s.key === 'commission_max_pct' && /NTSA|Legal Notice/i.test(s.note)));
  await j('PATCH', '/api/owner/compliance/ride_hailing_enabled', ownerTok, { value: false });
  ok('feature gate off blocks quotes', (await getQuote(rider.tok)).s === 503);
  await j('PATCH', '/api/owner/compliance/ride_hailing_enabled', ownerTok, { value: true });
  ok('feature gate restores', (await getQuote(rider.tok)).s === 201);

  // ── 14. Quote misuse
  const foreign = await j('POST', '/api/rides', A.tok, { quote_id: q5.d.quote.id, pickup_lat: PICKUP.lat, pickup_lng: PICKUP.lng, dest_lat: DEST.lat, dest_lng: DEST.lng });
  ok('foreign quote rejected', foreign.s === 403 || foreign.s === 404, foreign);

  // ── 15. Offline cleanup
  ok('driver goes offline', (await j('POST', '/api/driver/offline', A.tok)).s === 200);
  ok('offline driver location rejected', (await ping(A, PICKUP.lat, PICKUP.lng, 9)).s === 409);
  await j('POST', '/api/driver/offline', Bdrv.tok);

  // Restore production-like config
  await j('PATCH', '/api/owner/compliance/offer_timeout_s', ownerTok, { value: 20 });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
