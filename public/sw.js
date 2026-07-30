// HAPA service worker — app-shell caching only.
// NEVER caches /api/ responses (JWT-authenticated data, signed URLs, private
// documents, trip locations). Navigations fall back to /offline.html.
const CACHE='hapa-v1.9.0';
const SHELL=['/','/manifest.webmanifest','/icon.svg','/offline.html'];
self.addEventListener('install',e=>{self.skipWaiting();e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)))});
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==CACHE).map(x=>caches.delete(x)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{
 const u=new URL(e.request.url);
 if(e.request.method!=='GET')return;
 if(u.origin!==self.location.origin)return;          // never touch third-party (e.g. maps)
 if(u.pathname.startsWith('/api/'))return;            // never cache API/authenticated data
 if(u.pathname.startsWith('/.well-known/'))return;
 if(e.request.mode==='navigate'){
  e.respondWith(fetch(e.request).catch(()=>caches.match('/offline.html')));
  return;
 }
 e.respondWith(fetch(e.request).then(r=>{
  if(r.ok&&SHELL.includes(u.pathname)){const cp=r.clone();caches.open(CACHE).then(c=>c.put(e.request,cp));}
  return r;
 }).catch(()=>caches.match(e.request)));
});
