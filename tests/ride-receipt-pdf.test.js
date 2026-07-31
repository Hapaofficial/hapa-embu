// Backend tests: authenticated ride receipt PDF endpoint.
// Full cash ride to closed, then verifies auth (401/403/404), PDF signature,
// headers, sanitized filename, and absence of internal accounting fields.
// Usage: TEST_OWNER_EMAIL=.. TEST_OWNER_PASSWORD=.. node tests/ride-receipt-pdf.test.js [baseUrl]
const B = process.argv[2] || 'http://127.0.0.1:5000';
const OWNER_EMAIL = process.env.TEST_OWNER_EMAIL;
const OWNER_PASSWORD = process.env.TEST_OWNER_PASSWORD;
const RUN = 'rp' + Date.now().toString(36);
const PW = 'TestPass2026x!';
const PICKUP = { lat: -0.5310, lng: 37.4575 };
const DEST = { lat: -0.4990, lng: 37.4600 };

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
const raw = async (p, t) => {
  const r = await fetch(B + p, { headers: t ? { Authorization: 'Bearer ' + t } : {} });
  const buf = Buffer.from(await r.arrayBuffer());
  return { s: r.status, buf, h: Object.fromEntries(r.headers.entries()) };
};

async function makeUser(ownerTok, label, capType, details) {
  const em = `${RUN}.${label}@example.com`;
  const reg = await j('POST', '/api/auth/register', null, { name: 'RP ' + label, email: em, password: PW, selfie: 'data:image/png;base64,iVBORw0KGgo=' });
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
  const d = await makeUser(ownerTok, label, 'driver', { fullName: 'RP ' + label, drivingLicenceNumber: 'DL-' + RUN + label, vehicleType: 'Boda Boda', registrationNumber: 'K' + label.toUpperCase() + ' 2' + RUN.slice(-2).toUpperCase(), county: 'Embu' });
  await j('POST', '/api/me/driver-profile', d.tok);
  const veh = await j('POST', '/api/me/vehicles', d.tok, { category: 'Passenger Car', make: 'Toyota', model: 'Vitz', colour: 'Silver', registration_number: 'KR' + label.slice(-1).toUpperCase() + ' ' + Math.floor(Math.random() * 900 + 100) + 'Y' });
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

(async () => {
  if (!OWNER_EMAIL || !OWNER_PASSWORD) { console.error('TEST_OWNER_EMAIL/TEST_OWNER_PASSWORD required'); process.exit(1); }
  const ownerTok = (await j('POST', '/api/auth/login', null, { identifier: OWNER_EMAIL, password: OWNER_PASSWORD })).d.token;
  if (!ownerTok) { console.error('owner login failed'); process.exit(1); }

  await j('PATCH', '/api/owner/compliance/offer_timeout_s', ownerTok, { value: 3 });
  await j('POST', '/api/owner/fare-cards', ownerTok, { area: 'zone-embu-pilot', vehicle_category: 'Passenger Car', base_fare: 100, per_km: 40, per_min: 5, minimum_fare: 150 });

  const rider = await makeUser(ownerTok, 'rider', null);
  const outsider = await makeUser(ownerTok, 'outsider', null);
  await j('POST', '/api/agreements/accept', rider.tok, { agreement: 'rider_terms' });
  const drv = await makeDriver(ownerTok, 'drv');
  await j('POST', '/api/driver/online', drv.tok, { zone: 'zone-embu-pilot', vehicle_id: drv.vehicleId });
  await ping(drv, PICKUP.lat + 0.001, PICKUP.lng, 1);

  // Full cash ride to closed
  const q1 = await j('POST', '/api/rides/quote', rider.tok, { pickup_lat: PICKUP.lat, pickup_lng: PICKUP.lng, dest_lat: DEST.lat, dest_lng: DEST.lng, zone: 'zone-embu-pilot', vehicle_category: 'Passenger Car', distance_m: 5000, duration_s: 720 });
  const r1 = await j('POST', '/api/rides', rider.tok, { quote_id: q1.d.quote.id, payment_method: 'cash', pickup_lat: PICKUP.lat, pickup_lng: PICKUP.lng, dest_lat: DEST.lat, dest_lng: DEST.lng, pickup_address: 'Embu CBD', dest_address: 'Kangaru' });
  if (r1.s !== 201) { console.error('ride create failed', r1.d); process.exit(1); }
  const rideId = r1.d.ride.id, pin = r1.d.pin;

  // No receipt yet → PDF must 404 even for the rider
  let offer = null;
  for (let i = 0; i < 40 && !offer; i++) { offer = (await j('GET', '/api/driver/hub', drv.tok)).d.offer; if (!offer) await sleep(1000); }
  if (!offer) { console.error('no offer arrived'); process.exit(1); }
  const noRec = await raw(`/api/rides/${rideId}/receipt.pdf`, rider.tok);
  ok('ride without finalized receipt -> 404', noRec.s === 404);

  await j('POST', '/api/offers/' + offer.id + '/accept', drv.tok);
  await j('POST', `/api/rides/${rideId}/arrived`, drv.tok);
  await j('POST', `/api/rides/${rideId}/verify-pin`, drv.tok, { pin });
  await j('POST', `/api/rides/${rideId}/start`, drv.tok);
  await j('POST', `/api/rides/${rideId}/complete`, drv.tok);
  const cash = await j('POST', `/api/rides/${rideId}/cash-collected`, drv.tok);
  ok('ride closed after cash collection', cash.s === 200 && cash.d.ride.status === 'closed', cash.d);
  const rec = await j('GET', `/api/rides/${rideId}/receipt`, rider.tok);
  ok('JSON receipt exists with HAPA reference', rec.s === 200 && /^HAPA-/.test(rec.d.reference), rec.d);

  // Authorization matrix
  const unauth = await raw(`/api/rides/${rideId}/receipt.pdf`, null);
  ok('unauthenticated PDF request -> 401', unauth.s === 401, unauth.s);
  const forb = await raw(`/api/rides/${rideId}/receipt.pdf`, outsider.tok);
  ok('unrelated user PDF request -> 403', forb.s === 403, forb.s);

  const rPdf = await raw(`/api/rides/${rideId}/receipt.pdf`, rider.tok);
  ok('rider downloads PDF (200)', rPdf.s === 200);
  ok('PDF signature valid (%PDF-)', rPdf.buf.slice(0, 5).toString() === '%PDF-', rPdf.buf.slice(0, 8).toString());
  ok('Content-Type is application/pdf', rPdf.h['content-type'] === 'application/pdf', rPdf.h['content-type']);
  ok('Content-Disposition attachment with sanitized HAPA filename',
    /^attachment; filename="HAPA-Receipt-[A-Za-z0-9-]+\.pdf"$/.test(rPdf.h['content-disposition'] || ''), rPdf.h['content-disposition']);
  ok('Cache-Control private, no-store', rPdf.h['cache-control'] === 'private, no-store', rPdf.h['cache-control']);
  ok('filename matches receipt reference', (rPdf.h['content-disposition'] || '').includes(rec.d.reference.replace(/[^A-Za-z0-9-]/g, '')));

  const dPdf = await raw(`/api/rides/${rideId}/receipt.pdf`, drv.tok);
  ok('assigned driver downloads PDF (200)', dPdf.s === 200 && dPdf.buf.slice(0, 5).toString() === '%PDF-', dPdf.s);

  // Customer PDF must not leak internal accounting
  const txt = rPdf.buf.toString('latin1');
  const fmt = n => 'KES ' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const commission = fmt(rec.d.body.commission), earnings = fmt(rec.d.body.driver_earnings);
  ok('PDF has no commission/earnings labels', !/commission|earnings|payment_mode|internal/i.test(txt));
  ok('PDF has no commission/earnings amounts', !txt.includes(commission) && !txt.includes(earnings), { commission, earnings });
  ok('PDF has no internal IDs', !txt.includes(rideId) && !txt.includes(rider.uid), undefined);
  ok('PDF shows the customer total', txt.includes('KES ' + Number(rec.d.body.total).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })));
  ok('PDF marked as receipt, not tax invoice', txt.includes('not a tax invoice') && !/VAT|KRA/i.test(txt));
  ok('PDF shows PAID status and route', txt.includes('PAID') && txt.includes('Embu CBD') && txt.includes('Kangaru'));

  // Random ride id cannot bypass authorization
  ok('nonexistent ride -> 404 (no info leak)', (await raw('/api/rides/00000000-0000-4000-8000-000000000000/receipt.pdf', outsider.tok)).s === 404);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
