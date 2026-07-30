// Frontend unit tests: authenticated editor media loading (public/index.html)
// Extracts the ppImgAttr / ppHydrateAuthImgs / ppRevokeBlobUrls helpers from the
// real page source and runs them against a stubbed DOM + fetch.
// Usage: node tests/frontend-auth-media.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const start = html.indexOf('const PP_OWNER_MEDIA_PREFIX');
const end = html.indexOf('// Shared public profile card renderer', start);
if (start < 0 || end < 0) { console.error('helper block not found in index.html'); process.exit(1); }
const helperSrc = html.slice(start, end);

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('PASS', n); } else { fail++; console.log('FAIL', n, x !== undefined ? JSON.stringify(x) : ''); } };

class FakeImg {
  constructor(authSrc) { this.attrs = { 'data-auth-src': authSrc }; this.style = {}; this.src = undefined; }
  getAttribute(k) { return this.attrs[k]; }
  removeAttribute(k) { if (k === 'src') this.src = undefined; delete this.attrs[k]; }
}

(async () => {
  const fetchLog = [];
  let created = 0, revoked = [];
  const ctx = {
    console,
    esc: s => String(s),
    token: 'TESTJWT123',
    ppProfilePhoto: null,
    ppPortfolio: [],
    _imgs: [],
    document: { querySelectorAll: () => ctx._imgs },
    URL: {
      createObjectURL: () => 'blob:fake-' + (++created),
      revokeObjectURL: u => revoked.push(u),
    },
    fetch: async (url, opts) => {
      fetchLog.push({ url, auth: opts && opts.headers && opts.headers.Authorization });
      if (url.includes('fail')) return { ok: false, status: 401 };
      return { ok: true, blob: async () => ({}) };
    },
  };
  vm.createContext(ctx);
  vm.runInContext(helperSrc, ctx);

  // 1. owner media rendered via data-auth-src (never a plain src with the token)
  const attr = ctx.ppImgAttr('/api/me/professional-profile/media/abc');
  ok('owner url rendered as data-auth-src', attr.startsWith('data-auth-src='), attr);
  ok('no token inserted into any URL/attribute', !attr.includes('TESTJWT123'));

  // 2. public urls keep normal src (no auth logic)
  const pub = ctx.ppImgAttr('/api/public/professional-media/xyz');
  ok('public url keeps plain src', pub.startsWith('src='), pub);

  // 3. hydration fetches with Authorization header and assigns blob object URL
  const img = new FakeImg('/api/me/professional-profile/media/abc');
  ctx._imgs = [img];
  ctx.ppPortfolio = [{ url: '/api/me/professional-profile/media/abc' }];
  await ctx.ppHydrateAuthImgs();
  ok('fetched with Authorization header', fetchLog.length === 1 && fetchLog[0].auth === 'Bearer TESTJWT123', fetchLog);
  ok('blob assigned through object URL', String(img.src).startsWith('blob:'), img.src);
  ok('token not in fetched URL', !fetchLog[0].url.includes('TESTJWT123'));

  // 4. rerender reuses cache; replaced/removed media gets revoked
  const img2 = new FakeImg('/api/me/professional-profile/media/abc');
  ctx._imgs = [img2];
  await ctx.ppHydrateAuthImgs();
  ok('rerender reuses cached object URL (no extra fetch)', fetchLog.length === 1 && img2.src === img.src);
  const img3 = new FakeImg('/api/me/professional-profile/media/replacement');
  ctx._imgs = [img3];
  ctx.ppPortfolio = [{ url: '/api/me/professional-profile/media/replacement' }]; // old image replaced
  await ctx.ppHydrateAuthImgs();
  ok('old object URL revoked on replacement', revoked.includes(img.src), revoked);
  ok('new image got its own object URL', String(img3.src).startsWith('blob:') && img3.src !== img.src);

  // 5. failed authenticated request -> placeholder fallback, no src, no retry loop
  const bad = new FakeImg('/api/me/professional-profile/media/fail-1');
  ctx._imgs = [bad];
  const fetchesBefore = fetchLog.length;
  await ctx.ppHydrateAuthImgs();
  ok('failed fetch shows fallback (no src set)', bad.src === undefined && bad.style.opacity === '.35');
  ok('single attempt, no retry loop', fetchLog.length === fetchesBefore + 1);
  ok('no backend error details exposed on element', !JSON.stringify(bad.attrs).includes('401'));

  // 6. explicit revoke-all (leave editor / logout)
  ctx.ppPortfolio = []; ctx.ppProfilePhoto = null;
  ctx.ppRevokeBlobUrls();
  ok('all object URLs revoked on leave/logout', revoked.includes(img3.src));

  console.log('\nTOTAL pass=' + pass + ' fail=' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
