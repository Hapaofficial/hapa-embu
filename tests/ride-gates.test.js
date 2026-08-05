// Launch-gate + fare-rate-card handling tests:
// category normalization, Nairobi calendar dates, ancestor fallback,
// duplicate protection, mandatory vs optional gates, no secret exposure.
// Usage: node tests/ride-gates.test.js [baseUrl]
const B = process.argv[2] || 'http://127.0.0.1:5000';
const OWNER_EMAIL = process.env.TEST_OWNER_EMAIL;
const OWNER_PASSWORD = process.env.TEST_OWNER_PASSWORD;
const RUN = 'rg' + Date.now().toString(36);
const PW = 'TestPass2026x!';
const PICKUP = { lat: -0.5310, lng: 37.4575 };
const DEST = { lat: -0.4990, lng: 37.4600 };

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
  return { s: r.status, d: await r.json().catch(() => ({})) };
};

// Nairobi calendar date helpers (UTC+3, no DST)
const nairobiToday = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
const nairobiPlus = days => new Date(Date.now() + 3 * 3600e3 + days * 86400e3).toISOString().slice(0, 10);

async function main() {
  const ownerTok = (await j('POST', '/api/auth/login', null, { identifier: OWNER_EMAIL, password: OWNER_PASSWORD })).d.token;
  if (!ownerTok) throw new Error('owner login failed');
  const rateGate = async () => (await j('GET', '/api/owner/ride-gates', ownerTok)).d.gates.find(g => g.gate === 'RATE_CARD');

  // Snapshot currently-active cards so we can isolate + restore (never delete history)
  const before = (await j('GET', '/api/owner/fare-cards', ownerTok)).d;
  const restoreActive = before.filter(c => c.active).map(c => c.id);
  const created = [];
  const off = id => j('PATCH', '/api/owner/fare-cards/' + id, ownerTok, { active: false });
  const mkCard = async (area, cat, base, eff) => {
    const r = await j('POST', '/api/owner/fare-cards', ownerTok, { area, vehicle_category: cat, base_fare: base, per_km: 40, per_min: 5, minimum_fare: 150, ...(eff ? { effective_from: eff } : {}) });
    if (r.s === 201) created.push(r.d.id);
    return r;
  };
  for (const id of restoreActive) await off(id);

  try {
    // 1. No usable card → BLOCKED with readable reason
    let g = await rateGate();
    ok('no active card → RATE_CARD blocked', g && g.pass === false && g.status === 'BLOCKED' && /rate card/i.test(g.detail), g);

    // 2. Owner-entered "car" resolves against "Passenger Car" pilot category
    const carCard = await mkCard('zone-embu-pilot', 'car', 100);
    ok('create "car" card for pilot zone', carCard.s === 201, carCard.d);
    g = await rateGate();
    ok('active Embu pilot "car" card → RATE_CARD READY', g && g.pass === true && g.status === 'READY', g);

    // 3. Inactive card → blocked again
    await off(carCard.d.id);
    g = await rateGate();
    ok('deactivated card → blocked again', g && g.pass === false, g);

    // 4. Future-effective card stays blocked until its Nairobi date
    const future = await mkCard('zone-embu-pilot', 'car', 100, nairobiPlus(2));
    ok('future card created', future.s === 201, future.d);
    g = await rateGate();
    ok('future-effective card → still blocked', g && g.pass === false, g);
    await off(future.d.id);

    // 5–7. Ancestor fallback + zone preference, verified through the real booking flow
    const county = await mkCard('county-embu', 'Passenger Car', 999);
    ok('county fallback card created', county.s === 201, county.d);
    g = await rateGate();
    ok('county fallback card → gate READY', g && g.pass === true, g);

    const reg = await j('POST', '/api/auth/register', null, { name: 'RG Rider', email: `${RUN}.rider@example.com`, password: PW, selfie: 'data:image/png;base64,iVBORw0KGgo=' });
    const acc = (await j('GET', '/api/owner/access', ownerTok)).d.find(a => a.user_id === reg.d.user.id && a.status === 'pending');
    if (acc) await j('PATCH', '/api/owner/access/' + acc.id, ownerTok, { status: 'approved' });
    const riderTok = (await j('POST', '/api/auth/login', null, { identifier: `${RUN}.rider@example.com`, password: PW })).d.token;
    await j('POST', '/api/agreements/accept', riderTok, { agreement: 'rider_terms' });
    const quote = () => j('POST', '/api/rides/quote', riderTok, { pickup_lat: PICKUP.lat, pickup_lng: PICKUP.lng, dest_lat: DEST.lat, dest_lng: DEST.lng, zone: 'zone-embu-pilot', vehicle_category: 'Passenger Car', distance_m: 5000, duration_s: 720 });

    let qr = await quote();
    ok('booking flow resolves county fallback', qr.s === 201 && Number(qr.d.quote.components.base_fare) === 999, qr.d);

    const zoneCard = await mkCard('zone-embu-pilot', 'car', 120);
    qr = await quote();
    ok('zone card preferred over county fallback', qr.s === 201 && Number(qr.d.quote.components.base_fare) === 120, qr.d && qr.d.quote && qr.d.quote.components);
    await off(zoneCard.d.id);
    await off(county.d.id);

    // 8. Vehicle-category mismatch stays blocked
    const boda = await mkCard('zone-embu-pilot', 'Boda Boda', 50);
    g = await rateGate();
    ok('category mismatch (only Boda Boda card) → blocked', g && g.pass === false, g);
    await off(boda.d.id);

    // 9. Effective date never shifts by timezone (calendar date in = calendar date out)
    const dated = await mkCard('zone-embu-pilot', 'car', 100, '2026-07-30');
    ok('date-only card stored as entered', dated.s === 201 && String(dated.d.effective_from).slice(0, 10) === '2026-07-30', dated.d);
    const listed = (await j('GET', '/api/owner/fare-cards', ownerTok)).d.find(c => c.id === dated.d.id);
    ok('listed effective date does not shift', listed && String(listed.effective_from).slice(0, 10) === '2026-07-30', listed);

    // 10. Repeated submission cannot create exact duplicates
    const dup = await j('POST', '/api/owner/fare-cards', ownerTok, { area: 'zone-embu-pilot', vehicle_category: 'car', base_fare: 100, per_km: 40, per_min: 5, minimum_fare: 150, effective_from: '2026-07-30' });
    ok('identical resubmission rejected with clear message', dup.s === 409 && /already exists/i.test(dup.d.error), dup);
    ok('near-identical different category allowed', (await mkCard('zone-embu-pilot', 'Boda Boda', 100, '2026-07-30')).s === 201);
    // deactivate the two we just made
    for (const id of created.slice(-2)) await off(id);
    await off(dated.d.id);

    // 11–12. Mandatory vs optional gate math
    const full = (await j('GET', '/api/owner/ride-gates', ownerTok)).d;
    const byName = Object.fromEntries(full.gates.map(x => [x.gate, x]));
    ok('M-Pesa is optional and does not block a cash pilot', byName.MPESA && byName.MPESA.required === false && (byName.MPESA.pass || byName.MPESA.status === 'OPTIONAL — NOT CONFIGURED'), byName.MPESA);
    ok('phone masking is optional with in-app chat fallback', byName.PHONE_MASKING && byName.PHONE_MASKING.required === false, byName.PHONE_MASKING);
    ok('production readiness computed from mandatory gates only', full.production_ready === full.gates.filter(x => x.required).every(x => x.pass), full);
    const mandatory = ['RIDE_HAILING_ENABLED', 'TNC_LICENSE_CONFIRMED', 'GOOGLE_MAPS_WEB_KEY', 'GOOGLE_MAPS_SERVER_KEY', 'SUPPORT_EMERGENCY_PHONE', 'RATE_CARD'];
    ok('mandatory gate set is exactly the cash-pilot list', mandatory.every(m => byName[m] && byName[m].required === true) && full.gates.filter(x => x.required).length === mandatory.length, full.gates.map(x => x.gate + ':' + x.required));
    ok('unmet mandatory gates block production readiness', full.production_ready === false, full);
    ok('every blocked gate has a readable reason', full.gates.filter(x => !x.pass).every(x => typeof x.detail === 'string' && x.detail.length > 10), full.gates);

    // 13. No secret values exposed
    const gatesRaw = JSON.stringify(full);
    const cfgRaw = JSON.stringify((await j('GET', '/api/rides/config', riderTok)).d);
    ok('gate + config payloads expose no secret-looking values', !/AIza|consumer|passkey|Bearer\s|[A-Za-z0-9+\/]{40,}/.test(gatesRaw + cfgRaw), null);
  } finally {
    // Cleanup: deactivate anything we created, restore what was active before
    for (const id of created) await off(id);
    for (const id of restoreActive) await j('PATCH', '/api/owner/fare-cards/' + id, ownerTok, { active: true });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
