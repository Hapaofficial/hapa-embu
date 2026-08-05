// Frontend regression tests: Maps autocomplete/GPS race safety and stream auth.
// Extracts the real booking helpers from public/index.html and proves stale
// provider responses cannot bind old coordinates to newly typed addresses.
// Usage: node tests/maps-frontend-races.test.js
const fs=require('fs');
const path=require('path');
const vm=require('vm');

const html=fs.readFileSync(path.join(__dirname,'..','public','index.html'),'utf8');
const rides=fs.readFileSync(path.join(__dirname,'..','routes','rides.js'),'utf8');
const acStart=html.indexOf('const acState=');
const acEnd=html.indexOf('// ── Booking map preview',acStart);
const gpsStart=html.indexOf('async function rdUseGps()');
const gpsEnd=html.indexOf('async function rdEstimate()',gpsStart);
if(acStart<0||acEnd<0||gpsStart<0||gpsEnd<0){console.error('Maps helper blocks not found');process.exit(1);}
const src=html.slice(acStart,acEnd)+html.slice(gpsStart,gpsEnd);

let pass=0,fail=0;
const ok=(n,c,x)=>{if(c){pass++;console.log('PASS',n);}else{fail++;console.log('FAIL',n,x!==undefined?JSON.stringify(x):'');}};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};

class FakeClassList{
 constructor(){this.s=new Set();}
 add(x){this.s.add(x);} remove(x){this.s.delete(x);} contains(x){return this.s.has(x);}
}
class FakeEl{
 constructor(id){this.id=id;this.value='';this.textContent='';this.innerHTML='';this.classList=new FakeClassList();}
}
const els={rdPickA:new FakeEl('rdPickA'),rdDestA:new FakeEl('rdDestA'),rdPickSug:new FakeEl('rdPickSug'),rdDestSug:new FakeEl('rdDestSug'),rdGpsNote:new FakeEl('rdGpsNote'),rdQuoteBox:new FakeEl('rdQuoteBox')};

const calls=[];
const pending=[];
const geo={success:null,error:null};
const ctx={
 console,setTimeout,clearTimeout,
 crypto:{randomUUID:()=>`session-${calls.length}`},
 RD_EMBU:{lat:-0.531,lng:37.4575},
 rdState:{pickup:null,dest:null,quote:{id:'old-quote'}},
 $:id=>els[id]||null,
 esc:s=>String(s),
 rdMapPreview:()=>{ctx.previews=(ctx.previews||0)+1;},
 api:(url,o)=>{const d=deferred(),body=JSON.parse(o.body);calls.push({url,body,d});pending.push(d);return d.promise;},
 navigator:{geolocation:{getCurrentPosition:(success,error)=>{geo.success=success;geo.error=error;}}},
};
vm.createContext(ctx);vm.runInContext(src,ctx);
const G=vm.runInContext('({acState,acInput,acFetch,acPick,rdUseGps,rdInvalidateQuote})',ctx);

(async()=>{
 // In-flight autocomplete is invalid as soon as the visible input changes,
 // even before the next 300ms debounce starts another request.
 els.rdPickA.value='Embu Town';G.acInput('pick');await wait(330);
 ok('first autocomplete request started',calls.length===1,calls.length);
 els.rdPickA.value='Em';G.acInput('pick');
 calls[0].d.resolve({suggestions:[{place_id:'old',text:'Old Embu'}]});await wait(0);
 ok('response for shortened input is ignored',G.acState.pick.items.length===0&&els.rdPickSug.classList.contains('hidden'));
 ok('editing a route clears its stale fare quote',ctx.rdState.quote===null&&els.rdQuoteBox.classList.contains('hidden'));

 // Two valid searches resolving out of order must leave only the newest list.
 els.rdPickA.value='Embu';G.acInput('pick');await wait(330);
 els.rdPickA.value='Kangaru';G.acInput('pick');await wait(330);
 const embu=calls[1],kangaru=calls[2];
 kangaru.d.resolve({suggestions:[{place_id:'new',text:'Kangaru School'}]});await wait(0);
 embu.d.resolve({suggestions:[{place_id:'old2',text:'Embu Old'}]});await wait(0);
 ok('out-of-order autocomplete keeps newest suggestions',G.acState.pick.items.length===1&&G.acState.pick.items[0].place_id==='new',G.acState.pick.items);

 // Place details may be slower than the user's next edit. Old coordinates
 // must never attach to the new text shown in the pickup field.
 const pickPromise=G.acPick('pick',0);await wait(0);
 const details=calls[3];
 els.rdPickA.value='My new pickup';G.acInput('pick');
 details.d.resolve({place:{place_id:'new',lat:-0.5,lng:37.4,formatted_address:'Kangaru School'}});
 await pickPromise;
 ok('stale place-details response cannot overwrite new text',els.rdPickA.value==='My new pickup'&&ctx.rdState.pickup===null,{text:els.rdPickA.value,pickup:ctx.rdState.pickup});

 // GPS creates a usable private coordinate fallback even if reverse geocoding
 // fails, so the quote form is not stranded with an empty pickup field.
 G.rdUseGps();geo.success({coords:{latitude:-0.53123,longitude:37.45789}});await wait(0);
 const reverse=calls[4];reverse.d.reject(new Error('geocoder unavailable'));await wait(0);
 ok('GPS remains usable when reverse geocoding fails',ctx.rdState.pickup&&els.rdPickA.value==='-0.53123, 37.45789',{pickup:ctx.rdState.pickup,text:els.rdPickA.value});

 // A delayed GPS callback cannot replace an address typed after permission was requested.
 G.rdUseGps();const oldGps=geo.success;
 els.rdPickA.value='Typed after GPS prompt';G.acInput('pick');
 oldGps({coords:{latitude:-0.52,longitude:37.45}});await wait(0);
 ok('late GPS callback cannot overwrite manual input',els.rdPickA.value==='Typed after GPS prompt'&&ctx.rdState.pickup===null,{text:els.rdPickA.value,pickup:ctx.rdState.pickup});

 // Realtime auth is deliberately header-only on both client and server.
 ok('frontend sends ride-stream token only in Authorization header',html.includes("fetch('/api/rides/stream',{headers:{Authorization:'Bearer '+token}"));
 ok('server rejects query-string bearer-token plumbing',!rides.includes('req.query.token')&&!/rides\/stream[^\n]*query/.test(rides));

 console.log(`\n${pass} passed, ${fail} failed`);process.exit(fail?1:0);
})().catch(e=>{console.error('FATAL',e);process.exit(1);});
