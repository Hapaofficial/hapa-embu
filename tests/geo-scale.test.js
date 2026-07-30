// Kenya-scale geography tests: configurable hierarchy, Embu-first activation,
// inactive-market enforcement (publish + ride requests), per-area fare rate
// cards, county validation, and public-API exposure rules.
// Usage: node tests/geo-scale.test.js [baseUrl]
const B = process.argv[2] || 'http://127.0.0.1:5000';
const OWNER_EMAIL = process.env.TEST_OWNER_EMAIL;
const OWNER_PASSWORD = process.env.TEST_OWNER_PASSWORD;
const RUN = 'geo' + Date.now().toString(36);
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
  return { s: r.status, d: await r.json().catch(() => ({})) };
};

async function makeUser(ownerTok, label, capType, details) {
  const em = `${RUN}.${label}@example.com`;
  const reg = await j('POST', '/api/auth/register', null, { name: 'GEO ' + label, email: em, password: PW, selfie: 'data:image/png;base64,iVBORw0KGgo=' });
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

(async () => {
  if (!OWNER_EMAIL || !OWNER_PASSWORD) { console.error('TEST_OWNER_EMAIL/TEST_OWNER_PASSWORD required'); process.exit(1); }
  const ownerTok = (await j('POST', '/api/auth/login', null, { identifier: OWNER_EMAIL, password: OWNER_PASSWORD })).d.token;
  if (!ownerTok) { console.error('owner login failed'); process.exit(1); }

  // ── 1. Seeded hierarchy: Embu active, other counties configured but inactive
  const pub = await j('GET', '/api/public/areas');
  ok('public areas returns 200', pub.s === 200);
  const pubNames = (pub.d.areas || []).map(a => a.name);
  ok('Embu county is active/public', pubNames.includes('Embu'));
  ok('Embu pilot zone is active/public', (pub.d.areas || []).some(a => a.level === 'zone' && a.slug === 'zone-embu-pilot'));
  ok('inactive counties (Nairobi) not exposed publicly', !pubNames.includes('Nairobi'));
  ok('launch note is Embu-first, not Embu-only', String(pub.d.launch_note || '').includes('Launching first'));

  const all = (await j('GET', '/api/owner/areas', ownerTok)).d;
  const counties = all.filter(a => a.level === 'county');
  ok('all 47 Kenyan counties configured', counties.length === 47, counties.length);
  const nairobi = counties.find(a => a.name === 'Nairobi');
  ok('Nairobi exists but inactive by default', nairobi && nairobi.active === false);

  // owner-only management
  ok('area list requires owner', (await j('GET', '/api/owner/areas')).s === 401);

  // ── 2. Inactive market blocks providers from going online
  const drv = await makeUser(ownerTok, 'driver', 'driver', { fullName: 'GEO driver', drivingLicenceNumber: 'DL-GEO-1', vehicleType: 'Boda Boda', registrationNumber: 'KAA 111G', county: 'Nairobi' });
  await j('POST', '/api/me/driver-profile', drv.tok);
  ok('unknown county rejected on profile', (await j('PATCH', '/api/me/driver-profile', drv.tok, { county: 'Atlantis' })).s === 400);
  const setN = await j('PATCH', '/api/me/driver-profile', drv.tok, { display_name: 'GEO Boda Nairobi', county: 'Nairobi' });
  ok('known Kenyan county accepted on profile', setN.s === 200, setN.d);
  const pubBlocked = await j('POST', '/api/me/driver-profile/publish', drv.tok);
  ok('driver in inactive county cannot go online', pubBlocked.s === 403, pubBlocked);

  // ── 3. Activating a market is configuration only — no code change
  const act = await j('PATCH', '/api/owner/areas/' + nairobi.id, ownerTok, { active: true });
  ok('owner activates Nairobi via config', act.s === 200 && act.d.active === true);
  ok('activated county appears publicly automatically', ((await j('GET', '/api/public/areas')).d.areas || []).some(a => a.name === 'Nairobi'));
  const pubNow = await j('POST', '/api/me/driver-profile/publish', drv.tok);
  ok('driver can go online once market active', pubNow.s === 200, pubNow.d);
  const dvProfileId = (await j('GET', '/api/me/driver-profile', drv.tok)).d.profile.id;

  // ── 4. Pausing the market blocks new ride requests to its providers
  const cust = await makeUser(ownerTok, 'cust', null);
  await j('PATCH', '/api/owner/areas/' + nairobi.id, ownerTok, { active: false });
  const reqBlocked = await j('POST', '/api/requests', cust.tok, { provider_type: 'driver', request_type: 'ride', profile_id: dvProfileId, pickup_text: 'CBD', destination_text: 'Westlands' });
  ok('ride request into paused market blocked', reqBlocked.s === 403, reqBlocked);
  await j('PATCH', '/api/owner/areas/' + nairobi.id, ownerTok, { active: true });
  const reqOk = await j('POST', '/api/requests', cust.tok, { provider_type: 'driver', request_type: 'ride', profile_id: dvProfileId, pickup_text: 'CBD', destination_text: 'Westlands' });
  ok('ride request allowed in active market', reqOk.s === 201, reqOk);

  // ── 5. Fare rate cards: separate per area; zone overrides county; Embu is not the default
  const zone = all.find(a => a.slug === 'zone-embu-pilot');
  const embu = counties.find(a => a.name === 'Embu');
  const cat = 'GeoTest-' + RUN;
  const cEmbuCounty = await j('POST', '/api/owner/fare-cards', ownerTok, { area: embu.id, vehicle_category: cat, base_fare: 40, per_km: 18, per_min: 2, minimum_fare: 60 });
  const cEmbuZone = await j('POST', '/api/owner/fare-cards', ownerTok, { area: zone.id, vehicle_category: cat, base_fare: 50, per_km: 20, per_min: 3, minimum_fare: 80 });
  const cNairobi = await j('POST', '/api/owner/fare-cards', ownerTok, { area: nairobi.id, vehicle_category: cat, base_fare: 100, per_km: 35, per_min: 5, minimum_fare: 200 });
  ok('rate cards created per area', cEmbuCounty.s === 201 && cEmbuZone.s === 201 && cNairobi.s === 201);
  ok('rate card creation is owner-only', (await j('POST', '/api/owner/fare-cards', cust.tok, { area: embu.id, vehicle_category: cat, base_fare: 1 })).s === 403);

  const q = `vehicle_category=${encodeURIComponent(cat)}&distance_m=5000&duration_s=600`;
  const eZone = (await j('GET', `/api/public/fare-estimate?area=zone-embu-pilot&${q}`)).d;
  const eEmbu = (await j('GET', `/api/public/fare-estimate?area=county-embu&${q}`)).d;
  const eNbo = (await j('GET', `/api/public/fare-estimate?area=Nairobi&${q}`)).d;
  ok('zone card overrides county card', eZone.base_fare === 50 && eZone.estimate === Math.round(50 + 5 * 20 + 10 * 3), eZone);
  ok('county card applies at county level', eEmbu.base_fare === 40, eEmbu);
  ok('different areas price independently', eNbo.base_fare === 100 && eNbo.estimate !== eZone.estimate, eNbo);
  ok('minimum fare enforced', (await j('GET', `/api/public/fare-estimate?area=Nairobi&vehicle_category=${encodeURIComponent(cat)}&distance_m=100&duration_s=30`)).d.estimate === 200);

  // ── 5b. Hierarchy safety: an active zone is hidden when its county is paused
  await j('PATCH', '/api/owner/areas/' + nairobi.id, ownerTok, { active: true });
  const nboZone = await j('POST', '/api/owner/areas', ownerTok, { name: 'GeoZone ' + RUN, level: 'zone', parent: nairobi.id, active: true });
  ok('owner can add a zone via config', nboZone.s === 201, nboZone.d);
  ok('active zone under active county is public', ((await j('GET', '/api/public/areas')).d.areas || []).some(a => a.id === nboZone.d.id));
  const zEst = await j('GET', `/api/public/fare-estimate?area=${nboZone.d.slug}&${q}`);
  ok('zone inherits county rate card via ancestor fallback', zEst.s === 200 && zEst.d.base_fare === 100, zEst.d);
  await j('PATCH', '/api/owner/areas/' + nairobi.id, ownerTok, { active: false });
  ok('active zone hidden when parent county paused', !((await j('GET', '/api/public/areas')).d.areas || []).some(a => a.id === nboZone.d.id));
  ok('zone fare estimate blocked when parent county paused', (await j('GET', `/api/public/fare-estimate?area=${nboZone.d.slug}&${q}`)).s === 404);
  await j('PATCH', '/api/owner/areas/' + nboZone.d.id, ownerTok, { active: false });
  await j('PATCH', '/api/owner/areas/' + nairobi.id, ownerTok, { active: true });

  // deactivate Nairobi again → its estimates become unavailable (no leakage of paused markets)
  await j('PATCH', '/api/owner/areas/' + nairobi.id, ownerTok, { active: false });
  ok('fare estimate hidden for paused market', (await j('GET', `/api/public/fare-estimate?area=Nairobi&${q}`)).s === 404);
  ok('paused county removed from public areas', !((await j('GET', '/api/public/areas')).d.areas || []).some(a => a.name === 'Nairobi'));
  ok('country cannot be deactivated', (await j('PATCH', '/api/owner/areas/kenya', ownerTok, { active: false })).s === 400);

  // ── 6. Cleanup: deactivate test rate cards, remove synthetic users
  for (const c of [cEmbuCounty, cEmbuZone, cNairobi]) if (c.s === 201) await j('PATCH', '/api/owner/fare-cards/' + c.d.id, ownerTok, { active: false });
  for (const u of [drv, cust]) await j('PATCH', '/api/owner/users/' + u.uid, ownerTok, { status: 'deactivated' });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
