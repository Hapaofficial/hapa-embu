// Frontend unit tests: draft-preserving ride chat widget (public/index.html).
// Extracts the real chat widget block and runs it against a stubbed DOM +
// fetch to prove the composer survives realtime re-renders: drafts, focus,
// caret, no duplicate sends, per-ride draft isolation, cleanup on completion.
// Usage: node tests/ride-chat-frontend.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const start = html.indexOf('// ── Ride chat widget');
const end = html.indexOf('// ── end ride chat widget');
if (start < 0 || end < 0) { console.error('chat widget block not found in index.html'); process.exit(1); }
const src = html.slice(start, end);

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('PASS', n); } else { fail++; console.log('FAIL', n, x !== undefined ? JSON.stringify(x) : ''); } };
const tick = () => new Promise(r => setImmediate(r));

// ── Minimal DOM: innerHTML assignment registers elements found by id ──
const registry = {};
let activeElement = null;
class FakeEl {
  constructor(id) {
    this.id = id; this._value = ''; this.textContent = ''; this.disabled = false;
    this.selectionStart = 0; this.selectionEnd = 0; this.scrollTop = 0; this.scrollHeight = 42;
    this.attrs = {}; this.handlers = {}; this._innerHTML = '';
  }
  get value() { return this._value; }
  set value(v) { this._value = String(v); }
  get innerHTML() { return this._innerHTML; }
  set innerHTML(h) {
    // Children created by a previous innerHTML of this element are destroyed.
    for (const cid of this._childIds || []) { if (registry[cid] === undefined) continue; if (activeElement === registry[cid]) activeElement = null; delete registry[cid]; }
    this._innerHTML = h; this._childIds = [];
    const re = /id="([^"]+)"/g; let m;
    while ((m = re.exec(h))) { registry[m[1]] = new FakeEl(m[1]); this._childIds.push(m[1]); }
  }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(t, fn) { (this.handlers[t] = this.handlers[t] || []).push(fn); }
  fire(t, ev = {}) { (this.handlers[t] || []).forEach(fn => fn({ preventDefault() { ev.prevented = true; }, ...ev })); return ev; }
  focus() { activeElement = this; }
  type(text) { this.focus(); this._value += text; this.selectionStart = this.selectionEnd = this._value.length; this.fire('input'); }
}
registry.rdChatArea = new FakeEl('rdChatArea');
registry.drvChatArea = new FakeEl('drvChatArea');

// ── Stubbed api(): controllable success/failure, call log ──
const apiCalls = [];
let apiMode = 'ok';
const ctx = {
  console,
  esc: s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
  $: id => registry[id] || null,
  api: async (p, opts) => {
    apiCalls.push({ p, method: opts && opts.method || 'GET', body: opts && opts.body });
    await tick();
    if (opts && opts.method === 'POST' && apiMode === 'fail') throw new Error('network down');
    if (!opts || !opts.method) return ctx.__messages || [];
    return { id: 'm1' };
  },
  __messages: [],
};
vm.createContext(ctx);
vm.runInContext(src, ctx);

(async () => {
  // const/let declarations in vm module scope don't land on ctx — pull them out.
  const { chatMount, chatUnmount, chatSend, rideChat, CHAT_OPEN } = vm.runInContext('({chatMount,chatUnmount,chatSend,rideChat,CHAT_OPEN})', ctx);
  const posts = () => apiCalls.filter(c => c.method === 'POST').length;

  ok('CHAT_OPEN covers active ride states only', JSON.stringify(CHAT_OPEN) === JSON.stringify(['driver_assigned', 'driver_en_route', 'driver_arrived', 'pin_verified', 'in_progress']));

  // ── 1. Typing survives repeated realtime re-renders (location/status/poll)
  chatMount('rdChatArea', 'rideA', 'Message driver…'); await tick();
  const inp = ctx.$('rdChatAreaIn');
  ok('composer mounted', !!inp);
  inp.type('Nakuja'); inp.selectionStart = inp.selectionEnd = 3;
  for (let i = 0; i < 10; i++) { chatMount('rdChatArea', 'rideA', 'Message driver…'); await tick(); } // every poll/SSE tick calls this
  ok('input DOM element NOT recreated across 10 refreshes', ctx.$('rdChatAreaIn') === inp);
  ok('draft text survives refreshes', inp.value === 'Nakuja', inp.value);
  ok('focus survives refreshes', activeElement === inp);
  ok('caret position survives refreshes', inp.selectionStart === 3 && inp.selectionEnd === 3);
  ok('draft kept in memory only, not in HTML attributes', !registry.rdChatArea.innerHTML.includes('Nakuja') && registry.rdChatArea.getAttribute('data-ride') === 'rideA');

  // ── 2. Two rides never share drafts
  chatUnmount('drvChatArea'); chatMount('drvChatArea', 'rideB', 'Message rider…'); await tick();
  const inpB = ctx.$('drvChatAreaIn');
  ok('second ride composer starts empty', inpB.value === '');
  inpB.type('Niko hapa');
  ok('drafts are per ride', rideChat.drafts.rideA === 'Nakuja' && rideChat.drafts.rideB === 'Niko hapa', rideChat.drafts);

  // ── 3. Failed send retains draft, shows safe error, no duplicate messages
  apiMode = 'fail';
  const before = posts();
  await chatSend('rdChatArea', 'rideA'); await tick();
  ok('failed send keeps the draft', inp.value === 'Nakuja' && rideChat.drafts.rideA === 'Nakuja', rideChat.drafts);
  ok('failed send shows a safe error (no raw internals)', /try again/i.test(ctx.$('rdChatAreaErr').textContent));
  ok('failed send made exactly one POST', posts() === before + 1);

  // ── 4. Successful send clears the draft exactly once; double-click = 1 POST
  apiMode = 'ok';
  const b2 = posts();
  const p1 = chatSend('rdChatArea', 'rideA'); const p2 = chatSend('rdChatArea', 'rideA'); // double click while submitting
  await p1; await p2; await tick();
  ok('duplicate send prevented while submitting', posts() === b2 + 1, posts() - b2);
  ok('successful send clears draft once', inp.value === '' && !('rideA' in rideChat.drafts), rideChat.drafts);
  ok('send button re-enabled after send', ctx.$('rdChatAreaBtn').disabled === false);

  // ── 5. Enter sends; empty input never sends; reconnect never auto-sends
  const b3 = posts();
  inp.fire('keydown', { key: 'Enter' }); await tick();
  ok('Enter with empty input sends nothing', posts() === b3);
  inp.type('On my way');
  const b4 = posts();
  chatMount('rdChatArea', 'rideA', 'Message driver…'); await tick(); // simulated reconnect/re-render
  ok('reconnect does not erase or auto-send the draft', posts() === b4 && inp.value === 'On my way');
  const ev = inp.fire('keydown', { key: 'Enter' }); await tick(); await tick();
  ok('Enter performs the intended send', posts() === b4 + 1 && ev.prevented === true && inp.value === '');

  // ── 6. Ride completion / unmount clears the draft and DOM
  inpB.focus();
  chatUnmount('drvChatArea', 'rideB');
  ok('completion clears draft and composer', !('rideB' in rideChat.drafts) && !ctx.$('drvChatAreaIn') && registry.drvChatArea.getAttribute('data-ride') === null, rideChat.drafts);

  // ── 7. Messages render through esc() — script content stays escaped
  ctx.__messages = [{ mine: false, body: '<script>alert(1)</script>' }];
  chatMount('rdChatArea', 'rideC', 'Message driver…'); await tick(); await tick();
  const msgs = ctx.$('rdChatAreaMsgs');
  ok('HTML/script message content safely escaped', msgs.innerHTML.includes('&lt;script&gt;') && !msgs.innerHTML.includes('<script>'), msgs.innerHTML);

  // ── 8. Static source checks: logout clears drafts; no drafts/JWTs in URLs
  ok('logout clears in-memory drafts', /function logout\(\)\{try\{rideChat\.drafts=\{\};/.test(html));
  ok('chat POST body carries the message, never the URL', /api\('\/api\/rides\/'\+rideId\+'\/messages',\{method:'POST',body:JSON\.stringify\(\{body:v\}\)\}\)/.test(src));
  ok('rider render mounts chat outside re-rendered status area', html.includes("$('rdStatusArea').innerHTML=h;") && html.includes("chatMount('rdChatArea',ride.id"));
  ok('driver render mounts chat outside re-rendered status area', html.includes("$('drvRideStatus').innerHTML=") && html.includes("chatMount('drvChatArea',r.id"));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
