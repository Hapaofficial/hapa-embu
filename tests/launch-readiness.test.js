// Launch-readiness tests: media deletion authorization, precise GPS trip data
// & location privacy, account deletion, device tokens, deep-link association
// endpoints, PWA cache safety (static analysis of sw.js).
// Usage: node tests/launch-readiness.test.js [baseUrl]
// Requires a running server in demo auth mode with local storage modes and
// TEST_OWNER_EMAIL / TEST_OWNER_PASSWORD. All test users are synthetic and
// deactivated at the end.
const path = require('path');
const fs = require('fs');
const sharp = require(path.join(__dirname, '..', 'node_modules', 'sharp'));

const B = process.argv[2] || 'http://127.0.0.1:5000';
const OWNER_EMAIL = process.env.TEST_OWNER_EMAIL;
const OWNER_PASSWORD = process.env.TEST_OWNER_PASSWORD;
const RUN = 'lr' + Date.now().toString(36);
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
  return { s: r.status, d: await r.json().catch(() => ({})), h: r.headers };
};
const upload = async (p, t, buf) => {
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: 'image/jpeg' }), 'x.jpg');
  const r = await fetch(B + p, { method: 'POST', headers: t ? { Authorization: 'Bearer ' + t } : {}, body: fd });
  return { s: r.status, d: await r.json().catch(() => ({})) };
};

async function makeUser(ownerTok, label, capType, details) {
  const em = `${RUN}.${label}@example.com`;
  const reg = await j('POST', '/api/auth/register', null, { name: 'LR ' + label, email: em, password: PW, selfie: 'data:image/png;base64,iVBORw0KGgo=' });
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
  const img = await sharp({ create: { width: 40, height: 40, channels: 3, background: { r: 30, g: 90, b: 200 } } }).jpeg().toBuffer();

  const cust = await makeUser(ownerTok, 'cust', null);
  const stranger = await makeUser(ownerTok, 'stranger', null);
  const merch = await makeUser(ownerTok, 'merch', 'merchant', { businessName: 'LR Shop', ownerName: 'LR merch', businessCategory: 'Groceries', county: 'Embu' });
  const drv = await makeUser(ownerTok, 'drv', 'driver', { fullName: 'LR driver', drivingLicenceNumber: 'DL-LR-1', vehicleType: 'Boda Boda', registrationNumber: 'KBB 111T', county: 'Embu' });
  const deluser = await makeUser(ownerTok, 'del', null);

  // ══ 1. MERCHANT MEDIA DELETION AUTHORIZATION ══
  await j('POST', '/api/me/merchant-profile', merch.tok);
  await j('PATCH', '/api/me/merchant-profile', merch.tok, { description: 'Fresh produce in Embu town', town: 'Embu' });
  const logo = await upload('/api/me/merchant-profile/logo', merch.tok, img);
  ok('merchant logo upload', logo.s === 201, logo);
  const gal = await upload('/api/me/merchant-profile/gallery', merch.tok, img);
  ok('merchant gallery upload', gal.s === 201, gal);
  await j('POST', '/api/me/merchant-profile/publish', merch.tok);
  const mcMe = (await j('GET', '/api/me/merchant-profile', merch.tok)).d;
  const mcId = mcMe.profile.id;
  // public shows logo+gallery
  let pub = (await j('GET', '/api/public/merchants/' + mcId)).d;
  ok('public merchant shows logo', !!pub.logo, pub.logo);
  ok('public merchant shows gallery', (pub.gallery || []).length === 1);

  // unrelated user (no merchant capability) cannot delete
  ok('stranger blocked from logo delete', (await j('DELETE', '/api/me/merchant-profile/logo', stranger.tok)).s >= 400);
  ok('stranger blocked from gallery delete', (await j('DELETE', '/api/me/merchant-profile/gallery/' + gal.d.id, stranger.tok)).s >= 400);
  ok('unauthenticated blocked from logo delete', (await j('DELETE', '/api/me/merchant-profile/logo', null)).s === 401);
  // a DIFFERENT merchant cannot delete this merchant's gallery media (IDOR)
  const merch2 = await makeUser(ownerTok, 'merch2', 'merchant', { businessName: 'LR Shop 2', ownerName: 'LR merch2', businessCategory: 'Retail', county: 'Embu' });
  await j('POST', '/api/me/merchant-profile', merch2.tok);
  ok('other merchant blocked from gallery delete (IDOR)', (await j('DELETE', '/api/me/merchant-profile/gallery/' + gal.d.id, merch2.tok)).s === 404);
  // still present after failed attempts
  pub = (await j('GET', '/api/public/merchants/' + mcId)).d;
  ok('gallery intact after blocked deletes', (pub.gallery || []).length === 1);

  // owner deletes own media → disappears publicly
  ok('owner deletes own logo', (await j('DELETE', '/api/me/merchant-profile/logo', merch.tok)).s === 200);
  ok('owner deletes own gallery photo', (await j('DELETE', '/api/me/merchant-profile/gallery/' + gal.d.id, merch.tok)).s === 200);
  pub = (await j('GET', '/api/public/merchants/' + mcId)).d;
  ok('logo gone from public view', !pub.logo);
  ok('gallery gone from public view', (pub.gallery || []).length === 0);

  // item image lifecycle
  const item = (await j('POST', '/api/me/merchant-items', merch.tok, { title: 'LR Sukuma wiki', description: 'Fresh bundle', category: 'Groceries', price: 30, price_unit: 'per bundle' })).d;
  const itImg = await upload(`/api/me/merchant-items/${item.id}/images`, merch.tok, img);
  ok('item image upload', itImg.s === 201, itImg);
  ok('other merchant blocked from item image delete', (await j('DELETE', `/api/me/merchant-items/${item.id}/images/${itImg.d.id}`, merch2.tok)).s === 404);
  ok('owner deletes item image', (await j('DELETE', `/api/me/merchant-items/${item.id}/images/${itImg.d.id}`, merch.tok)).s === 200);

  // ══ 2. DRIVER MEDIA DELETION ══
  await j('POST', '/api/me/driver-profile', drv.tok);
  await j('PATCH', '/api/me/driver-profile', drv.tok, { display_name: 'LR Rider', vehicle_description: 'Reliable boda', town: 'Embu' });
  const dvPh = await upload('/api/me/driver-profile/profile-photo', drv.tok, img);
  ok('driver photo upload', dvPh.s === 201, dvPh);
  await j('POST', '/api/me/driver-profile/publish', drv.tok);
  const dvId = (await j('GET', '/api/me/driver-profile', drv.tok)).d.profile.id;
  ok('stranger blocked from driver photo delete', (await j('DELETE', '/api/me/driver-profile/profile-photo', stranger.tok)).s >= 400);
  let dpub = (await j('GET', '/api/public/drivers/' + dvId)).d;
  ok('public driver shows photo', !!dpub.profile_photo);
  ok('driver deletes own photo', (await j('DELETE', '/api/me/driver-profile/profile-photo', drv.tok)).s === 200);
  dpub = (await j('GET', '/api/public/drivers/' + dvId)).d;
  ok('driver photo gone from public view', !dpub.profile_photo);

  // ══ 3. PRECISE GPS TRIP DATA + LOCATION PRIVACY ══
  const badGeo = await j('POST', '/api/requests', cust.tok, { provider_type: 'driver', profile_id: dvId, request_type: 'ride', pickup_text: 'A', destination_text: 'B', pickup_lat: 999, pickup_lng: 37.45 });
  ok('out-of-range latitude rejected', badGeo.s === 400, badGeo);
  const halfGeo = await j('POST', '/api/requests', cust.tok, { provider_type: 'driver', profile_id: dvId, request_type: 'ride', pickup_text: 'A', destination_text: 'B', pickup_lat: -0.53, pickup_lng: 'not-a-number' });
  ok('non-numeric coordinate rejected', halfGeo.s === 400, halfGeo);
  const ride = await j('POST', '/api/requests', cust.tok, {
    provider_type: 'driver', profile_id: dvId, request_type: 'ride',
    pickup_address: 'Embu Town CBD', destination_address: 'Kangaru Market',
    pickup_lat: -0.5390, pickup_lng: 37.4575, destination_lat: -0.5215, destination_lng: 37.4410,
    pickup_note: 'Call on arrival', landmark: 'Blue gate', route_distance_m: 3450, route_duration_s: 540,
  });
  ok('ride with GPS created', ride.s === 201, ride.d);
  ok('ride stores coordinates', ride.d.pickup_lat === -0.539 && ride.d.destination_lng === 37.441, ride.d);
  ok('ride stores route estimate', ride.d.route_distance_m === 3450 && ride.d.route_duration_s === 540);
  ok('pickup_text falls back to address', ride.d.pickup_text === 'Embu Town CBD');
  const rid = ride.d.id;
  // authorized access
  ok('customer sees coordinates', (await j('GET', '/api/requests/' + rid, cust.tok)).d.pickup_lat === -0.539);
  ok('addressed driver sees coordinates', (await j('GET', '/api/requests/' + rid, drv.tok)).d.pickup_lat === -0.539);
  ok('unrelated user denied trip access', (await j('GET', '/api/requests/' + rid, stranger.tok)).s === 404);
  ok('owner support can see trip', (await j('GET', '/api/requests/' + rid, ownerTok)).s === 200);
  // public APIs must never carry coordinates
  for (const ep of ['/api/public/drivers', '/api/public/drivers/' + dvId, '/api/public/merchants', '/api/public/professionals']) {
    const body = JSON.stringify((await j('GET', ep)).d);
    ok('no coordinates leak in ' + ep, !/pickup_lat|destination_lat|pickup_lng|-0\.539|37\.4575/.test(body));
  }
  // status flow: accept → navigation data available to driver; complete
  ok('driver accepts ride', (await j('POST', `/api/requests/${rid}/status`, drv.tok, { status: 'accepted' })).s === 200);
  ok('driver completes ride', (await j('POST', `/api/requests/${rid}/status`, drv.tok, { status: 'completed' })).s === 200);
  ok('customer reviews completed ride', (await j('POST', `/api/requests/${rid}/review`, cust.tok, { rating: 5, comment: 'Great ride' })).s === 201);

  // ══ 4. DEVICE TOKENS ══
  const dt = await j('POST', '/api/me/device-tokens', cust.tok, { platform: 'android', token: 'lr-test-token-' + RUN });
  ok('device token registered', dt.s === 200, dt);
  ok('bad platform rejected', (await j('POST', '/api/me/device-tokens', cust.tok, { platform: 'windows', token: 'lr-tok-2-' + RUN })).s === 400);
  ok('short token rejected', (await j('POST', '/api/me/device-tokens', cust.tok, { platform: 'ios', token: 'x' })).s === 400);
  ok('unauthenticated token register blocked', (await j('POST', '/api/me/device-tokens', null, { platform: 'android', token: 'lr-anon-token-000' })).s === 401);
  ok('token re-register (replacement) ok', (await j('POST', '/api/me/device-tokens', cust.tok, { platform: 'android', token: 'lr-test-token-' + RUN })).s === 200);
  ok('device token deleted', (await j('DELETE', '/api/me/device-tokens', cust.tok, { token: 'lr-test-token-' + RUN })).s === 200);
  const np = await j('PATCH', '/api/me/notification-prefs', cust.tok, { requests: false, bogus: true });
  ok('notification prefs saved (allow-list)', np.s === 200 && np.d.notify_prefs.requests === false && !('bogus' in np.d.notify_prefs), np.d);

  // ══ 5. ACCOUNT DELETION ══
  await j('POST', '/api/me/device-tokens', deluser.tok, { platform: 'ios', token: 'lr-del-token-' + RUN });
  // deleted user's marketplace listings must disappear from public discovery
  const lst = await j('POST', '/api/marketplace', deluser.tok, { title: 'LR Delete Chair ' + RUN, description: 'Sturdy wooden chair for testing.', category: 'Furniture', condition: 'Used', price: 500, location: 'Embu Town', images: ['/public-media/test/lr-chair.jpg'] });
  ok('listing created for deletion test', lst.s === 201, lst);
  const lstId = lst.d.id;
  ok('listing publicly visible pre-delete', (await j('GET', '/api/public/marketplace/' + lstId)).s === 200);
  ok('deletion requires correct password', (await j('POST', '/api/me/delete', deluser.tok, { password: 'wrong', confirm: 'DELETE' })).s === 403);
  ok('deletion requires DELETE confirmation', (await j('POST', '/api/me/delete', deluser.tok, { password: PW, confirm: 'no' })).s === 400);
  ok('owner account cannot self-delete', (await j('POST', '/api/me/delete', ownerTok, { password: OWNER_PASSWORD, confirm: 'DELETE' })).s === 403);
  const del = await j('POST', '/api/me/delete', deluser.tok, { password: PW, confirm: 'DELETE' });
  ok('account deletion succeeds', del.s === 200, del);
  ok('deleted token no longer works', (await j('GET', '/api/me', deluser.tok)).s === 401);
  const relog = await j('POST', '/api/auth/login', null, { identifier: deluser.em, password: PW });
  ok('deleted account cannot log in', relog.s >= 400, relog);
  const du = (await j('GET', '/api/owner/users?q=' + RUN, ownerTok)).d;
  const drow = (Array.isArray(du) ? du : du.users || []).find(u => u.id === deluser.uid);
  ok('deleted user anonymized (name wiped)', !drow || (drow.name === 'Deleted user' && !(drow.email || '').includes('@example.com')), drow);
  ok('deleted user listing gone from public detail', (await j('GET', '/api/public/marketplace/' + lstId)).s === 404);
  const pubList = await j('GET', '/api/public/marketplace?q=' + encodeURIComponent('LR Delete Chair ' + RUN));
  ok('deleted user listing gone from public search', (pubList.d.data || []).length === 0, pubList.d.total);
  // external deletion page
  const dp = await fetch(B + '/delete-account');
  ok('external deletion page reachable', dp.status === 200 && /Delete your HAPA account/.test(await dp.text()));

  // ══ 6. DEEP-LINK ASSOCIATION + PUBLIC CONFIG ══
  ok('assetlinks 404 when unconfigured (nothing invented)', (await fetch(B + '/.well-known/assetlinks.json')).status === 404);
  ok('apple-app-site-association 404 when unconfigured', (await fetch(B + '/.well-known/apple-app-site-association')).status === 404);
  const cfg = await j('GET', '/api/public/config');
  ok('public config safe shape', cfg.s === 200 && 'mapsBrowserKey' in cfg.d && !/secret|password|jwt/i.test(JSON.stringify(cfg.d)));

  // ══ 7. PWA CACHE SAFETY (static analysis) ══
  const sw = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
  ok('sw never caches /api/', /pathname\.startsWith\('\/api\/'\)\)return/.test(sw.replace(/\s+/g, '')));
  ok('sw has offline fallback', sw.includes('/offline.html'));
  ok('offline page exists', fs.existsSync(path.join(__dirname, '..', 'public', 'offline.html')));
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'manifest.webmanifest'), 'utf8'));
  ok('manifest valid for install', manifest.name && manifest.short_name && manifest.start_url === '/' && manifest.display === 'standalone' && manifest.icons.length > 0);

  // ══ 8. NATIVE PROJECT CONFIGURATION (static) ══
  const capCfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'capacitor.config.json'), 'utf8'));
  ok('capacitor staging config points at staging', capCfg.server.url.includes('staging') && capCfg.appId.endsWith('.staging'));
  const capProd = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'capacitor.config.production.json'), 'utf8'));
  ok('capacitor production config separate', capProd.server.url === 'https://hapa-embu.onrender.com' && !capProd.appId.endsWith('.staging'));
  const am = fs.readFileSync(path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf8');
  ok('android manifest: fine location, no background location', am.includes('ACCESS_FINE_LOCATION') && !am.includes('ACCESS_BACKGROUND_LOCATION'));
  ok('android manifest: camera + notifications', am.includes('android.permission.CAMERA') && am.includes('POST_NOTIFICATIONS'));
  const plist = fs.readFileSync(path.join(__dirname, '..', 'ios', 'App', 'App', 'Info.plist'), 'utf8');
  ok('ios plist: usage descriptions present', plist.includes('NSLocationWhenInUseUsageDescription') && plist.includes('NSCameraUsageDescription') && plist.includes('NSPhotoLibraryUsageDescription'));
  ok('ios plist: no background location', !plist.includes('NSLocationAlwaysUsageDescription') && !plist.includes('NSLocationAlwaysAndWhenInUseUsageDescription'));
  ok('ios privacy manifest exists', fs.existsSync(path.join(__dirname, '..', 'ios', 'App', 'App', 'PrivacyInfo.xcprivacy')));
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }; // mobile toolchain lives in devDependencies (web build skips it)
  ok('capacitor + secure storage installed', !!allDeps['@capacitor/core'] && !!allDeps['capacitor-secure-storage-plugin']);
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  ok('frontend uses secure storage bridge', html.includes('SecureStoragePlugin') && html.includes('secureLoadToken'));
  ok('frontend never puts token in URL', !/[?&]token=/.test(html));

  // ══ 9. UI DESIGN SYSTEM & OWNER POLISH (static) ══
  ok('design system: hapa css variables defined', ['--hapa-background:#F5F7FA', '--hapa-surface:#FFFFFF', '--hapa-header:#101C2C', '--hapa-primary:#F5A623', '--hapa-danger:#C63C49', '--hapa-success:#198754', '--hapa-border:#E1E6ED'].every(v => html.includes(v)));
  ok('design system: legacy vars remapped to hapa tokens', html.includes('--bg:var(--hapa-background)') && html.includes('--a:var(--hapa-primary)') && html.includes('--bad:var(--hapa-danger)'));
  ok('design system: no dark-theme input backgrounds remain', !html.includes('#0d1528') && !html.includes('#0b1020') && !html.includes('#11182b'));
  ok('design system: primary and destructive buttons styled distinctly', html.includes('.btn.primary{background:var(--hapa-primary)') && html.includes('.btn.bad{background:var(--hapa-surface);color:var(--hapa-danger)'));
  ok('owner stats: all dashboard keys have english labels', ['pendingGenericReports', 'openRequests', 'activeProfessionalProfiles', 'activeMerchantProfiles', 'activeDriverProfiles', 'reviews'].every(k => new RegExp(k + ":'[A-Z]").test(html)));
  ok('owner stats: listing vs user/content reports named distinctly', html.includes("pendingReports:'Pending listing reports'") && html.includes("pendingGenericReports:'Pending user & content reports'"));
  ok('owner stats: unknown keys humanized, never raw', html.includes('function ownerStatLabel(') && !html.includes('OWNER_STAT_LABELS[k]||k}'));
  ok('owner actions: suspend/reactivate labels, no block/unblock', html.includes('>Suspend account<') && html.includes('>Reactivate account<') && !html.includes('>Block<') && !html.includes('>Unblock<'));
  ok('owner actions: reject only shown for pending users', /u\.status==='pending'\?[\s\S]{0,220}Reject application/.test(html) && !/u\.status!=='rejected'/.test(html));
  ok('owner actions: confirmation modal replaces browser confirm', html.includes('function hapaConfirm(') && !html.includes("confirm('Are you sure you want to '"));
  ok('owner actions: suspension consequence explains history preserved', html.includes('verification history are preserved'));
  ok('activity tab: no future-release placeholder', !html.includes('future release') && html.includes('No additional activity recorded yet.'));
  ok('application view: KES price formatting helper', html.includes('function ugFieldValue(') && html.includes("'KES '+fmtNum"));
  ok('application view: county capitalized for display', /county\|town\|city/.test(html));
  ok('application view: open securely action for private docs', html.includes('ugOpenDocSecure') && html.includes('>Open securely<'));
  ok('help: no coming-soon placeholders anywhere', !/coming soon/i.test(html));
  ok('help: fallback when no support contact configured', html.includes('Direct support contact details are not configured yet.'));
  ok('theme-color matches header navy', html.includes('<meta name="theme-color" content="#101C2C">'));

  // ══ 10. RESPONSIVE LAYOUT & MOBILE NAVIGATION (static) ══
  ok('desktop container uses wider approved max-width', html.includes('.wrap{max-width:1360px'));
  ok('header spans full width with centered content', html.includes('calc(50% - 50vw)') && html.includes('max(18px,calc(50vw - 662px))'));
  ok('desktop nav hidden below 768px (no wrapped menu)', /@media\(max-width:767px\)\{\s*\.nav\{display:none\}/.test(html));
  ok('mobile bottom navigation exists with 5 sections', html.includes('id="bottomNav"') && ['bnavHome', 'bnavMarket', 'bnavRequests', 'bnavAccount', 'bnavMore'].every(id => html.includes(`id="${id}"`)));
  ok('mobile nav items have accessible labels', html.includes('aria-label="Main navigation"') && html.includes('aria-label="Marketplace"') && html.includes('aria-label="More options"'));
  ok('mobile nav touch targets >= 44px', html.includes('.bottom-nav button{') && html.includes('min-height:52px'));
  ok('mobile nav respects safe-area insets', html.includes('env(safe-area-inset-bottom') && html.includes('env(safe-area-inset-top'));
  ok('owner dashboard reachable via More sheet on mobile', html.includes("item('owner','🛡️','Owner dashboard')") && html.includes('moreSheetToggle'));
  ok('professional roles and help live under More', html.includes("item('upgrade','💼','Professional roles')") && html.includes("item('help','❓','Help & Support')"));
  ok('logout separated in More sheet, not in bottom nav', html.includes('ms-logout') && !/id="bottomNav"[\s\S]*?<\/nav>/.exec(html)[0].toLowerCase().includes('logout'));
  ok('marketplace tab strip scrolls without page overflow', /\.mp-subnav\{flex-wrap:nowrap;overflow-x:auto/.test(html) && html.includes('body{overflow-x:clip}'));
  ok('marketplace tabs keep >=44px height on mobile', /\.mp-tab\{flex:0 0 auto;min-height:44px/.test(html));
  ok('mobile search input goes full width at small widths', /\.mp-search-row input\{flex:1 1 100%\}/.test(html));
  ok('mobile inputs use 16px font (no zoom-jump)', html.includes('.mp-sort-select{font-size:16px}'));
  ok('confirmation modal fits mobile viewport', html.includes('.modal{max-width:calc(100vw - 32px)}'));
  ok('empty states use wider constrained card', html.includes('.mp-empty{text-align:center;padding:44px 24px;max-width:560px'));
  ok('bottom nav active state mirrors sections incl. More', html.includes("['upgrade','help','owner','rides']") && html.includes("bnavMore"));

  // ══ CLEANUP — deactivate synthetic users ══
  for (const u of [cust, stranger, merch, merch2, drv]) {
    await j('POST', '/api/me/deactivate', u.tok, { password: PW });
  }

  console.log(`\nTOTAL: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
