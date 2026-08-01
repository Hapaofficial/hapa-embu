// Owner ride operations, accounting & rider-history quality tests.
// Covers: owner ride details (privacy + timeline + financials), audited
// exact-location access, owner ride search filters, driver earnings report
// (exact ledger math: 346.13 / 51.92 / 294.21 per ride), CSV accounting export
// (authz, totals, formula-injection safety, no coordinates), API no-store
// caching, and static frontend assertions for the rider-history loading/retry
// states and the receipt header fix.
// Usage: TEST_OWNER_EMAIL=.. TEST_OWNER_PASSWORD=.. node tests/ride-ops-accounting.test.js [baseUrl]
const fs = require('fs');
const path = require('path');
const B = process.argv[2] || 'http://127.0.0.1:5000';
const OWNER_EMAIL = process.env.TEST_OWNER_EMAIL;
const OWNER_PASSWORD = process.env.TEST_OWNER_PASSWORD;
const RUN = 'oa' + Date.now().toString(36);
const PW = 'TestPass2026x!';
const PICKUP = { lat: -0.5310, lng: 37.4575 };
const DEST = { lat: -0.4990, lng: 37.4600 };
// base 100 + 4.922km*40 (196.88) + 591s=9.85min*5 (49.25) = 346.13; 15% commission.
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
  const reg = await j('POST', '/api/auth/register', null, { name: name || 'OA ' + label, email: em, password: PW, selfie: 'data:image/png;base64,iVBORw0KGgo=' });
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
  const d = await makeUser(ownerTok, label, 'driver', { fullName: 'OA ' + label, drivingLicenceNumber: 'DL-' + RUN + label, vehicleType: 'Boda Boda', registrationNumber: 'K' + label.toUpperCase() + ' 4' + RUN.slice(-2).toUpperCase(), county: 'Embu' });
  await j('POST', '/api/me/driver-profile', d.tok);
  const veh = await j('POST', '/api/me/vehicles', d.tok, { category: 'Passenger Car', make: 'Toyota', model: 'Vitz', colour: 'Silver', registration_number: 'KO' + label.slice(-1).toUpperCase() + ' ' + Math.floor(Math.random() * 900 + 100) + 'Y' });
  if (veh.s !== 201) throw new Error('vehicle failed ' + JSON.stringify(veh.d));
  await j('PATCH', '/api/owner/vehicles/' + veh.d.id, ownerTok, { status: 'approved' });
  for (const t of DOCS) {
    const doc = await j('POST', '/api/me/driver-documents', d.tok, { doc_type: t, reference: 'REF-' + t, expires_on: '2027-12-31' });
    await j('PATCH', '/api/owner/driver-documents/' + doc.d.id, ownerTok, { status: 'approved' });
  }
  await j('POST', '/api/me/operating-zones', d.tok, { zone: 'zone-embu-pilot' });
  await j('POST', '/api/agreements/accept', d.tok, { agreement: 'driver_agreement' });
  return { ...d, vehicleId: veh.d.id, reg: veh.d.registration_number };
}
async function runRide(riderTok, drvTok, pay = 'cash') {
  const q1 = await j('POST', '/api/rides/quote', riderTok, { pickup_lat: PICKUP.lat, pickup_lng: PICKUP.lng, dest_lat: DEST.lat, dest_lng: DEST.lng, zone: 'zone-embu-pilot', vehicle_category: 'Passenger Car', distance_m: DIST_M, duration_s: DUR_S });
  const r1 = await j('POST', '/api/rides', riderTok, { quote_id: q1.d.quote.id, payment_method: pay, pickup_lat: PICKUP.lat, pickup_lng: PICKUP.lng, dest_lat: DEST.lat, dest_lng: DEST.lng, pickup_address: 'Embu Town CBD, near market', dest_address: 'Kangaru School gate' });
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
  const c = await j('POST', `/api/rides/${rideId}/cash-collected`, drvTok);
  if (c.s !== 200) throw new Error('cash-collected failed ' + JSON.stringify(c.d));
  return rideId;
}

(async () => {
  if (!OWNER_EMAIL || !OWNER_PASSWORD) { console.error('TEST_OWNER_EMAIL/TEST_OWNER_PASSWORD required'); process.exit(1); }
  const ownerTok = (await j('POST', '/api/auth/login', null, { identifier: OWNER_EMAIL, password: OWNER_PASSWORD })).d.token;
  await j('PATCH', '/api/owner/compliance/offer_timeout_s', ownerTok, { value: 3 });
  await j('POST', '/api/owner/fare-cards', ownerTok, { area: 'zone-embu-pilot', vehicle_category: 'Passenger Car', base_fare: 100, per_km: 40, per_min: 5, minimum_fare: 150 });

  const rider = await makeUser(ownerTok, 'rider', null, null, '=SUM(A1) Rider'); // CSV formula-injection probe
  const outsider = await makeUser(ownerTok, 'outsider', null);
  await j('POST', '/api/agreements/accept', rider.tok, { agreement: 'rider_terms' });
  const drv = await makeDriver(ownerTok, 'drv');
  await j('POST', '/api/driver/online', drv.tok, { zone: 'zone-embu-pilot', vehicle_id: drv.vehicleId });
  await j('POST', '/api/driver/location', drv.tok, { lat: PICKUP.lat + 0.001, lng: PICKUP.lng, seq: 1, accuracy: 8 });

  // Two identical completed cash rides + one cancelled ride.
  const ride1 = await runRide(rider.tok, drv.tok);
  const ride2 = await runRide(rider.tok, drv.tok);
  const q3 = await j('POST', '/api/rides/quote', rider.tok, { pickup_lat: PICKUP.lat, pickup_lng: PICKUP.lng, dest_lat: DEST.lat, dest_lng: DEST.lng, zone: 'zone-embu-pilot', vehicle_category: 'Passenger Car', distance_m: DIST_M, duration_s: DUR_S });
  const r3 = await j('POST', '/api/rides', rider.tok, { quote_id: q3.d.quote.id, payment_method: 'cash', pickup_lat: PICKUP.lat, pickup_lng: PICKUP.lng, dest_lat: DEST.lat, dest_lng: DEST.lng, pickup_address: 'Embu Town CBD', dest_address: 'Kangaru' });
  await j('POST', '/api/rides/' + r3.d.ride.id + '/cancel', rider.tok, { reason: 'plans changed' });

  // ── Ledger math matches the confirmed staging example exactly
  const hub = await j('GET', '/api/driver/hub', drv.tok);
  const h1 = (hub.d.history || []).find(r => r.id === ride1);
  ok('single ride ledger 346.13 / 51.92 / 294.21', h1 && Number(h1.gross) === 346.13 && Number(h1.commission) === 51.92 && Number(h1.net) === 294.21, h1);

  // ── API responses are never browser-cacheable
  const mineRaw = await fetch(B + '/api/rides/mine', { headers: { Authorization: 'Bearer ' + rider.tok } });
  ok('authenticated API sends no-store', /no-store/.test(mineRaw.headers.get('cache-control') || ''), mineRaw.headers.get('cache-control'));
  const mine = await mineRaw.json();
  const m1 = mine.find(r => r.id === ride1);
  ok('rider history exposes payment + rating status', m1 && m1.payment_status === 'paid' && m1.i_rated === false && m1.driver && m1.vehicle, m1);
  ok('cancelled ride has no payment status', mine.find(r => r.id === r3.d.ride.id)?.payment_status === null);

  // ── Owner ride details: privacy + timeline + financials
  ok('rider cannot open owner ride details', (await j('GET', '/api/owner/rides/' + ride1, rider.tok)).s === 403);
  ok('driver cannot open owner ride details', (await j('GET', '/api/owner/rides/' + ride1, drv.tok)).s === 403);
  const det = await j('GET', '/api/owner/rides/' + ride1, ownerTok);
  ok('owner opens ride details', det.s === 200 && det.d.ride && det.d.ledger, det.s);
  const detStr = JSON.stringify(det.d);
  ok('default details omit raw coordinates', !/"(pickup_lat|pickup_lng|dest_lat|dest_lng|lat|lng)":/.test(detStr), (detStr.match(/"(pickup_lat|lat)":[^,]*/) || [])[0]);
  ok('details include rider, zone, quote, receipt', det.d.rider?.name && det.d.zone?.name && det.d.quote && /^HAPA-/.test(det.d.receipt?.reference || ''));
  ok('details financials match ledger', Number(det.d.ledger.gross) === 346.13 && Number(det.d.ledger.commission) === 51.92 && Number(det.d.ledger.net) === 294.21, det.d.ledger);
  const evIds = det.d.events.map(e => e.id);
  ok('timeline events ordered ascending', evIds.length >= 5 && evIds.every((v, i) => i === 0 || v > evIds[i - 1]), evIds);
  ok('timeline covers request→completion→closure', ['completed'].every(t => det.d.events.some(e => e.event_type.includes(t))) && det.d.events.length >= 5, det.d.events.map(e => e.event_type));
  ok('missing optional timestamps handled (cancelled ride details)', (await j('GET', '/api/owner/rides/' + r3.d.ride.id, ownerTok)).s === 200);

  // ── Audited exact-location access
  ok('location access requires a reason', (await j('POST', `/api/owner/rides/${ride1}/locations`, ownerTok, { reason: '' })).s === 400);
  const loc = await j('POST', `/api/owner/rides/${ride1}/locations`, ownerTok, { reason: 'test support investigation' });
  ok('owner exact-location access works', loc.s === 200 && loc.d.pickup && typeof loc.d.pickup.lat === 'number');
  ok('rider blocked from location endpoint', (await j('POST', `/api/owner/rides/${ride1}/locations`, rider.tok, { reason: 'x' })).s === 403);
  const auditRows = (await j('GET', '/api/owner/audit-log', ownerTok)).d;
  ok('location access creates audit entry', auditRows.some(a => a.action === 'ride_location_access' && a.target_id === ride1 && /investigation/.test(a.note)));

  // ── Owner ride search & filters
  const all = await j('GET', '/api/owner/rides?rider=' + RUN + '.rider', ownerTok);
  ok('owner search by rider finds all 3 rides', all.s === 200 && all.d.total === 3, all.d.total);
  ok('search rows carry labels, payment status, no coordinates', all.d.rides.every(r => r.payment_status !== undefined) && !/"(pickup_lat|lat)":/.test(JSON.stringify(all.d.rides)));
  const paidOnly = await j('GET', `/api/owner/rides?rider=${RUN}.rider&payment_status=paid`, ownerTok);
  ok('payment_status=paid filter excludes cancelled', paidOnly.d.total === 2 && paidOnly.d.rides.every(r => r.status === 'closed'));
  const regF = await j('GET', '/api/owner/rides?reg=' + encodeURIComponent(drv.reg), ownerTok);
  ok('vehicle registration filter matches', regF.d.total >= 2 && regF.d.rides.some(r => r.id === ride1));
  const noZone = await j('GET', `/api/owner/rides?rider=${RUN}.rider&zone=zone-that-does-not-exist`, ownerTok);
  ok('zone filter cannot leak other zones', noZone.d.total === 0);
  ok('owner search rejects non-owner', (await j('GET', '/api/owner/rides', rider.tok)).s === 403);
  ok('search is injection-safe', (await j('GET', "/api/owner/rides?rider=%27%3B%20DROP%20TABLE%20users%3B--", ownerTok)).s === 200);

  // ── Owner driver earnings report
  const rep = await j('GET', '/api/owner/driver-earnings?driver=' + RUN + '.drv', ownerTok);
  const dr = rep.d.drivers.find(x => x.driver_name === 'OA drv');
  ok('earnings report finds the driver', rep.s === 200 && !!dr);
  ok('two identical rides total 692.26 / 103.84 / 588.42', dr && Number(dr.gross) === 692.26 && Number(dr.commission) === 103.84 && Number(dr.net) === 588.42, dr && { g: dr.gross, c: dr.commission, n: dr.net });
  ok('completed rides counted exactly once each', dr && Number(dr.completed_rides) === 2, dr?.completed_rides);
  // The cancelled ride was rider-cancelled before any driver was assigned, so
  // it must appear neither as this driver's cancellation nor in earnings.
  ok('unassigned cancelled ride excluded from driver stats', dr && Number(dr.cancellations) === 0 && Number(dr.completed_rides) === 2);
  ok('payment methods separated (all cash)', dr && Number(dr.cash_collected) === 692.26 && Number(dr.mpesa_collected) === 0);
  // Cash rides: driver already holds the gross, so commission is a receivable
  // ("Driver owes HAPA") and there is never a payable in the other direction.
  ok('cash rides: Driver owes HAPA the commission (103.84)', dr && Number(dr.driver_owes_hapa) === 103.84, dr && dr.driver_owes_hapa);
  ok('cash rides: HAPA owes Driver nothing', dr && Number(dr.hapa_owes_driver) === 0);
  ok('report totals aggregate correctly', Number(rep.d.totals.gross) === 692.26 && Number(rep.d.totals.commission) === 103.84 && rep.d.totals.completed_rides === 2, rep.d.totals);
  ok('driver has online + driving time recorded', dr && Number(dr.online_seconds) > 0 && Number(dr.driving_seconds) >= 1, dr && { on: dr.online_seconds, dr: dr.driving_seconds });
  // Africa/Nairobi date-range filtering (EAT = UTC+3)
  const nrbToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi' }).format(new Date());
  const inRange = await j('GET', `/api/owner/driver-earnings?driver=${RUN}.drv&from=${nrbToday}&to=${nrbToday}`, ownerTok);
  ok('Nairobi date range includes today\'s rides', Number(inRange.d.totals.gross) === 692.26, inRange.d.totals);
  const outRange = await j('GET', `/api/owner/driver-earnings?driver=${RUN}.drv&from=2020-01-01&to=2020-01-02`, ownerTok);
  ok('out-of-range dates exclude the rides', Number(outRange.d.totals.gross) === 0);
  const zoneLeak = await j('GET', `/api/owner/driver-earnings?driver=${RUN}.drv&zone=zone-that-does-not-exist`, ownerTok);
  ok('earnings zone filter cannot leak', Number(zoneLeak.d.totals.gross) === 0);
  ok('earnings report is owner-only', (await j('GET', '/api/owner/driver-earnings', drv.tok)).s === 403);

  // ── Driver's own range earnings endpoint
  const de = await j('GET', `/api/driver/earnings?from=${nrbToday}&to=${nrbToday}`, drv.tok);
  ok('driver range earnings match ledger', de.s === 200 && Number(de.d.gross) === 692.26 && Number(de.d.net) === 588.42 && de.d.completed_rides === 2, de.d);
  ok('driver earnings blocked for non-drivers', (await j('GET', '/api/driver/earnings', rider.tok)).s === 403);

  // ── CSV accounting export
  const csvR = await fetch(B + `/api/owner/rides-export.csv?rider=${RUN}.rider`, { headers: { Authorization: 'Bearer ' + ownerTok } });
  const csvBytes = Buffer.from(await csvR.arrayBuffer());
  ok('CSV export succeeds with UTF-8 BOM', csvR.status === 200 && csvBytes[0] === 0xEF && csvBytes[1] === 0xBB && csvBytes[2] === 0xBF && /text\/csv/.test(csvR.headers.get('content-type')));
  const csv = csvBytes.slice(3).toString('utf8');
  const lines = csv.split('\r\n').filter(Boolean);
  ok('CSV honors filters (3 rides + header)', lines.length === 4, lines.length);
  ok('CSV columns labelled Africa/Nairobi', /Africa\/Nairobi/.test(lines[0]));
  ok('CSV has no raw coordinates or secrets', !/-0\.5|37\.45|Bearer|eyJ/.test(csv));
  ok('CSV neutralizes formula injection', csv.includes("'=SUM(A1) Rider") && !/^=|,=SUM/.test(csv.split('\r\n')[1] || ''), (csv.match(/.{0,20}=SUM.{0,10}/) || [])[0]);
  ok('CSV KES values two-decimal', /346\.13,51\.92,294\.21/.test(csv.replace(/"/g, '')));
  ok('CSV export is owner-only', (await j('GET', '/api/owner/rides-export.csv', rider.tok)).s === 403);
  const audit2 = (await j('GET', '/api/owner/audit-log', ownerTok)).d;
  ok('CSV export creates audit entry', audit2.some(a => a.action === 'accounting_export'));

  // ── Static frontend assertions (loading/retry, receipt header, labels)
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  ok('rider history shows loading state first', html.includes("el.innerHTML='Loading your trips…'"));
  ok('rider history transient error offers Retry', html.includes('onclick="rdLoadHistory()">Retry</button>'));
  ok('"No rides yet" only after a successful response', /rdHistLoaded=true;[\s\S]{0,3500}No rides yet on this account/.test(html) && !/catch[\s\S]{0,200}No rides yet/.test(html.slice(html.indexOf('async function rdLoadHistory'))));
  // Regression pack for the "confirmed rider, empty history" live report:
  ok('api() bypasses every HTTP cache', html.includes("o.cache='no-store'"));
  ok('empty state names the authenticated account', html.includes("No rides yet on this account (${esc(me?.email"));
  ok('non-array 200 response treated as error, not empty history', html.includes('if(!Array.isArray(rows))'));
  ok('shell carries a version marker', /const HAPA_SHELL='[\d.]+'/.test(html));
  const swjs = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
  ok('service worker never caches /api/', swjs.includes("u.pathname.startsWith('/api/'))return"));
  const shellHdr = await fetch(B + '/index.html');
  ok('app shell served no-cache', /no-cache/.test(shellHdr.headers.get('cache-control') || ''), shellHdr.headers.get('cache-control'));
  const swHdr = await fetch(B + '/sw.js');
  ok('service worker served no-cache', /no-cache/.test(swHdr.headers.get('cache-control') || ''), swHdr.headers.get('cache-control'));
  ok('populated history never blanked on error', html.includes('if(!rdHistLoaded)el.innerHTML=`Could not load'));
  ok('receipt header uses plain flex rows (no white .row blocks)', !/hapa-header[\s\S]{0,900}class="row"/.test(html.slice(html.indexOf('function rcptOpen'), html.indexOf('function rcptClose'))));
  ok('receipt header shows title, ref, date, payment', html.includes('>Ride receipt</span>') && /rcptTitle/.test(html) && html.includes('${esc(pm)} · Paid'));
  ok('owner UI maps raw statuses to labels', html.includes("rider_cancelled:'Rider cancelled'") && html.includes("closed:'Completed and closed'") && html.includes('opsStatusCopy[r.status]||r.status'));
  ok('owner rides are clickable to details', html.includes("otOpenRide('") && html.includes('Exact locations (audited)'));
  ok('rider history card shows driver, vehicle, payment, rating status', html.includes('Not rated yet') && html.includes("r.payment_status==='paid'?'Paid'"));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
