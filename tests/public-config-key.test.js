// Regression: /api/public/config must resolve the Google Maps web key
// through the central lib/maps source of truth.
// Proves: GOOGLE_MAPS_WEB_KEY returned as mapsBrowserKey; legacy
// GOOGLE_MAPS_BROWSER_KEY still works when the new key is absent; the new
// key wins when both are set; no key -> null; GOOGLE_MAPS_SERVER_KEY never
// appears; response carries no unrelated secrets.
// Runs its own short-lived servers on ephemeral ports (needs local Postgres,
// same as the other suites). Test values are obvious fakes, never real keys.
// Usage: node tests/public-config-key.test.js
const { spawn } = require('child_process');
const net = require('net');

// Allocate a safe ephemeral port from the OS instead of hardcoding one.
const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  s.on('error', rej);
});

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra !== undefined ? JSON.stringify(extra) : ''); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Unit level: the resolver itself (precedence logic lives in one place).
async function unitChecks() {
  const fresh = env => {
    for (const k of ['GOOGLE_MAPS_WEB_KEY', 'GOOGLE_MAPS_BROWSER_KEY']) delete process.env[k];
    Object.assign(process.env, env);
    delete require.cache[require.resolve('../lib/maps.js')];
    return require('../lib/maps.js').publicWebKey();
  };
  ok('unit: new key preferred', fresh({ GOOGLE_MAPS_WEB_KEY: 'FAKE-WEB', GOOGLE_MAPS_BROWSER_KEY: 'FAKE-LEGACY' }) === 'FAKE-WEB');
  ok('unit: legacy fallback', fresh({ GOOGLE_MAPS_BROWSER_KEY: 'FAKE-LEGACY' }) === 'FAKE-LEGACY');
  ok('unit: none -> null', fresh({}) === null);
  for (const k of ['GOOGLE_MAPS_WEB_KEY', 'GOOGLE_MAPS_BROWSER_KEY']) delete process.env[k];
}

// Integration level: the actual public endpoint on a booted server.
async function withServer(extraEnv, fn) {
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), PUBLIC_MEDIA_STORAGE_MODE: 'local', DOCUMENT_STORAGE_MODE: 'local', JWT_SECRET: 'hapa_local_dev_secret', OWNER_PASSWORD: 'LocalDev2024', OWNER_NAME: 'HAPA Owner' };
  delete env.GOOGLE_MAPS_WEB_KEY; delete env.GOOGLE_MAPS_BROWSER_KEY; delete env.GOOGLE_MAPS_SERVER_KEY;
  Object.assign(env, extraEnv);
  const p = spawn('node', ['server.js'], { env, stdio: 'ignore' });
  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) { await sleep(500); up = await fetch(`http://127.0.0.1:${port}/api/health`).then(r => r.ok).catch(() => false); }
    if (!up) throw new Error('server did not start on ' + port);
    await fn(`http://127.0.0.1:${port}`);
  } finally { p.kill(); await sleep(300); }
}
const cfg = async b => (await fetch(b + '/api/public/config')).json();

(async () => {
  await unitChecks();

  await withServer({ GOOGLE_MAPS_WEB_KEY: 'FAKE-WEB-KEY-1', GOOGLE_MAPS_BROWSER_KEY: 'FAKE-LEGACY-KEY-1', GOOGLE_MAPS_SERVER_KEY: 'FAKE-SERVER-KEY-1' }, async b => {
    const c = await cfg(b);
    ok('endpoint: GOOGLE_MAPS_WEB_KEY returned as mapsBrowserKey (wins over legacy)', c.mapsBrowserKey === 'FAKE-WEB-KEY-1', c);
    ok('endpoint: server key never returned', !JSON.stringify(c).includes('FAKE-SERVER-KEY-1'), c);
    const body = JSON.stringify(c);
    ok('endpoint: no unrelated secrets in public config', !/secret|password|jwt|token|s3|encryption/i.test(body), body);
  });

  await withServer({ GOOGLE_MAPS_BROWSER_KEY: 'FAKE-LEGACY-KEY-2', GOOGLE_MAPS_SERVER_KEY: 'FAKE-SERVER-KEY-2' }, async b => {
    const c = await cfg(b);
    ok('endpoint: legacy GOOGLE_MAPS_BROWSER_KEY still works alone', c.mapsBrowserKey === 'FAKE-LEGACY-KEY-2', c);
    ok('endpoint: server key never returned (legacy mode)', !JSON.stringify(c).includes('FAKE-SERVER-KEY-2'));
  });

  await withServer({}, async b => {
    const c = await cfg(b);
    ok('endpoint: no configured web key -> null', c.mapsBrowserKey === null, c);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('SUITE ERROR', e); process.exit(1); });
