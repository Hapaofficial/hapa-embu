// Driver finance: cash/M-Pesa accounting direction, commission reserve, tips,
// references, settlements (FIFO, no over-settlement), monthly statements
// (lifecycle + immutability), stale sessions, owner drill-down + summary and
// audited CSV exports. Requires COMMISSION_RESERVE_ENABLED=true and
// COMMISSION_RESERVE_LEGAL_APPROVED=true on the server for reserve scenarios.
// Usage: TEST_OWNER_EMAIL=.. TEST_OWNER_PASSWORD=.. node tests/driver-finance.test.js [baseUrl]
const B = process.argv[2] || 'http://127.0.0.1:5000';
const OWNER_EMAIL = process.env.TEST_OWNER_EMAIL;
const OWNER_PASSWORD = process.env.TEST_OWNER_PASSWORD;
const RUN = 'fi' + Date.now().toString(36);
const PW = 'TestPass2026x!';
const PICKUP = { lat: -0.5310, lng: 37.4575 };
const DEST = { lat: -0.4990, lng: 37.4600 };
// base 100 + 4.922km*40 + 591s*5/60 = 346.13 gross; 15% => 51.92 commission, 294.21 net.
const DIST_M = 4922, DUR_S = 591;

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('PASS', n); } else { fail++; console.log('FAIL', n, x !== undefined ? JSON.stringify(x).slice(0, 300) : ''); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const j = async (m, p, t, b) => {
  const r = await fetch(B + p, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: b ? JSON.stringify(b) : undefined });
  return { s: r.status, d: await r.json().catch(() => ({})), h: r.headers };
};

async function makeUser(ownerTok, label, capType, details, name) {
  const em = `${RUN}.${label}@example.com`;
  const reg = await j('POST', '/api/auth/register', null, { name: name || 'FI ' + label, email: em, password: PW, selfie: 'data:image/png;base64,iVBORw0KGgo=' });
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
  const d = await makeUser(ownerTok, label, 'driver', { fullName: 'FI ' + label, drivingLicenceNumber: 'DL-' + RUN + label, vehicleType: 'Boda Boda', registrationNumber: 'K' + label.toUpperCase() + ' 5' + RUN.slice(-2).toUpperCase(), county: 'Embu' });
  await j('POST', '/api/me/driver-profile', d.tok);
  const veh = await j('POST', '/api/me/vehicles', d.tok, { category: 'Passenger Car', make: 'Toyota', model: 'Vitz', colour: 'Blue', registration_number: 'KF' + label.slice(-1).toUpperCase() + ' ' + Math.floor(Math.random() * 900 + 100) + 'Z' });
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
async function runRide(riderTok, drvTok, pay = 'cash') {
  const q1 = await j('POST', '/api/rides/quote', riderTok, { pickup_lat: PICKUP.lat, pickup_lng: PICKUP.lng, dest_lat: DEST.lat, dest_lng: DEST.lng, zone: 'zone-embu-pilot', vehicle_category: 'Passenger Car', distance_m: DIST_M, duration_s: DUR_S });
  const r1 = await j('POST', '/api/rides', riderTok, { quote_id: q1.d.quote.id, payment_method: pay, pickup_lat: PICKUP.lat, pickup_lng: PICKUP.lng, dest_lat: DEST.lat, dest_lng: DEST.lng, pickup_address: 'Embu Town CBD', dest_address: 'Kangaru School gate' });
  if (r1.s !== 201) throw new Error('ride create failed ' + JSON.stringify(r1.d));
  const rideId = r1.d.ride.id, pin = r1.d.pin;
  let offer = null;
  for (let i = 0; i < 40 && !offer; i++) { offer = (await j('GET', '/api/driver/hub', drvTok)).d.offer; if (!offer) await sleep(1000); }
  if (!offer) throw new Error('no offer arrived');
  await j('POST', '/api/offers/' + offer.id + '/accept', drvTok);
  await j('POST', `/api/rides/${rideId}/arrived`, drvTok);
  await j('POST', `/api/rides/${rideId}/verify-pin`, drvTok, { pin });
  await j('POST', `/api/rides/${rideId}/start`, drvTok);
  await sleep(1200);
  await j('POST', `/api/rides/${rideId}/complete`, drvTok);
  if (pay === 'cash') {
    const c = await j('POST', `/api/rides/${rideId}/cash-collected`, drvTok);
    if (c.s !== 200) throw new Error('cash-collected failed ' + JSON.stringify(c.d));
  } else {
    const p = await j('POST', `/api/rides/${rideId}/pay-mpesa`, riderTok, { phone: '254712345678' });
    if (p.s >= 400) throw new Error('pay-mpesa failed ' + JSON.stringify(p.d));
    for (let i = 0; i < 20; i++) { const r = await j('GET', '/api/rides/' + rideId, riderTok); if (r.d.ride?.status === 'closed' || r.d.status === 'closed') break; await sleep(700); }
  }
  return rideId;
}

(async () => {
  if (!OWNER_EMAIL || !OWNER_PASSWORD) { console.error('TEST_OWNER_EMAIL/TEST_OWNER_PASSWORD required'); process.exit(1); }
  const ownerTok = (await j('POST', '/api/auth/login', null, { identifier: OWNER_EMAIL, password: OWNER_PASSWORD })).d.token;
  await j('PATCH', '/api/owner/compliance/offer_timeout_s', ownerTok, { value: 3 });
  await j('POST', '/api/owner/fare-cards', ownerTok, { area: 'zone-embu-pilot', vehicle_category: 'Passenger Car', base_fare: 100, per_km: 40, per_min: 5, minimum_fare: 150 });

  const rider = await makeUser(ownerTok, 'rider');
  await j('POST', '/api/agreements/accept', rider.tok, { agreement: 'rider_terms' });
  const drv = await makeDriver(ownerTok, 'drv');
  await j('POST', '/api/driver/online', drv.tok, { zone: 'zone-embu-pilot', vehicle_id: drv.vehicleId });
  await j('POST', '/api/driver/location', drv.tok, { lat: PICKUP.lat + 0.001, lng: PICKUP.lng, seq: 1, accuracy: 8 });

  // ── CASH accounting: driver keeps gross, owes HAPA the commission ─────────
  const ride1 = await runRide(rider.tok, drv.tok, 'cash');
  const ride2 = await runRide(rider.tok, drv.tok, 'cash');
  let fin = (await j('GET', '/api/driver/finance', drv.tok)).d;
  ok('two cash rides: Driver owes HAPA 103.84 exactly', Number(fin.balances.driver_owes_hapa) === 103.84, fin.balances);
  ok('cash rides: HAPA owes Driver 0.00', Number(fin.balances.hapa_owes_driver) === 0);
  ok('per-ride receivable is 51.92', fin.receivables.length === 2 && fin.receivables.every(r => Number(r.amount) === 51.92 && Number(r.outstanding) === 51.92), fin.receivables);
  ok('receivable refs are HAPA-COM-*', fin.receivables.every(r => /^HAPA-COM-/.test(r.reference)));
  ok('finance endpoint blocked for riders', (await j('GET', '/api/driver/finance', rider.tok)).s === 403);

  // ── M-Pesa accounting: HAPA holds gross, owes driver the net ──────────────
  const ride3 = await runRide(rider.tok, drv.tok, 'mpesa');
  fin = (await j('GET', '/api/driver/finance', drv.tok)).d;
  ok('mpesa ride: HAPA owes Driver 294.21', Number(fin.balances.hapa_owes_driver) === 294.21, fin.balances);
  ok('mpesa ride adds no receivable', fin.receivables.length === 2);
  ok('payable carries a HAPA-DUE reference', fin.payables.some(p => /^HAPA-DUE-/.test(p.reference)), fin.payables);

  // ── References: rides/payments carry unique HAPA-* refs ───────────────────
  const det1 = (await j('GET', '/api/owner/rides/' + ride1, ownerTok)).d;
  const det2 = (await j('GET', '/api/owner/rides/' + ride2, ownerTok)).d;
  ok('rides carry HAPA-RIDE references', /^HAPA-RIDE-/.test(det1.ride.ride_reference || '') && /^HAPA-RIDE-/.test(det2.ride.ride_reference || ''), det1.ride.ride_reference);
  ok('ride references are unique', det1.ride.ride_reference !== det2.ride.ride_reference);

  // ── Tips: rider-only, once per ride, 0% commission ────────────────────────
  ok('driver cannot tip', (await j('POST', `/api/rides/${ride1}/tip`, drv.tok, { amount: 50, method: 'mpesa' })).s === 403);
  ok('tip over max rejected', (await j('POST', `/api/rides/${ride1}/tip`, rider.tok, { amount: 999999, method: 'mpesa' })).s === 400);
  ok('zero tip rejected', (await j('POST', `/api/rides/${ride1}/tip`, rider.tok, { amount: 0, method: 'mpesa' })).s === 400);
  const tip1 = await j('POST', `/api/rides/${ride1}/tip`, rider.tok, { amount: 50, method: 'mpesa' });
  ok('mpesa tip accepted + confirmed in mock mode', tip1.s === 201 && tip1.d.tip.status === 'confirmed' && /^HAPA-TIP-/.test(tip1.d.tip.reference), tip1.d);
  ok('second tip on same ride rejected', (await j('POST', `/api/rides/${ride1}/tip`, rider.tok, { amount: 20, method: 'cash' })).s === 409);
  const tip2 = await j('POST', `/api/rides/${ride2}/tip`, rider.tok, { amount: 100, method: 'cash' });
  ok('cash tip recorded as declared, unverified', tip2.s === 201 && tip2.d.tip.status === 'declared' && tip2.d.tip.verified_by_hapa === false && /declared by Rider/i.test(tip2.d.note), tip2.d);
  fin = (await j('GET', '/api/driver/finance', drv.tok)).d;
  ok('tips tracked separately (50 mpesa / 100 cash declared)', Number(fin.tips.mpesa) === 50 && Number(fin.tips.cash_declared) === 100, fin.tips);
  ok('mpesa tip owed to driver on top of net (294.21+50)', Number(fin.balances.hapa_owes_driver) === 344.21, fin.balances.hapa_owes_driver);

  // ── Commission reserve: top-up covers future cash commission ──────────────
  const topup = await j('POST', '/api/driver/reserve/topup', drv.tok, { amount: 20 });
  ok('reserve top-up works (gates enabled)', topup.s === 201 && Number(topup.d.entry.balance_after) === 20, topup.d);
  const ride4 = await runRide(rider.tok, drv.tok, 'cash');
  fin = (await j('GET', '/api/driver/finance', drv.tok)).d;
  ok('partial reserve cover: 20 debited, 31.92 remains receivable', Number(fin.balances.reserve_balance) === 0 && Number(fin.balances.driver_owes_hapa) === 135.76, fin.balances);
  ok('reserve debit entry recorded', fin.reserve_entries.some(e => e.entry_type === 'commission_debit' && Number(e.amount) === 20), fin.reserve_entries);
  const partial = fin.receivables.find(r => Number(r.amount) === 31.92);
  ok('remainder receivable is exactly 31.92', !!partial && Number(partial.outstanding) === 31.92, fin.receivables);

  // ── Settlements: FIFO allocation + no over-settlement ─────────────────────
  const over = await j('POST', `/api/owner/drivers/${drv.uid}/settlements`, ownerTok, { direction: 'driver_to_hapa', amount: 100000, method: 'cash_office' });
  ok('over-settlement rejected', over.s === 400, over.d);
  const set1 = await j('POST', `/api/owner/drivers/${drv.uid}/settlements`, ownerTok, { direction: 'driver_to_hapa', amount: 60, method: 'cash_office', notes: 'partial' });
  ok('partial settlement recorded (HAPA-SET ref)', set1.s === 201 && /^HAPA-SET-/.test(set1.d.settlement.reference), set1.d);
  fin = (await j('GET', '/api/driver/finance', drv.tok)).d;
  ok('FIFO: oldest receivable cleared first, 75.76 remains', Number(fin.balances.driver_owes_hapa) === 75.76, fin.balances);
  const cleared = fin.receivables.filter(r => r.status === 'settled').length;
  ok('exactly one receivable fully settled + one partial', cleared === 1 && fin.receivables.some(r => r.status === 'partially_settled'), fin.receivables);
  const set2 = await j('POST', `/api/owner/drivers/${drv.uid}/settlements`, ownerTok, { direction: 'driver_to_hapa', amount: 75.76, method: 'mpesa', external_ref: 'QTEST123' });
  ok('remaining balance settled to zero', set2.s === 201 && Number((await j('GET', '/api/driver/finance', drv.tok)).d.balances.driver_owes_hapa) === 0);
  const setOut = await j('POST', `/api/owner/drivers/${drv.uid}/settlements`, ownerTok, { direction: 'hapa_to_driver', amount: 344.21, method: 'mpesa', external_ref: 'QOUT1' });
  ok('payout settlement clears HAPA owes Driver', setOut.s === 201 && Number((await j('GET', '/api/driver/finance', drv.tok)).d.balances.hapa_owes_driver) === 0);
  ok('settlements are owner-only', (await j('POST', `/api/owner/drivers/${drv.uid}/settlements`, drv.tok, { direction: 'driver_to_hapa', amount: 1, method: 'cash_office' })).s === 403);

  // ── Owner drill-down + platform summary ───────────────────────────────────
  const dd = await j('GET', `/api/owner/drivers/${drv.uid}/finance`, ownerTok);
  ok('drill-down lists per-ride rows with routes', dd.s === 200 && dd.d.rides.length === 4 && dd.d.rides.every(r => r.pickup_address && r.dest_address), dd.d.rides?.length);
  ok('drill-down reports Africa/Nairobi', dd.d.timezone === 'Africa/Nairobi');
  const sum = await j('GET', '/api/owner/finance/summary', ownerTok);
  ok('platform summary has direction-separated balances', sum.s === 200 && sum.d.balances.drivers_owe_hapa !== undefined && sum.d.balances.hapa_owes_drivers !== undefined && sum.d.timezone === 'Africa/Nairobi', sum.d);
  const csvR = await fetch(B + `/api/owner/drivers/${drv.uid}/finance.csv`, { headers: { Authorization: 'Bearer ' + ownerTok } });
  const csvBytes = Buffer.from(await csvR.arrayBuffer());
  ok('drill-down CSV: BOM + CRLF + labels', csvR.status === 200 && csvBytes[0] === 0xEF && /\r\n/.test(csvBytes.toString()) && /Cash|Driver fare earnings/.test(csvBytes.toString()), csvR.status);
  const sumCsv = await fetch(B + '/api/owner/finance/summary.csv', { headers: { Authorization: 'Bearer ' + ownerTok } });
  ok('summary CSV export works + owner-only', sumCsv.status === 200 && (await j('GET', '/api/owner/finance/summary.csv', drv.tok)).s === 403);

  // ── Monthly statements: generate → download → finalize rules ─────────────
  const now = new Date(Date.now() + 3 * 3600 * 1000); // Nairobi
  const y = now.getUTCFullYear(), m = now.getUTCMonth() + 1;
  const gen = await j('POST', '/api/owner/statements/generate', ownerTok, { year: y, month: m, driver_id: drv.uid });
  ok('statement generated with HAPA-STMT-DRV ref', gen.s === 200 && /^HAPA-STMT-DRV-\d{4}-\d{2}-\d{6}$/.test(gen.d.generated[0].reference), gen.d);
  const gen2 = await j('POST', '/api/owner/statements/generate', ownerTok, { year: y, month: m, driver_id: drv.uid });
  ok('regeneration reuses the same statement (one per driver/month)', gen2.d.generated[0].reference === gen.d.generated[0].reference);
  const list = await j('GET', `/api/owner/statements?year=${y}&month=${m}`, ownerTok);
  const st = list.d.statements.find(s => s.reference === gen.d.generated[0].reference);
  ok('statement listed with summary', !!st && st.summary && Number(st.summary.gross) === 4 * 346.13, st?.summary);
  const stJson = await j('GET', '/api/statements/' + st.id, drv.tok);
  ok('driver can open own statement + disclaimer', stJson.s === 200 && /not a tax invoice/i.test(stJson.d.disclaimer), stJson.d.disclaimer);
  ok('other users cannot open the statement', (await j('GET', '/api/statements/' + st.id, rider.tok)).s === 403);
  const pdfR = await fetch(B + `/api/statements/${st.id}.pdf`, { headers: { Authorization: 'Bearer ' + drv.tok } });
  const pdfBytes = Buffer.from(await pdfR.arrayBuffer());
  ok('statement PDF downloads (%PDF magic)', pdfR.status === 200 && pdfBytes.slice(0, 4).toString() === '%PDF', pdfBytes.slice(0, 8).toString());
  const stCsv = await fetch(B + `/api/statements/${st.id}.csv`, { headers: { Authorization: 'Bearer ' + drv.tok } });
  ok('statement CSV includes disclaimer', stCsv.status === 200 && /not a tax invoice/i.test(await stCsv.text()));
  ok('current month cannot be finalized', (await j('POST', `/api/owner/statements/${st.id}/finalize`, ownerTok)).s === 409);

  // ── Sessions: heartbeat + logout + owner force-offline ────────────────────
  ok('heartbeat works', (await j('POST', '/api/driver/heartbeat', drv.tok)).s === 200);
  const fo = await j('POST', `/api/owner/drivers/${drv.uid}/force-offline`, ownerTok, { reason: 'test cleanup of session' });
  ok('owner force-offline closes session with reason', fo.s === 200 && fo.d.sessions_closed >= 1, fo.d);
  ok('force-offline requires a reason', (await j('POST', `/api/owner/drivers/${drv.uid}/force-offline`, ownerTok, { reason: '' })).s === 400);
  await j('POST', '/api/driver/online', drv.tok, { zone: 'zone-embu-pilot', vehicle_id: drv.vehicleId });
  const lo = await j('POST', '/api/auth/logout', drv.tok);
  ok('logout closes driver session', lo.s === 200 && lo.d.sessions_closed >= 1, lo.d);

  // ── Owner report carries the new direction-separated columns ──────────────
  const rep = await j('GET', '/api/owner/driver-earnings?driver=' + RUN + '.drv', ownerTok);
  const dr = rep.d.drivers.find(x => x.driver_name === 'FI drv');
  ok('owner report: owes columns present + zeroed after settlement', dr && Number(dr.driver_owes_hapa) === 0 && Number(dr.hapa_owes_driver) === 0, dr && { o: dr.driver_owes_hapa, h: dr.hapa_owes_driver });
  ok('owner report: tips separated', dr && Number(dr.tips_mpesa) === 50 && Number(dr.tips_cash_declared) === 100, dr && { m: dr.tips_mpesa, c: dr.tips_cash_declared });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
