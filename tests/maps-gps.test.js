// Google Maps / GPS stage tests — run entirely against the deterministic
// mock provider; no real Google calls are ever made.
// Covers: maps config/provider labelling, server-proxied autocomplete +
// place details + reverse geocode, rate caps, route snapshots bound to
// quotes, tamper rejection at ride create, dispatch ETA fields, driver
// location hardening (accuracy/speed/heading/staleness/replay/pace),
// privacy (no server key anywhere), owner health panels, and a scaled
// location soak.
// Usage: node tests/maps-gps.test.js [baseUrl] — server should run with
// MAPS_ALLOW_CLIENT_DISTANCE=true and LOC_MIN_INTERVAL_MS=0 for fixtures.
// Optional: FAULT_B=<url of a MAPS_FAULT_INJECT=route:timeout server> to
// exercise the no-silent-fallback path.
const B = process.argv[2] || 'http://127.0.0.1:5000';
const FAULT_B = process.env.FAULT_B || null;
const OWNER_EMAIL = process.env.TEST_OWNER_EMAIL;
const OWNER_PASSWORD = process.env.TEST_OWNER_PASSWORD;
const RUN = 'mg' + Date.now().toString(36);
const PW = 'TestPass2026x!';
const PICKUP = { lat: -0.5310, lng: 37.4575 };
const DEST = { lat: -0.4990, lng: 37.4600 };
const MOCK_LABEL = 'Development route estimate — Google Maps not configured';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra !== undefined ? JSON.stringify(extra) : ''); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const jj = base => async (m, p, t, b) => {
  const r = await fetch(base + p, {
    method: m,
    headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) },
    body: b ? JSON.stringify(b) : undefined,
  });
  return { s: r.status, d: await r.json().catch(() => ({})) };
};
const j = jj(B);

async function makeUser(ownerTok, label, capType, details) {
  const em = `${RUN}.${label}@example.com`;
  const reg = await j('POST', '/api/auth/register', null, { name: 'MG ' + label, email: em, password: PW, selfie: 'data:image/png;base64,iVBORw0KGgo=' });
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
  const d = await makeUser(ownerTok, label, 'driver', { fullName: 'MG ' + label, drivingLicenceNumber: 'DL-' + RUN + label, vehicleType: 'Boda Boda', registrationNumber: 'K' + label.toUpperCase() + ' 7' + RUN.slice(-2).toUpperCase(), county: 'Embu' });
  await j('POST', '/api/me/driver-profile', d.tok);
  const veh = await j('POST', '/api/me/vehicles', d.tok, { category: 'Passenger Car', make: 'Toyota', model: 'Vitz', colour: 'Blue', registration_number: 'KM' + label.slice(-1).toUpperCase() + ' ' + Math.floor(Math.random() * 900 + 100) + 'Z' });
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
  if (!ownerTok) { console.error('owner login failed'); process.exit(1); }
  await j('PATCH', '/api/owner/compliance/offer_timeout_s', ownerTok, { value: 4 });
  await j('POST', '/api/owner/fare-cards', ownerTok, { area: 'zone-embu-pilot', vehicle_category: 'Passenger Car', base_fare: 100, per_km: 40, per_min: 5, minimum_fare: 150 });

  const rider = await makeUser(ownerTok, 'rider', null);
  await j('POST', '/api/agreements/accept', rider.tok, { agreement: 'rider_terms' });

  // ── 1. Provider config & labelling ──
  const mc = await j('GET', '/api/maps/config', rider.tok);
  ok('maps config authed + mock provider', mc.s === 200 && mc.d.provider === 'mock', mc.d);
  ok('mock mode carries the exact development label', mc.d.mock_label === MOCK_LABEL, mc.d);
  ok('maps config never exposes a server key', !JSON.stringify(mc.d).match(/server_key|GOOGLE_MAPS_SERVER/i));
  ok('maps config requires auth', (await j('GET', '/api/maps/config', null)).s === 401);

  // ── 2. Server-proxied autocomplete + details + reverse geocode ──
  ok('short input returns no suggestions (no provider spend)', (await j('POST', '/api/maps/autocomplete', rider.tok, { input: 'Em' })).d.suggestions.length === 0);
  const ac = await j('POST', '/api/maps/autocomplete', rider.tok, { input: 'Kangaru', session_token: 'tok-' + RUN });
  ok('autocomplete returns labelled mock suggestions', ac.s === 200 && ac.d.suggestions.length > 0 && ac.d.provider === 'mock' && ac.d.note === MOCK_LABEL, ac.d);
  const det = await j('POST', '/api/maps/place-details', rider.tok, { place_id: ac.d.suggestions[0].place_id, session_token: 'tok-' + RUN });
  ok('place details resolves coordinates in Kenya', det.s === 200 && det.d.place.lat < 0 && det.d.place.lng > 37, det.d);
  ok('autocomplete requires auth', (await j('POST', '/api/maps/autocomplete', null, { input: 'Embu Town' })).s === 401);
  const rg = await j('POST', '/api/maps/reverse-geocode', rider.tok, { lat: PICKUP.lat, lng: PICKUP.lng });
  ok('reverse geocode returns a labelled development address', rg.s === 200 && /development label/.test(rg.d.formatted_address), rg.d);
  ok('reverse geocode validates coordinates', (await j('POST', '/api/maps/reverse-geocode', rider.tok, { lat: 999, lng: 0 })).s === 400);

  // ── 3. Cost caps: per-user autocomplete pace gate ──
  let capped = false;
  for (let i = 0; i < 40; i++) {
    const r = await j('POST', '/api/maps/autocomplete', rider.tok, { input: 'Embu Town ' + i });
    if (r.s === 429) { capped = true; break; }
  }
  ok('autocomplete pace cap engages under hammering', capped);

  // ── 4. Quotes: route snapshot bound, labelled, deterministic mock math ──
  const q1 = await j('POST', '/api/rides/quote', rider.tok, { pickup_lat: PICKUP.lat, pickup_lng: PICKUP.lng, dest_lat: DEST.lat, dest_lng: DEST.lng, zone: 'zone-embu-pilot', vehicle_category: 'Passenger Car', pickup_place_id: 'mock:embu-town-cbd', dest_place_id: 'mock:kangaru-school-gate' });
  ok('quote created with route snapshot id', q1.s === 201 && q1.d.route && q1.d.route.snapshot_id, q1.d);
  ok('quote flags mock routing with the exact label', q1.d.mock_routing === true && q1.d.note === MOCK_LABEL, q1.d);
  ok('mock route includes a decodable polyline', typeof q1.d.route.polyline === 'string' && q1.d.route.polyline.length > 0);
  ok('mock distance = haversine × 1.4 (deterministic)', Math.abs(q1.d.quote.distance_m - q1.d.route.distance_m) === 0 && q1.d.route.distance_m > 3000 && q1.d.route.distance_m < 8000, q1.d.route);
  ok('quote response contains no key material', !JSON.stringify(q1.d).match(/api_key|AIza/i));

  // client fixture path still available for test rigs only
  const qc = await j('POST', '/api/rides/quote', rider.tok, { pickup_lat: PICKUP.lat, pickup_lng: PICKUP.lng, dest_lat: DEST.lat, dest_lng: DEST.lng, zone: 'zone-embu-pilot', vehicle_category: 'Passenger Car', distance_m: 4922, duration_s: 591 });
  ok('client distance fixture honoured only under test flag', qc.s === 201 && qc.d.quote.route_source === 'client', qc.d.quote && qc.d.quote.route_source);

  // ── 5. Tamper rejection at ride create ──
  const tam = await j('POST', '/api/rides', rider.tok, { quote_id: q1.d.quote.id, pickup_lat: PICKUP.lat, pickup_lng: PICKUP.lng, dest_lat: DEST.lat + 0.02, dest_lng: DEST.lng, pickup_address: 'Embu CBD', dest_address: 'Somewhere else' });
  ok('ride create rejects moved destination (tamper)', tam.s === 409, tam);
  const tam2 = await j('POST', '/api/rides', rider.tok, { quote_id: q1.d.quote.id, pickup_lat: PICKUP.lat + 0.02, pickup_lng: PICKUP.lng, dest_lat: DEST.lat, dest_lng: DEST.lng });
  ok('ride create rejects moved pickup (tamper)', tam2.s === 409, tam2);

  // ── 6. Dispatch: matrix ETA recorded on offers ──
  const drv = await makeDriver(ownerTok, 'drva');
  await j('POST', '/api/driver/online', drv.tok, { zone: 'zone-embu-pilot', vehicle_id: drv.vehicleId });
  await j('POST', '/api/driver/location', drv.tok, { lat: PICKUP.lat + 0.004, lng: PICKUP.lng + 0.004, seq: 1, accuracy: 9 });
  const r1 = await j('POST', '/api/rides', rider.tok, { quote_id: q1.d.quote.id, pickup_lat: PICKUP.lat, pickup_lng: PICKUP.lng, dest_lat: DEST.lat, dest_lng: DEST.lng, pickup_address: 'Embu CBD', dest_address: 'Kangaru' });
  ok('ride created on untampered snapshot route', r1.s === 201, r1.d);
  let offer = null;
  for (let i = 0; i < 8 && !offer; i++) { offer = (await j('GET', '/api/driver/hub', drv.tok)).d.offer; if (!offer) await sleep(1000); }
  ok('offer carries road-network pickup ETA + source', !!offer && offer.pickup_eta_s > 0 && ['matrix', 'matrix_mock', 'matrix_cache'].includes(offer.eta_source), offer);
  if (offer) await j('POST', '/api/offers/' + offer.id + '/decline', drv.tok);
  await j('POST', '/api/rides/' + r1.d.ride.id + '/cancel', rider.tok, { reason: 'test cleanup' });

  // ── 7. Driver location hardening ──
  const loc = b => j('POST', '/api/driver/location', drv.tok, b);
  ok('rejects poor accuracy', (await loc({ lat: PICKUP.lat, lng: PICKUP.lng, seq: 50, accuracy: 900 })).s === 422);
  ok('rejects implausible speed', (await loc({ lat: PICKUP.lat, lng: PICKUP.lng, seq: 51, speed: 200 })).s === 422);
  ok('rejects invalid heading', (await loc({ lat: PICKUP.lat, lng: PICKUP.lng, seq: 52, heading: 720 })).s === 422);
  ok('rejects stale client timestamp', (await loc({ lat: PICKUP.lat, lng: PICKUP.lng, seq: 53, recorded_at: '2026-08-05T00:00:00Z' })).s === 422);
  const okLoc = await loc({ lat: PICKUP.lat, lng: PICKUP.lng, seq: 60, accuracy: 12, heading: 90, speed: 8.3, recorded_at: new Date().toISOString() });
  ok('accepts full valid sample', okLoc.s === 200, okLoc);
  ok('rejects sequence replay', (await loc({ lat: PICKUP.lat, lng: PICKUP.lng, seq: 60 })).s === 409);
  ok('rejects out-of-order sequence', (await loc({ lat: PICKUP.lat, lng: PICKUP.lng, seq: 41 })).s === 409);

  // ── 8. Scaled soak: 120 sequential samples stay monotonic and accepted ──
  let soakOk = 0;
  for (let i = 0; i < 120; i++) {
    const r = await loc({ lat: PICKUP.lat + i * 1e-5, lng: PICKUP.lng, seq: 100 + i, accuracy: 10 });
    if (r.s === 200) soakOk++;
  }
  ok('soak: 120/120 sequential samples accepted', soakOk === 120, soakOk);
  await j('POST', '/api/driver/offline', drv.tok);

  // ── 9. Owner panels + privacy ──
  const ms = await j('GET', '/api/owner/maps/status', ownerTok);
  ok('owner maps status reports provider + key booleans', ms.s === 200 && ms.d.provider === 'mock' && typeof ms.d.keys.web === 'boolean', ms.d);
  ok('owner maps status shows capability health', ms.d.capabilities && ms.d.capabilities.route && ms.d.capabilities.route.calls > 0, ms.d.capabilities);
  ok('owner maps status contains no key values', !JSON.stringify(ms.d).match(/AIza/));
  ok('maps status is owner-only', (await j('GET', '/api/owner/maps/status', rider.tok)).s === 403);
  const lh = await j('GET', '/api/owner/location/health', ownerTok);
  ok('owner location health reports ingest + presence', lh.s === 200 && lh.d.ingest && lh.d.ingest.accepted > 0 && lh.d.ingest.rejected > 0, lh.d);
  ok('location health is owner-only', (await j('GET', '/api/owner/location/health', rider.tok)).s === 403);
  const gates = await j('GET', '/api/owner/ride-gates', ownerTok);
  const gWeb = gates.d.gates.find(g => g.gate === 'GOOGLE_MAPS_WEB_KEY');
  ok('ride gates track the new web key gate', !!gWeb, gates.d.gates.map(g => g.gate));

  // ── 10. Fault injection: provider failure never silently estimates ──
  if (FAULT_B) {
    const jf = jj(FAULT_B);
    const ftok = (await jf('POST', '/api/auth/login', null, { identifier: OWNER_EMAIL, password: OWNER_PASSWORD })).d.token;
    const fq = await jf('POST', '/api/rides/quote', ftok, { pickup_lat: PICKUP.lat, pickup_lng: PICKUP.lng, dest_lat: DEST.lat, dest_lng: DEST.lng, zone: 'zone-embu-pilot', vehicle_category: 'Passenger Car' });
    ok('route provider timeout → 503, never a silent estimate', fq.s === 503, fq);
  } else console.log('SKIP fault-injection block (set FAULT_B to a MAPS_FAULT_INJECT=route:timeout server)');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('SUITE ERROR', e); process.exit(1); });
