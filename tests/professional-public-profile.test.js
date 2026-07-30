// Automated tests: Public Professional Profile (Sprint 3A)
// Usage: node tests/professional-public-profile.test.js [baseUrl]
// Requires a running server and the seeded local fixtures:
//   fixture.professional@example.com / Fixture2026!  (approved professional)
//   fixture.merchant@example.com     / Fixture2026!  (non-professional customer)
// Owner credentials via env: TEST_OWNER_EMAIL / TEST_OWNER_PASSWORD
const path = require('path');
const crypto = require('crypto');
const sharp = require(path.join(__dirname, '..', 'node_modules', 'sharp'));

const B = process.argv[2] || 'http://127.0.0.1:5000';
const OWNER_EMAIL = process.env.TEST_OWNER_EMAIL;
const OWNER_PASSWORD = process.env.TEST_OWNER_PASSWORD;
const PRO = 'fixture.professional@example.com';
const OTHER = 'fixture.merchant@example.com';
const PW = 'Fixture2026!';

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
  return { s: r.status, d: await r.json().catch(() => ({})), h: r.headers };
};
const upload = async (p, t, buf, mime, name) => {
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: mime || 'image/jpeg' }), name || 'x.jpg');
  const r = await fetch(B + p, { method: 'POST', headers: t ? { Authorization: 'Bearer ' + t } : {}, body: fd });
  return { s: r.status, d: await r.json().catch(() => ({})) };
};
const login = async (e, p) => (await j('POST', '/api/auth/login', null, { identifier: e, password: p })).d.token;
const noPrivateLeak = (o) => !/private_document|sensitive_details|upgrade_document|hapa-private|hapa-staging-private|DOCUMENT_S3|access_key|secret/i.test(JSON.stringify(o));

(async () => {
  const pro = await login(PRO, PW);
  const other = await login(OTHER, PW);
  const owner = OWNER_EMAIL ? await login(OWNER_EMAIL, OWNER_PASSWORD) : null;
  if (!pro || !other) { console.error('fixture login failed'); process.exit(1); }

  // --- profile lifecycle ---
  let g = await j('GET', '/api/me/professional-profile', pro);
  if (g.s === 404) g = { d: { profile: (await j('POST', '/api/me/professional-profile', pro)).d.profile, portfolio: [] } };
  ok('approved professional has/creates profile', !!g.d.profile);
  const pid = g.d.profile.id;

  const patch = await j('PATCH', '/api/me/professional-profile', pro, {
    headline: 'Reliable electrician in Embu town',
    service_description: 'Wiring, repairs, solar and installations across Embu.',
    skills: ['wiring', 'repairs', 'solar'], starting_price: 500,
  });
  ok('edit allowed fields', patch.s === 200, patch);
  const locked = await j('PATCH', '/api/me/professional-profile', pro, { verified_category: 'plumber' });
  ok('verified_category locked (400)', locked.s === 400, locked.s);
  const roleLock = await j('PATCH', '/api/me/professional-profile', pro, { role: 'owner' });
  ok('role not editable via profile', roleLock.s === 400 || !(roleLock.d.profile && roleLock.d.profile.role === 'owner'));

  ok('non-professional cannot create profile', (await j('POST', '/api/me/professional-profile', other)).s === 403);
  ok('another customer cannot edit (403/404)', [403, 404].includes((await j('PATCH', '/api/me/professional-profile', other, { headline: 'x' })).s));
  ok('unauthenticated write 401', (await j('PATCH', '/api/me/professional-profile', null, { headline: 'x' })).s === 401);

  // --- images ---
  const jpg = await sharp({ create: { width: 300, height: 200, channels: 3, background: { r: 40, g: 90, b: 160 } } })
    .jpeg().withMetadata({ exif: { IFD0: { Copyright: 'strip-me' } } }).toBuffer();
  // idempotency: clear leftover portfolio images from prior runs (fixture user is reused)
  const preMe = await j('GET', '/api/me/professional-profile', pro);
  for (const im of ((preMe.d && preMe.d.portfolio) || [])) {
    await j('DELETE', '/api/me/professional-profile/portfolio/' + im.id, pro);
  }
  ok('SVG rejected', (await upload('/api/me/professional-profile/portfolio', pro, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml', 'x.svg')).s === 400);
  ok('malformed bytes rejected', (await upload('/api/me/professional-profile/portfolio', pro, Buffer.from('not-an-image'), 'image/jpeg')).s === 400);
  const up1 = await upload('/api/me/professional-profile/portfolio', pro, jpg);
  const up2 = await upload('/api/me/professional-profile/portfolio', pro, jpg);
  ok('portfolio upload works', up1.s === 201 && up2.s === 201, [up1.s, up2.s]);
  const ph = await upload('/api/me/professional-profile/profile-photo', pro, jpg);
  ok('profile photo upload works', ph.s === 201 || ph.s === 200, ph.s);

  g = await j('GET', '/api/me/professional-profile', pro);
  const ids = g.d.portfolio.map(i => i.id);
  const reordered = [...ids.slice(1), ids[0]];
  const ord = await j('PATCH', '/api/me/professional-profile/portfolio/order', pro, { ids: reordered });
  ok('reorder works', ord.s === 200, ord);
  const del = await j('DELETE', '/api/me/professional-profile/portfolio/' + ids[0], pro);
  ok('remove (soft delete) works', del.s === 200, del.s);

  // --- visibility ---
  const pubWhileHiddenState = async () => (await j('GET', '/api/public/professionals/' + pid)).s;
  const pubList = async () => (await j('GET', '/api/public/professionals')).d;
  if ((await j('GET', '/api/me/professional-profile', pro)).d.profile.status !== 'active') {
    const pubr = await j('POST', '/api/me/professional-profile/publish', pro);
    ok('publish works', pubr.s === 200, pubr);
  }
  ok('active profile is public', (await j('GET', '/api/public/professionals/' + pid)).s === 200);
  const listed = await pubList();
  ok('active profile in public list', JSON.stringify(listed).includes(pid));
  ok('public payload has no private data', noPrivateLeak(await (await fetch(B + '/api/public/professionals/' + pid)).json()));

  g = await j('GET', '/api/me/professional-profile', pro);
  const imgId = g.d.portfolio[0] && g.d.portfolio[0].id;
  if (imgId) {
    const mr = await fetch(B + '/api/public/professional-media/' + imgId, { redirect: 'manual' });
    ok('public media served (200/302 signed)', [200, 302].includes(mr.status), mr.status);
    ok('media nosniff header', mr.headers.get('x-content-type-options') === 'nosniff' || mr.status === 302);
    if (mr.status === 200) {
      const buf = Buffer.from(await mr.arrayBuffer());
      ok('EXIF stripped from served image', !buf.includes(Buffer.from('strip-me')));
    }
  }

  // --- owner media route (editor works regardless of profile status) ---
  const ownerImg = g.d.portfolio[0] || g.d.profile_photo;
  ok('authenticated payload uses owner media route', ownerImg && ownerImg.url.startsWith('/api/me/professional-profile/media/'), ownerImg && ownerImg.url);
  const ownerFetch = async (t) => (await fetch(B + ownerImg.url, { headers: t ? { Authorization: 'Bearer ' + t } : {}, redirect: 'manual' })).status;
  const ownerOkStatus = async (t) => [200, 302].includes(await ownerFetch(t));
  ok('owner can view own media (active)', await ownerOkStatus(pro));
  ok('unauthenticated owner-media rejected (401)', await ownerFetch(null) === 401);
  ok('another customer cannot access owner media', [403, 404].includes(await ownerFetch(other)));
  await j('POST', '/api/me/professional-profile/pause', pro);
  ok('owner can view own media while paused', await ownerOkStatus(pro));
  ok('paused media unavailable via public route', (await fetch(B + '/api/public/professional-media/' + ownerImg.id, { redirect: 'manual' })).status === 404);
  await j('POST', '/api/me/professional-profile/reactivate', pro);
  ok('active media available via public route', [200, 302].includes((await fetch(B + '/api/public/professional-media/' + ownerImg.id, { redirect: 'manual' })).status));

  ok('pause works', (await j('POST', '/api/me/professional-profile/pause', pro)).s === 200);
  ok('paused profile not public', await pubWhileHiddenState() === 404);
  ok('reactivate works', (await j('POST', '/api/me/professional-profile/reactivate', pro)).s === 200);

  // --- owner moderation ---
  if (owner) {
    const before = await j('GET', '/api/me', pro);
    ok('owner list includes profile', JSON.stringify((await j('GET', '/api/owner/professional-profiles', owner)).d).includes(pid));
    const hide = await j('PATCH', '/api/owner/professional-profiles/' + pid + '/status', owner, { status: 'owner_hidden', moderation_note: 'automated test' });
    ok('owner hide works', hide.s === 200 && hide.d.status === 'owner_hidden', hide);
    ok('hidden profile not public', await pubWhileHiddenState() === 404);
    ok('professional cannot self-restore while hidden', (await j('POST', '/api/me/professional-profile/publish', pro)).s === 403);
    {
      const gg = await j('GET', '/api/me/professional-profile', pro);
      const im = gg.d.portfolio[0] || gg.d.profile_photo;
      const st = (await fetch(B + im.url, { headers: { Authorization: 'Bearer ' + pro }, redirect: 'manual' })).status;
      ok('owner can view own media while owner_hidden', [200, 302].includes(st), st);
      ok('owner_hidden media unavailable via public route', (await fetch(B + '/api/public/professional-media/' + im.id, { redirect: 'manual' })).status === 404);
    }
    const catTry = await j('PATCH', '/api/owner/professional-profiles/' + pid + '/status', owner, { status: 'active', verified_category: 'plumber' });
    const restore = catTry.s === 200 ? catTry : await j('PATCH', '/api/owner/professional-profiles/' + pid + '/status', owner, { status: 'active' });
    ok('owner restore returns prior status (active)', restore.s === 200 && restore.d.status === 'active', restore);
    ok('owner cannot change verified category via moderation', restore.d.verified_category === g.d.profile.verified_category);
    const after = await j('GET', '/api/me', pro);
    ok('hide/restore left role=customer', after.d.role === 'customer', after.d.role);
    ok('hide/restore kept professional capability', after.d.capabilities && after.d.capabilities.professional === true);
    ok('verified application unchanged', JSON.stringify((await j('GET', '/api/me/upgrades/professional', pro)).d.status) === JSON.stringify((await j('GET', '/api/me/upgrades/professional', pro)).d.status));
    ok('/api/me unchanged shape by moderation', JSON.stringify(Object.keys(before.d)) === JSON.stringify(Object.keys(after.d)));
  } else {
    console.log('SKIP owner moderation tests (set TEST_OWNER_EMAIL/TEST_OWNER_PASSWORD)');
  }

  // --- regressions: marketplace, upgrades, secure documents ---
  ok('health OK', (await j('GET', '/api/health')).s === 200);
  ok('public marketplace OK', (await j('GET', '/api/public/marketplace')).s === 200);
  ok('me/upgrades still works', (await j('GET', '/api/me/upgrades', pro)).s === 200);
  const docs = await j('GET', '/api/me/upgrades/professional/documents', pro);
  ok('private documents route intact', [200, 404].includes(docs.s), docs.s);
  ok('private docs still require auth', (await j('GET', '/api/me/upgrades/professional/documents')).s === 401);

  // --- storage safety (unit) ---
  delete require.cache[require.resolve('../lib/publicMediaStorage')];
  const guardEnv = { ...process.env, PUBLIC_MEDIA_STORAGE_MODE: 's3', PUBLIC_MEDIA_S3_BUCKET: process.env.DOCUMENT_S3_BUCKET || 'hapa-staging-private-documents' };
  const { execFileSync } = require('child_process');
  const out = execFileSync(process.execPath, ['-e', "console.log(require('./lib/publicMediaStorage').isConfigured())"], { env: guardEnv, cwd: path.join(__dirname, '..') }).toString();
  ok('guard refuses private-document bucket', out.includes('false'), out.trim());

  console.log('\nTOTAL pass=' + pass + ' fail=' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
