#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// HAPA canonical test runner.
//
//   npm run test:syntax       — node --check on all runtime JS
//   npm run test:static       — static/frontend suites (no PostgreSQL)
//   npm run test:integration  — server suites on a DISPOSABLE test database
//   npm test                  — syntax + static + integration (everything)
//
// Optional filter (integration/static): --only=maps-gps,ride-hailing
//
// Safety model (fail closed):
//   • Integration suites NEVER run against the normal DATABASE_URL. The runner
//     creates a brand-new `hapa_test_<stamp>` database on a proven-local
//     PostgreSQL host, points the test servers at it, and drops it afterwards.
//   • Only clearly local hosts are accepted (localhost/127.0.0.1/::1/helium).
//     Staging, production, and unknown remote hosts are rejected.
//   • All credentials used are synthetic (see SYNTH below); no secret values
//     are ever printed.
//   • Every tests/*.test.js must be classified in the manifest below — an
//     unlisted file fails the run so new suites cannot be silently skipped.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');

// ── Test manifest ── every committed tests/*.test.js must appear exactly once.
const STATIC = [ // read files / spawn nothing that needs PostgreSQL
  'frontend-auth-media',
  'maps-frontend-races',
  'ride-chat-frontend',
  'ride-receipt-frontend',
];
const INTEGRATION = [ // need the shared test server + test database
  'driver-finance',
  'fare-quote',
  'finance-hardening',
  'geo-scale',
  'launch-readiness',
  'maps-gps',
  'mvp-modules',
  'professional-public-profile',
  'ride-gates',
  'ride-hailing',
  'ride-history-persistence',
  'ride-ops-accounting',
  'ride-receipt-pdf',
  'statement-quality',
];
const SELF_MANAGED = [ // boot their own servers; need only the test DATABASE_URL
  'public-config-key',
];

// Synthetic values only — never real credentials.
const SYNTH = {
  JWT_SECRET: 'hapa_ci_synthetic_jwt_secret',
  SESSION_SECRET: 'hapa_ci_synthetic_session_secret',
  OWNER_PASSWORD: 'CiTestOwner2026!',
  OWNER_EMAIL: 'trader2027@protonmail.com', // fixed owner identity enforced by server.js
};

const MODES = ['syntax', 'static', 'integration', 'all'];
const only = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const mode = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'all';
const pick = list => (only.length ? list.filter(s => only.includes(s)) : list);
function validateArgs() { // fail closed on bad invocations
  if (!MODES.includes(mode)) {
    console.error(`FATAL: unknown mode "${mode}" (valid: ${MODES.join(', ')})`);
    return false;
  }
  const known = new Set([...STATIC, ...INTEGRATION, ...SELF_MANAGED]);
  const bad = only.filter(s => !known.has(s));
  if (bad.length) {
    console.error(`FATAL: unknown --only suite name(s): ${bad.join(', ')}`);
    return false;
  }
  if (only.length) {
    const selectable = mode === 'static' ? STATIC : mode === 'integration' ? [...INTEGRATION, ...SELF_MANAGED] : [...STATIC, ...INTEGRATION, ...SELF_MANAGED];
    if (!selectable.some(s => only.includes(s))) {
      console.error(`FATAL: --only selection matches zero suites runnable in mode "${mode}"`);
      return false;
    }
  }
  return true;
}

const children = new Set();
let activeDb = null; // disposable DB currently in use (dropped on any exit path)
function track(p) { children.add(p); p.on('exit', () => children.delete(p)); return p; }

// Verified child-process teardown: SIGTERM every tracked process, wait for
// real exit (bounded), escalate to SIGKILL for stragglers, wait again, and
// report whether the tracked set actually drained. Incomplete cleanup = false.
async function killAllAndWait() {
  const waitDrained = async (ms) => {
    const deadline = Date.now() + ms;
    while (children.size && Date.now() < deadline) await sleep(100);
    return children.size === 0;
  };
  for (const p of children) { try { p.kill('SIGTERM'); } catch {} }
  if (await waitDrained(5000)) return true;
  for (const p of children) { try { p.kill('SIGKILL'); } catch {} }
  if (await waitDrained(3000)) return true;
  console.error(`[cleanup] FAILED: ${children.size} tracked child process(es) still alive`);
  return false;
}
function killAllSync() { for (const p of children) { try { p.kill('SIGKILL'); } catch {} } }
process.on('exit', killAllSync); // last-resort; normal paths use killAllAndWait

let interrupting = false;
async function onSignal(code) {
  if (interrupting) return; // second signal: let 'exit' SIGKILL handle it
  interrupting = true;
  console.error('\n[signal] interrupted — cleaning up child processes and test database…');
  const procsOk = await killAllAndWait();
  const dbOk = await dropTestDb(activeDb);
  activeDb = null;
  console.error(`[signal] cleanup ${procsOk && dbOk ? 'complete' : 'INCOMPLETE'}`);
  process.exit(code);
}
process.on('SIGINT', () => { onSignal(130); });
process.on('SIGTERM', () => { onSignal(143); });

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
    s.on('error', rej);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Database safety guard ──
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'helium']);
function guardAdminUrl(raw) {
  if (!raw) throw new Error('DATABASE_URL is not set — cannot allocate a test database');
  const u = new URL(raw);
  const host = u.hostname;
  if (/onrender|render\.com|neon\.tech|amazonaws|azure|supabase|rds\./i.test(raw))
    throw new Error(`refusing test run: database host "${host}" looks remote/managed`);
  if (!LOCAL_HOSTS.has(host))
    throw new Error(`refusing test run: database host "${host}" is not a known local host (${[...LOCAL_HOSTS].join(', ')})`);
  return u;
}

async function createTestDb() {
  const { Client } = require(path.join(ROOT, 'node_modules', 'pg'));
  const admin = guardAdminUrl(process.env.DATABASE_URL);
  const name = 'hapa_test_' + Date.now().toString(36) + '_' + process.pid;
  const c = new Client({ connectionString: admin.href });
  await c.connect();
  await c.query(`CREATE DATABASE ${name}`); // name is runner-generated, safe
  await c.end();
  const test = new URL(admin.href);
  test.pathname = '/' + name;
  console.log(`[db] created disposable database ${name} on ${admin.hostname}`);
  return { name, url: test.href, adminUrl: admin.href };
}

async function dropTestDb(db) {
  if (!db) return true;
  try {
    const { Client } = require(path.join(ROOT, 'node_modules', 'pg'));
    const c = new Client({ connectionString: db.adminUrl });
    await c.connect();
    await c.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, [db.name]);
    await c.query(`DROP DATABASE IF EXISTS ${db.name}`);
    await c.end();
    console.log(`[db] dropped ${db.name}`);
    return true;
  } catch (e) { console.error(`[db] CLEANUP FAILED for ${db.name}: ${e.message}`); return false; }
}

function serverEnv(dbUrl, port, extra = {}) {
  return {
    ...process.env,
    DATABASE_URL: dbUrl,
    PORT: String(port),
    NODE_ENV: 'development',
    JWT_SECRET: SYNTH.JWT_SECRET,
    SESSION_SECRET: SYNTH.SESSION_SECRET,
    OWNER_PASSWORD: SYNTH.OWNER_PASSWORD,
    OWNER_NAME: 'HAPA Owner',
    PUBLIC_MEDIA_STORAGE_MODE: 'local',
    DOCUMENT_STORAGE_MODE: 'local',
    // Fixture/behaviour flags the suites depend on (test-only semantics):
    MAPS_ALLOW_CLIENT_DISTANCE: 'true',
    LOC_MIN_INTERVAL_MS: '0',
    COMMISSION_RESERVE_ENABLED: 'true',
    COMMISSION_RESERVE_LEGAL_APPROVED: 'true',
    FINANCE_FAULT_INJECT_DRIVER: 'domain:fault-inject.test',
    ...extra,
  };
}

async function bootServer(dbUrl, port, extra) {
  const p = track(spawn('node', ['server.js'], { cwd: ROOT, env: serverEnv(dbUrl, port, extra), stdio: ['ignore', 'pipe', 'pipe'] }));
  let log = '';
  p.stdout.on('data', d => { log += d; });
  p.stderr.on('data', d => { log += d; });
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    if (p.exitCode !== null) throw new Error(`server exited early (code ${p.exitCode})\n${log.slice(-2000)}`);
    const up = await fetch(`http://127.0.0.1:${port}/api/health`).then(r => r.ok).catch(() => false);
    if (up) return p;
  }
  throw new Error(`server did not become healthy on port ${port}\n${log.slice(-2000)}`);
}

async function betweenSuiteCleanup(dbUrl) {
  const { Client } = require(path.join(ROOT, 'node_modules', 'pg'));
  const c = new Client({ connectionString: dbUrl });
  await c.connect();
  await c.query(`UPDATE driver_availability_sessions SET status='ended',ended_at=NOW() WHERE status IN('online','paused')`).catch(() => {});
  await c.query(`UPDATE ride_offers SET status='expired',responded_at=NOW() WHERE status='pending'`).catch(() => {});
  await c.end();
}

// Seed the documented local fixtures some suites expect
// (professional-public-profile): an approved professional and a plain
// customer. All values are synthetic and live only in the disposable DB.
async function seedFixtures(base) {
  const jj = async (m, p, t, b) => {
    const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: b ? JSON.stringify(b) : undefined });
    return { s: r.status, d: await r.json().catch(() => ({})) };
  };
  const owner = (await jj('POST', '/api/auth/login', null, { identifier: SYNTH.OWNER_EMAIL, password: SYNTH.OWNER_PASSWORD })).d.token;
  if (!owner) throw new Error('fixture seeding: owner login failed');
  const mk = async (email, name) => {
    const reg = await jj('POST', '/api/auth/register', null, { name, email, password: 'Fixture2026!', selfie: 'data:image/png;base64,iVBORw0KGgo=' });
    if (reg.s !== 201) throw new Error(`fixture seeding: register ${email} -> ${reg.s}`);
    const acc = (await jj('GET', '/api/owner/access', owner)).d.find(a => a.user_id === reg.d.user.id && a.status === 'pending');
    if (acc) await jj('PATCH', '/api/owner/access/' + acc.id, owner, { status: 'approved' });
    return reg.d.user.id;
  };
  const proId = await mk('fixture.professional@example.com', 'Fixture Professional');
  await mk('fixture.merchant@example.com', 'Fixture Merchant');
  const pro = (await jj('POST', '/api/auth/login', null, { identifier: 'fixture.professional@example.com', password: 'Fixture2026!' })).d.token;
  const sub = await jj('POST', '/api/me/upgrades/professional/submit', pro, { details: { fullName: 'Fixture Professional', professionCategory: 'Electrician', skills: 'Wiring, installations', county: 'Embu' }, consent: true });
  if (sub.s >= 400) throw new Error('fixture seeding: professional submit failed ' + JSON.stringify(sub.d));
  const app = (await jj('GET', '/api/owner/upgrades?type=professional', owner)).d.find(a => a.user_id === proId && a.status === 'pending');
  if (!app) throw new Error('fixture seeding: pending professional application not found');
  await jj('PATCH', '/api/owner/upgrades/' + app.id + '/status', owner, { status: 'approved' });
  // The profile suite expects the fixture professional to already have a
  // profile (GET returns 200 {profile:null} when absent, which the suite
  // does not treat as "create one").
  const pro2 = (await jj('POST', '/api/auth/login', null, { identifier: 'fixture.professional@example.com', password: 'Fixture2026!' })).d.token;
  const prof = await jj('POST', '/api/me/professional-profile', pro2);
  if (prof.s !== 201) throw new Error('fixture seeding: profile create failed ' + JSON.stringify(prof.d));
  console.log('[fixtures] seeded approved professional (with profile) + customer fixtures');
}

function runSuite(name, args, env) {
  return new Promise(res => {
    const t0 = Date.now();
    const p = track(spawn('node', [`tests/${name}.test.js`, ...args], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] }));
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { out += d; });
    p.on('exit', code => res({ name, code, secs: ((Date.now() - t0) / 1000).toFixed(1), out }));
  });
}

function report(results, extras, t0) {
  const failed = results.filter(r => r.code !== 0);
  console.log('\n──────────── SUMMARY ────────────');
  for (const r of results) {
    const counts = (r.out.match(/(\d+) passed, (\d+) failed|TOTAL[:\s]*(?:pass[= ]*)?(\d+)[, ]+(?:failed?|fail)[= ]*(\d+)/i) || [])[0] || '';
    console.log(`${r.code === 0 ? 'PASS' : 'FAIL'}  ${r.name.padEnd(32)} ${r.secs}s  ${counts}`);
  }
  for (const [k, v] of Object.entries(extras)) console.log(`${v ? 'OK  ' : 'FAIL'}  ${k}`);
  console.log(`suites run: ${results.length}, failed: ${failed.length}, elapsed: ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  if (failed.length) {
    const f = failed[0];
    console.log(`first failing suite: ${f.name}  (rerun: node tests/${f.name}.test.js <baseUrl>)`);
    console.log('--- failing output (tail) ---\n' + f.out.split('\n').filter(l => /FAIL|ERROR|Error/.test(l)).slice(0, 20).join('\n'));
  }
  return failed.length === 0 && Object.values(extras).every(Boolean);
}

function checkManifest() {
  const files = fs.readdirSync(path.join(ROOT, 'tests')).filter(f => f.endsWith('.test.js')).map(f => f.replace(/\.test\.js$/, ''));
  const listed = new Set([...STATIC, ...INTEGRATION, ...SELF_MANAGED]);
  const unlisted = files.filter(f => !listed.has(f));
  const missing = [...listed].filter(f => !files.includes(f));
  if (unlisted.length) { console.error(`FATAL: test files not classified in scripts/test/run.js manifest: ${unlisted.join(', ')}`); return false; }
  if (missing.length) { console.error(`FATAL: manifest lists missing test files: ${missing.join(', ')}`); return false; }
  return true;
}

function syntaxCheck() {
  const targets = ['server.js', ...['lib', 'routes', 'scripts', 'tests'].flatMap(function walk(d) {
    const dir = path.join(ROOT, d);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : (e.name.endsWith('.js') ? [path.join(d, e.name)] : []));
  }), 'public/sw.js'];
  let ok = true;
  for (const f of targets) {
    try { execFileSync('node', ['--check', f], { cwd: ROOT }); }
    catch (e) { ok = false; console.error(`SYNTAX FAIL ${f}\n${e.stderr}`); }
  }
  console.log(`syntax: ${targets.length} files checked${ok ? ', all clean' : ''}`);
  return ok;
}

async function runStatic(t0, results) {
  for (const s of pick(STATIC)) results.push(await runSuite(s, [], { ...process.env }));
}

async function runIntegration(t0, results) {
  let db = null, cleanupOk = true;
  try {
    db = activeDb = await createTestDb();
    const [port, faultPort] = [await freePort(), await freePort()];
    const base = `http://127.0.0.1:${port}`;
    console.log(`[server] booting main test server (port ${port}) + fault-injected server (port ${faultPort})`);
    await bootServer(db.url, port);
    await bootServer(db.url, faultPort, { MAPS_FAULT_INJECT: 'route:timeout' });
    await seedFixtures(base);
    const env = {
      ...process.env,
      // Suites that verify DB state directly (e.g. finance backdating) must
      // hit the SAME disposable database as the test servers — never the
      // normal development database.
      DATABASE_URL: db.url,
      TEST_OWNER_EMAIL: SYNTH.OWNER_EMAIL,
      TEST_OWNER_PASSWORD: SYNTH.OWNER_PASSWORD,
      FAULT_B: `http://127.0.0.1:${faultPort}`,
    };
    for (const s of pick(INTEGRATION)) {
      await betweenSuiteCleanup(db.url);
      const r = await runSuite(s, [base], env);
      console.log(`[suite] ${r.code === 0 ? 'pass' : 'FAIL'} ${s} (${r.secs}s)`);
      results.push(r);
    }
    for (const s of pick(SELF_MANAGED)) {
      const r = await runSuite(s, [], { ...env, DATABASE_URL: db.url });
      console.log(`[suite] ${r.code === 0 ? 'pass' : 'FAIL'} ${s} (${r.secs}s)`);
      results.push(r);
    }
  } finally {
    const procsOk = await killAllAndWait();
    const dbOk = await dropTestDb(db);
    activeDb = null;
    cleanupOk = procsOk && dbOk; // incomplete process cleanup fails the run
  }
  return cleanupOk;
}

(async () => {
  const t0 = Date.now();
  const results = [];
  const extras = {};
  if (!validateArgs()) process.exit(1);
  extras['manifest complete (all tests/*.test.js classified)'] = checkManifest();
  if (!extras['manifest complete (all tests/*.test.js classified)']) { report(results, extras, t0); process.exit(1); }

  if (mode === 'syntax') { process.exit(syntaxCheck() ? 0 : 1); }
  if (mode === 'all') extras['syntax check'] = syntaxCheck();
  if (mode === 'static' || mode === 'all') await runStatic(t0, results);
  let cleanupOk = true;
  if (mode === 'integration' || mode === 'all') cleanupOk = await runIntegration(t0, results);
  extras['test database cleanup'] = cleanupOk;
  if (results.length === 0) { // a test run that ran no suites is a failure
    console.error('FATAL: no suites were executed for this selection');
    extras['at least one suite executed'] = false;
  }
  const ok = report(results, extras, t0);
  process.exit(ok ? 0 : 1);
})().catch(async e => {
  console.error('RUNNER ERROR:', e.message);
  const procsOk = await killAllAndWait();
  const dbOk = await dropTestDb(activeDb);
  activeDb = null;
  if (!procsOk || !dbOk) console.error('RUNNER ERROR cleanup INCOMPLETE');
  process.exit(1);
});
