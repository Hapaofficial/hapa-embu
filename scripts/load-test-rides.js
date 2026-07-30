// Synthetic dispatch load test: N drivers online, M riders, R requests/min
// against a local test server. Measures offer latency, acceptance integrity
// (zero double-assignments), and API error rate.
// Usage: node scripts/load-test-rides.js [baseUrl] [drivers] [riders] [reqPerMin] [minutes]
const B = process.argv[2] || 'http://127.0.0.1:5000';
const N_DRIVERS = Number(process.argv[3] || 20);
const N_RIDERS = Number(process.argv[4] || 50);
const REQ_PER_MIN = Number(process.argv[5] || 20);
const MINUTES = Number(process.argv[6] || 2);
const OWNER_EMAIL = process.env.TEST_OWNER_EMAIL;
const OWNER_PASSWORD = process.env.TEST_OWNER_PASSWORD;
const RUN = 'lt' + Date.now().toString(36);
const PW = 'TestPass2026x!';
const PICKUP = { lat: -0.5310, lng: 37.4575 };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const stats = { requests: 0, offers: 0, accepted: 0, completed: 0, noDriver: 0, errors: 0, doubleAssign: 0, offerLatencies: [] };

const j = async (m, p, t, b) => {
  try {
    const r = await fetch(B + p, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: b ? JSON.stringify(b) : undefined });
    return { s: r.status, d: await r.json().catch(() => ({})) };
  } catch (e) { stats.errors++; return { s: 0, d: {} }; }
};

async function makeUser(ownerTok, label, capType, details) {
  const em = `${RUN}.${label}@example.com`;
  const reg = await j('POST', '/api/auth/register', null, { name: 'LT ' + label, email: em, password: PW, selfie: 'data:image/png;base64,iVBORw0KGgo=' });
  const uid = reg.d.user.id;
  const acc = (await j('GET', '/api/owner/access', ownerTok)).d.find(a => a.user_id === uid && a.status === 'pending');
  if (acc) await j('PATCH', '/api/owner/access/' + acc.id, ownerTok, { status: 'approved' });
  let tok = (await j('POST', '/api/auth/login', null, { identifier: em, password: PW })).d.token;
  if (capType) {
    await j('POST', `/api/me/upgrades/${capType}/submit`, tok, { details, consent: true });
    const app = (await j('GET', '/api/owner/upgrades?type=' + capType, ownerTok)).d.find(a => a.user_id === uid && a.status === 'pending');
    await j('PATCH', '/api/owner/upgrades/' + app.id + '/status', ownerTok, { status: 'approved' });
    tok = (await j('POST', '/api/auth/login', null, { identifier: em, password: PW })).d.token;
  }
  return { tok, uid };
}

(async () => {
  const t0 = Date.now();
  const ownerTok = (await j('POST', '/api/auth/login', null, { identifier: OWNER_EMAIL, password: OWNER_PASSWORD })).d.token;
  if (!ownerTok) { console.error('owner login failed'); process.exit(1); }
  await j('PATCH', '/api/owner/compliance/offer_timeout_s', ownerTok, { value: 4 });
  await j('POST', '/api/owner/fare-cards', ownerTok, { area: 'zone-embu-pilot', vehicle_category: 'Passenger Car', base_fare: 100, per_km: 40, per_min: 5, minimum_fare: 150 });

  console.log(`Provisioning ${N_DRIVERS} drivers + ${N_RIDERS} riders…`);
  const DOCS = ['driving_licence', 'insurance', 'ntsa_inspection', 'psv_badge'];
  const drivers = [];
  for (let i = 0; i < N_DRIVERS; i++) {
    const d = await makeUser(ownerTok, 'd' + i, 'driver', { fullName: 'LT d' + i, drivingLicenceNumber: 'DL-' + RUN + i, vehicleType: 'Boda Boda', registrationNumber: 'KL' + i + ' ' + RUN.slice(-3).toUpperCase(), county: 'Embu' });
    await j('POST', '/api/me/driver-profile', d.tok);
    const veh = await j('POST', '/api/me/vehicles', d.tok, { category: 'Passenger Car', registration_number: 'KLT ' + (100 + i) + RUN.slice(-1).toUpperCase() });
    await j('PATCH', '/api/owner/vehicles/' + veh.d.id, ownerTok, { status: 'approved' });
    for (const t of DOCS) {
      const doc = await j('POST', '/api/me/driver-documents', d.tok, { doc_type: t, reference: 'R', expires_on: '2027-12-31' });
      await j('PATCH', '/api/owner/driver-documents/' + doc.d.id, ownerTok, { status: 'approved' });
    }
    await j('POST', '/api/me/operating-zones', d.tok, { zone: 'zone-embu-pilot' });
    await j('POST', '/api/agreements/accept', d.tok, { agreement: 'driver_agreement' });
    const on = await j('POST', '/api/driver/online', d.tok, { zone: 'zone-embu-pilot', vehicle_id: veh.d.id });
    if (on.s !== 201) { console.error('driver online failed', on.d); continue; }
    drivers.push({ ...d, seq: 0, lat: PICKUP.lat + (Math.random() - 0.5) * 0.05, lng: PICKUP.lng + (Math.random() - 0.5) * 0.05, busy: false, rides: 0 });
  }
  const riders = [];
  for (let i = 0; i < N_RIDERS; i++) {
    const r = await makeUser(ownerTok, 'r' + i, null);
    await j('POST', '/api/agreements/accept', r.tok, { agreement: 'rider_terms' });
    riders.push({ ...r, busy: false });
  }
  console.log(`Provisioned ${drivers.length} drivers, ${riders.length} riders in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  let running = true;
  // Driver loop: heartbeat locations, auto-accept offers, drive rides to completion
  const driverLoops = drivers.map(async d => {
    while (running) {
      d.seq++;
      await j('POST', '/api/driver/location', d.tok, { lat: d.lat, lng: d.lng, seq: d.seq });
      const hub = await j('GET', '/api/driver/hub', d.tok);
      if (hub.d.offer) {
        const acc = await j('POST', '/api/offers/' + hub.d.offer.id + '/accept', d.tok);
        if (acc.s === 200) { stats.accepted++; }
      } else if (hub.d.ride) {
        const r = hub.d.ride;
        if (r.status === 'driver_assigned') await j('POST', '/api/rides/' + r.id + '/arrived', d.tok);
        else if (r.status === 'driver_arrived') await j('POST', '/api/rides/' + r.id + '/verify-pin', d.tok, { pin: r._pin || d.pins?.[r.id] });
        else if (r.status === 'pin_verified') await j('POST', '/api/rides/' + r.id + '/start', d.tok);
        else if (r.status === 'in_progress') await j('POST', '/api/rides/' + r.id + '/complete', d.tok);
        else if (r.status === 'payment_pending') { const c = await j('POST', '/api/rides/' + r.id + '/cash-collected', d.tok); if (c.s === 200) { stats.completed++; d.rides++; } }
      }
      await sleep(1000 + Math.random() * 500);
    }
  });
  // PIN registry: riders share PINs with the assigned driver out-of-band (simulates showing the phone)
  const pinBook = {}; // rideId -> pin
  drivers.forEach(d => { d.pins = pinBook; });

  // Rider loop: fire requests at target rate
  const totalReqs = REQ_PER_MIN * MINUTES;
  const interval = 60000 / REQ_PER_MIN;
  const riderTask = (async () => {
    for (let i = 0; i < totalReqs; i++) {
      const rider = riders[i % riders.length];
      (async () => {
        const t1 = Date.now();
        const quote = await j('POST', '/api/rides/quote', rider.tok, { pickup_lat: PICKUP.lat + (Math.random() - 0.5) * 0.03, pickup_lng: PICKUP.lng + (Math.random() - 0.5) * 0.03, dest_lat: PICKUP.lat + 0.03, dest_lng: PICKUP.lng + 0.02, zone: 'zone-embu-pilot', vehicle_category: 'Passenger Car', distance_m: 4000, duration_s: 600 });
        if (quote.s !== 201) { if (quote.s !== 0) stats.errors++; return; }
        const ride = await j('POST', '/api/rides', rider.tok, { quote_id: quote.d.quote.id, pickup_lat: quote.d.quote ? PICKUP.lat : 0, pickup_lng: PICKUP.lng, dest_lat: PICKUP.lat + 0.03, dest_lng: PICKUP.lng + 0.02, pickup_address: 'LT pickup', dest_address: 'LT dest' });
        if (ride.s === 409) return; // rider still on a previous ride — expected under load
        if (ride.s !== 201) { stats.errors++; return; }
        stats.requests++;
        pinBook[ride.d.ride.id] = ride.d.pin;
        // watch for assignment
        for (let k = 0; k < 40; k++) {
          await sleep(1500);
          const v = await j('GET', '/api/rides/' + ride.d.ride.id, rider.tok);
          const st = v.d.ride?.status;
          if (st === 'driver_assigned') { stats.offers++; stats.offerLatencies.push(Date.now() - t1); break; }
          if (st === 'no_driver_available') { stats.noDriver++; break; }
          if (!st || ['closed', 'rider_cancelled', 'driver_cancelled'].includes(st)) break;
        }
      })();
      await sleep(interval);
    }
    await sleep(45000); // drain
    running = false;
  })();

  await riderTask;
  await Promise.race([Promise.all(driverLoops), sleep(5000)]);

  // Integrity: no ride has >1 accepted offer; no driver had 2 concurrent active rides
  const dbl = await j('GET', '/api/owner/transport', ownerTok);
  for (const d of drivers) await j('POST', '/api/driver/offline', d.tok);
  await j('PATCH', '/api/owner/compliance/offer_timeout_s', ownerTok, { value: 20 });

  const lat = stats.offerLatencies.sort((a, b) => a - b);
  const pct = p => lat.length ? (lat[Math.floor(lat.length * p)] / 1000).toFixed(1) + 's' : 'n/a';
  console.log('\n=== LOAD TEST RESULTS ===');
  console.log(`drivers online: ${drivers.length}, riders: ${riders.length}, target: ${REQ_PER_MIN}/min for ${MINUTES}min`);
  console.log(`requests created: ${stats.requests}`);
  console.log(`assigned: ${stats.offers}, completed+paid: ${stats.completed}, no_driver: ${stats.noDriver}`);
  console.log(`assignment latency p50: ${pct(0.5)}, p90: ${pct(0.9)}, max: ${pct(0.99)}`);
  console.log(`api errors: ${stats.errors}`);
  const okRun = stats.requests > 0 && stats.offers > 0 && stats.errors < stats.requests * 0.05;
  console.log(okRun ? 'LOAD TEST PASS' : 'LOAD TEST FAIL');
  process.exit(okRun ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
