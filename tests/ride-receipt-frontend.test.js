// Frontend unit tests: ride receipt modal (public/index.html).
// Extracts the real receipt module and runs it against a stubbed DOM +
// fetch/share/clipboard to prove: modal instead of alert, correct ride id,
// KES formatting, escaping, loading/duplicate guards, PDF download/share,
// focus trap + restore, scroll lock cleanup, and instant history behavior.
// Usage: node tests/ride-receipt-frontend.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const start = html.indexOf('// ── Ride receipt module');
const end = html.indexOf('// ── end ride receipt module');
if (start < 0 || end < 0) { console.error('receipt module block not found'); process.exit(1); }
const src = html.slice(start, end);

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('PASS', n); } else { fail++; console.log('FAIL', n, x !== undefined ? JSON.stringify(x) : ''); } };
const tick = () => new Promise(r => setImmediate(r));

// ── Minimal DOM ──
const registry = {};
let activeElement = null;
class FakeEl {
  constructor(id, tag) {
    this.id = id || ''; this.tagName = (tag || 'div').toUpperCase();
    this.textContent = ''; this.disabled = false; this.className = '';
    this.style = { cssText: '' }; this.attrs = {}; this.handlers = {}; this._innerHTML = '';
    this._children = []; this.parentNode = null; this.href = ''; this.download = ''; this.clicked = 0;
  }
  get innerHTML() { return this._innerHTML; }
  set innerHTML(h) {
    for (const cid of this._childIds || []) { if (activeElement === registry[cid]) activeElement = null; delete registry[cid]; }
    this._innerHTML = h; this._childIds = [];
    const re = /id="([^"]+)"/g; let m;
    while ((m = re.exec(h))) { const el = new FakeEl(m[1]); el.parentNode = this; registry[m[1]] = el; this._childIds.push(m[1]); }
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  addEventListener(t, fn) { (this.handlers[t] = this.handlers[t] || []).push(fn); }
  fire(t, ev = {}) { (this.handlers[t] || []).forEach(fn => fn({ preventDefault() { ev.prevented = true; }, target: ev.target || this, ...ev })); return ev; }
  appendChild(el) { el.parentNode = this; this._children.push(el); if (el.id) registry[el.id] = el; return el; }
  removeChild(el) { this._children = this._children.filter(c => c !== el); }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
    for (const cid of this._childIds || []) { if (activeElement === registry[cid]) activeElement = null; delete registry[cid]; }
    if (this.id) delete registry[this.id];
  }
  querySelector(sel) {
    const cls = sel.replace('.', '');
    return this._children.find(c => c.className === cls) || null;
  }
  focus() { activeElement = this; }
  click() { this.clicked++; this.fire('click'); }
}

const docHandlers = {};
const body = new FakeEl('', 'body');
const fetchLog = [];
let fetchStatus = 200;
const shareLog = []; const clipLog = [];
let shareBehavior = 'files'; // 'files' | 'text' | 'none' | 'abort'

const ctx = {
  console,
  esc: s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
  $: id => registry[id] || null,
  token: 'TESTJWT',
  rdState: { rideId: 'active-ride-1' },
  Intl, Blob, setTimeout, clearTimeout,
  document: {
    createElement: tag => new FakeEl('', tag),
    body,
    get activeElement() { return activeElement; },
    addEventListener: (t, fn) => { (docHandlers[t] = docHandlers[t] || []).push(fn); },
    removeEventListener: (t, fn) => { docHandlers[t] = (docHandlers[t] || []).filter(f => f !== fn); },
  },
  api: async p => { fetchLog.push({ p, kind: 'api' }); await tick(); if (fetchStatus !== 200) throw new Error('Receipt unavailable'); return ctx.__receipt; },
  fetch: async (p, opts) => {
    fetchLog.push({ p, kind: 'fetch', auth: opts && opts.headers && opts.headers.Authorization });
    await tick();
    return { ok: fetchStatus === 200, blob: async () => ({ pdf: true, size: 999, type: 'application/pdf' }) };
  },
  URL: { createObjectURL: () => 'blob:receipt', revokeObjectURL: () => {} },
  File: class { constructor(parts, name, o) { this.name = name; this.type = o && o.type; } },
  navigator: {
    canShare: arg => shareBehavior === 'files' ? true : false,
    share: async arg => {
      if (shareBehavior === 'abort') { const e = new Error('cancel'); e.name = 'AbortError'; throw e; }
      if (shareBehavior === 'none') throw new Error('unsupported');
      shareLog.push(arg); return;
    },
    clipboard: { writeText: async t => { clipLog.push(t); } },
  },
  alert: () => { ctx.__alerted = true; },
  __alerted: false,
  __receipt: null,
};
vm.createContext(ctx);
vm.runInContext(src, ctx);
const G = vm.runInContext('({rdReceipt,rcptOpen,rcptClose,rcptState,kesFmt,nrbDate,rcptDownload,rcptShare,rcptFileName})', ctx);
const fireDoc = (t, ev = {}) => { (docHandlers[t] || []).forEach(fn => fn({ preventDefault() { ev.prevented = true; }, ...ev })); return ev; };

const RECEIPT = {
  reference: 'HAPA-TEST-A1', created_at: '2026-07-31T08:00:00Z',
  body: {
    datetime: '2026-07-31T08:05:00Z', pickup: 'Embu CBD <b>x</b>', destination: 'Kangaru',
    driver: 'Peter "PK" <script>alert(1)</script>', vehicle: 'Toyota Vitz', registration: 'KDA 123X',
    distance_m: 4922, duration_s: 591,
    components: { base_fare: 100, booking_fee: 20, distance_charge: 196.88, time_charge: 49.25, waiting_charge: 0, commission_pct: 15, minimum_fare: 150, final_total: 1366.13 },
    total: 1366.13, payment_method: 'cash', payment_ref: null,
    commission: 204.92, driver_earnings: 1161.21, payment_mode: 'cash',
  },
};

(async () => {
  // ── 1. Loading, correct ride id, modal opens (no alert)
  ctx.__receipt = RECEIPT;
  const btn = new FakeEl('histBtn', 'button'); const wrap = new FakeEl('wrap'); wrap.appendChild(btn);
  btn.textContent = 'Receipt'; btn.focus();
  const p = G.rdReceipt('ride-77', btn);
  ok('button disabled with loading label', btn.disabled === true && btn.textContent === 'Loading receipt…');
  const pDup = G.rdReceipt('ride-77', btn); await p; await pDup; await tick();
  ok('duplicate request prevented while loading', fetchLog.filter(f => f.kind === 'api').length === 1, fetchLog);
  ok('correct ride id requested', fetchLog[0].p === '/api/rides/ride-77/receipt');
  ok('modal opened instead of alert', !!registry.rcptOverlay && !!registry.rcptDialog && ctx.__alerted === false);
  ok('button restored after load', btn.disabled === false && btn.textContent === 'Receipt');

  const dlg = registry.rcptDialog.parentNode; // overlay holds dialog markup
  const htmlOut = registry.rcptOverlay.innerHTML;
  ok('dialog is accessible (role/aria-modal/label)', /role="dialog"/.test(htmlOut) && /aria-modal="true"/.test(htmlOut) && /aria-labelledby="rcptTitle"/.test(htmlOut));
  ok('receipt shows reference, route, driver, vehicle, payment', ['HAPA-TEST-A1', 'Kangaru', 'Toyota Vitz', 'KDA 123X', 'Cash'].every(s => htmlOut.includes(s)));
  ok('KES totals use thousands separator + 2 decimals', htmlOut.includes('KES 1,366.13') && htmlOut.includes('KES 196.88') && htmlOut.includes('KES 100.00'));
  ok('server text is escaped (no raw script/HTML)', !htmlOut.includes('<script>') && htmlOut.includes('&lt;script&gt;') && htmlOut.includes('&lt;b&gt;'));
  ok('internal accounting never rendered', !/commission|earnings|204\.92|1,161\.21|payment_mode/i.test(htmlOut));
  ok('zero waiting charge hidden', !htmlOut.includes('Waiting charge'));
  ok('PAID conveyed with text, not colour alone', htmlOut.includes('PAID'));
  ok('body scroll locked while open', body.style.overflow === 'hidden');
  ok('focus moved into the modal', activeElement === registry.rcptCloseBtn);

  // ── 2. Focus trap cycles and stays inside
  fireDoc('keydown', { key: 'Tab' });
  const inTrap1 = ['rcptX', 'rcptShareBtn', 'rcptDlBtn', 'rcptCloseBtn'].includes(activeElement && activeElement.id);
  fireDoc('keydown', { key: 'Tab', shiftKey: true }); fireDoc('keydown', { key: 'Tab', shiftKey: true });
  const inTrap2 = ['rcptX', 'rcptShareBtn', 'rcptDlBtn', 'rcptCloseBtn'].includes(activeElement && activeElement.id);
  ok('Tab/Shift+Tab trapped inside modal', inTrap1 && inTrap2, activeElement && activeElement.id);

  // ── 3. Download uses authenticated PDF endpoint + correct filename
  await G.rcptDownload(); await tick();
  const pdfCall = fetchLog.find(f => f.kind === 'fetch');
  ok('download hits authenticated PDF endpoint', pdfCall && pdfCall.p === '/api/rides/ride-77/receipt.pdf' && pdfCall.auth === 'Bearer TESTJWT', pdfCall);
  ok('download filename is sanitized HAPA name', G.rcptFileName() === 'HAPA-Receipt-HAPA-TEST-A1.pdf');
  ok('download success feedback inside modal', registry.rcptStatus.textContent === 'Receipt downloaded.');

  // ── 4. Share: native file share; cancellation silent; clipboard fallback
  shareBehavior = 'files';
  await G.rcptShare(); await tick();
  ok('native PDF file share used when supported', shareLog.length === 1 && shareLog[0].files && shareLog[0].files[0].name.endsWith('.pdf'), shareLog);
  registry.rcptStatus.textContent = '';
  shareBehavior = 'abort';
  await G.rcptShare(); await tick();
  ok('share cancellation shows no error', registry.rcptStatus.textContent === '');
  shareBehavior = 'none'; ctx.navigator.canShare = undefined; ctx.navigator.share = undefined;
  await G.rcptShare(); await tick();
  ok('clipboard fallback copies text receipt', clipLog.length === 1 && clipLog[0].includes('HAPA-TEST-A1') && clipLog[0].includes('KES 1,366.13'), clipLog);
  ok('clipboard text has no internal fields', !/commission|earnings/i.test(clipLog[0]));

  // ── 5. Close paths: Escape restores focus + scroll
  fireDoc('keydown', { key: 'Escape' });
  ok('Escape closes the modal', !registry.rcptOverlay);
  ok('body scrolling restored', body.style.overflow === '');
  ok('focus restored to original Receipt button', activeElement === btn);
  ok('key handler removed after close', (docHandlers.keydown || []).length === 0);

  // Backdrop + Close button
  G.rcptOpen('ride-77', RECEIPT, btn);
  registry.rcptOverlay.fire('click', { target: registry.rcptOverlay });
  ok('backdrop click closes', !registry.rcptOverlay);
  G.rcptOpen('ride-77', RECEIPT, btn);
  registry.rcptCloseBtn.click();
  ok('Close button closes', !registry.rcptOverlay);
  G.rcptOpen('ride-77', RECEIPT, btn);
  registry.rcptX.click();
  ok('X button closes and no stale state remains', !registry.rcptOverlay && G.rcptState.data === null && (docHandlers.keydown || []).length === 0);

  // ── 6. Failed load: inline notice, no modal, button restored
  fetchStatus = 500;
  await G.rdReceipt('ride-99', btn); await tick();
  ok('API failure shows inline notice (no alert)', wrap.querySelector('.rcpt-notice') && wrap.querySelector('.rcpt-notice').textContent.length > 0 && ctx.__alerted === false);
  ok('failure leaves no modal and restores button', !registry.rcptOverlay && btn.disabled === false);

  // ── 7. Formatting helpers
  ok('kesFmt: two decimals + separators', G.kesFmt(346.125) === 'KES 346.13' && G.kesFmt(1000) === 'KES 1,000.00' && G.kesFmt(0) === 'KES 0.00');
  ok('nrbDate renders Africa/Nairobi (EAT)', /EAT$/.test(G.nrbDate('2026-07-31T08:05:00Z')) && G.nrbDate('2026-07-31T08:05:00Z').includes('11:05'));

  // ── 8. Static source checks: instant history + integration wiring
  ok('terminal ride triggers immediate history refresh (guarded)', /histSyncedFor!==r\.ride\.id\)\{rdState\.histSyncedFor=r\.ride\.id;rdLoadHistory\(\);\}/.test(html));
  ok('terminal card kept visible (no auto-dismiss)', !/includes\(r\.ride\.status\)\)\{rdClearRide/.test(html));
  ok('history sorts by completed_at fallback created_at', html.includes('new Date(b.completed_at||b.created_at)-new Date(a.completed_at||a.created_at)'));
  ok('history shows Receipt only for closed rides', /r\.status==='closed'\?`<br><button[^`]*rdReceipt\('\$\{esc\(r\.id\)\}',this\)/.test(html));
  ok('history uses Nairobi dates + 2dp fares', html.includes('nrbDate(r.completed_at||r.created_at,true)') && html.includes('kesFmt(r.final_fare)'));
  ok('active card Receipt passes explicit ride id + button', html.includes(`rdReceipt(rdState.rideId,this)`));
  ok('no receipt alert remains anywhere', !/alert\(`HAPA Receipt/.test(html));
  ok('chat draft logic untouched by receipt work', html.includes('rideChat.drafts[rideId]=inp.value'));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
