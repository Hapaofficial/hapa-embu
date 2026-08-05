// HAPA Maps provider abstraction.
// Two modes, selected by MAPS_PROVIDER (or auto-detected from configured keys):
//   mock   — deterministic, clearly-labelled development estimates. Never
//            pretends to be real routing, never used silently in production.
//   google — Google Maps Platform through the correct client/server split:
//            Places API (New) + Routes API server-side with field masks;
//            the browser only ever receives the referrer-restricted WEB key.
// All Google-specific calls live here — ride code talks to this interface only.
const crypto=require('crypto');

const IS_PROD=process.env.NODE_ENV==='production';
const TIMEOUT_MS=Math.max(1000,Number(process.env.MAPS_TIMEOUT_MS)||8000);
const MATRIX_MAX=Math.max(1,Math.min(25,Number(process.env.MAPS_MATRIX_MAX_CANDIDATES)||5));

class MapsError extends Error{
 constructor(category,message){super(message||category);this.name='MapsError';this.category=category;}
}
const CATEGORIES=['not_configured','timeout','quota','provider_error','malformed','fault_injected'];

// ── Key & provider configuration ─────────────────────────────────────────────
function webKey(){return process.env.GOOGLE_MAPS_WEB_KEY||process.env.GOOGLE_MAPS_BROWSER_KEY||null;}
function serverKey(){return process.env.GOOGLE_MAPS_SERVER_KEY||null;}
function provider(){
 const p=String(process.env.MAPS_PROVIDER||'').toLowerCase();
 if(p==='google')return 'google';
 if(p==='mock')return 'mock';
 return serverKey()?'google':'mock';  // auto: real keys → google, otherwise labelled mock
}
const MOCK_LABEL='Development route estimate — Google Maps not configured';

// ── Health tracking (owner panel; in-memory, no coordinates, no keys) ────────
const health={};// capability -> {last_ok_at,last_error_at,last_error_category,calls,errors}
function rec(capability,ok,category){
 const h=health[capability]||(health[capability]={last_ok_at:null,last_error_at:null,last_error_category:null,calls:0,errors:0});
 h.calls++;
 if(ok)h.last_ok_at=new Date().toISOString();
 else{h.errors++;h.last_error_at=new Date().toISOString();h.last_error_category=category||'provider_error';}
}

// ── Test-only fault injection (never in production) ──────────────────────────
// MAPS_FAULT_INJECT="route:timeout,matrix:partial,autocomplete:provider_error,details:malformed,geocode:provider_error"
function fault(capability){
 if(IS_PROD)return null;
 const spec=String(process.env.MAPS_FAULT_INJECT||'');
 if(!spec)return null;
 for(const pair of spec.split(',')){
  const[cap,kind]=pair.split(':').map(s=>String(s||'').trim());
  if(cap===capability)return kind||'provider_error';
 }
 return null;
}

// ── Shared geometry helpers ──────────────────────────────────────────────────
const havM=(a,b,c,d)=>{const R=6371000,r=x=>x*Math.PI/180,dl=r(c-a),dg=r(d-b);const h=Math.sin(dl/2)**2+Math.cos(r(a))*Math.cos(r(c))*Math.sin(dg/2)**2;return Math.round(2*R*Math.asin(Math.sqrt(h)));};
// Minimal polyline encoder (Google encoded polyline algorithm) for mock routes.
function encodePolyline(points){
 let out='',pLat=0,pLng=0;
 const enc=v=>{v=v<0?~(v<<1):v<<1;let s='';while(v>=0x20){s+=String.fromCharCode((0x20|(v&0x1f))+63);v>>=5;}return s+String.fromCharCode(v+63);};
 for(const[lat,lng]of points){
  const iLat=Math.round(lat*1e5),iLng=Math.round(lng*1e5);
  out+=enc(iLat-pLat)+enc(iLng-pLng);pLat=iLat;pLng=iLng;
 }
 return out;
}

async function gfetch(url,opts,capability){
 const ctl=new AbortController();
 const t=setTimeout(()=>ctl.abort(),TIMEOUT_MS);
 try{
  const r=await fetch(url,{...opts,signal:ctl.signal});
  if(r.status===429)throw new MapsError('quota','Provider quota exceeded');
  if(!r.ok){
   let detail='';try{detail=(await r.json())?.error?.message||''}catch{}
   if(/quota|rate/i.test(detail))throw new MapsError('quota',detail);
   throw new MapsError('provider_error',`Provider HTTP ${r.status}`);
  }
  return await r.json();
 }catch(e){
  if(e.name==='AbortError')throw new MapsError('timeout','Provider timed out');
  if(e instanceof MapsError)throw e;
  throw new MapsError('provider_error',e.message);
 }finally{clearTimeout(t)}
}

// ── Mock adapter (deterministic; labelled; DB-backed area suggestions) ──────
let dbq=null;// injected query fn for mock autocomplete over geo_areas
function init(deps){dbq=deps&&deps.q||dbq;}
const MOCK_LANDMARKS=[
 {name:'Embu Town CBD',lat:-0.5310,lng:37.4575},
 {name:'Kangaru School gate',lat:-0.5107,lng:37.4419},
 {name:'Embu Level 5 Hospital',lat:-0.5205,lng:37.4483},
 {name:'Izaak Walton area',lat:-0.5253,lng:37.4667},
 {name:'Blue Valley, Embu',lat:-0.5460,lng:37.4510},
 {name:'Kenyatta Highway stage, Embu',lat:-0.5334,lng:37.4529},
];
const mock={
 async autocomplete({input}){
  const f=fault('autocomplete');if(f)throw new MapsError(f==='timeout'?'timeout':'provider_error','Injected autocomplete fault');
  const needle=String(input||'').toLowerCase();
  const out=MOCK_LANDMARKS.filter(l=>l.name.toLowerCase().includes(needle))
   .map(l=>({place_id:'mock:'+l.name.toLowerCase().replace(/[^a-z0-9]+/g,'-'),text:l.name,secondary:'Embu, Kenya (development suggestion)'}));
  if(dbq){
   const rows=(await dbq(`SELECT slug,name,level FROM geo_areas WHERE active AND LOWER(name) LIKE $1 ORDER BY level DESC,name LIMIT 5`,['%'+needle+'%'])).rows;
   for(const r of rows)out.push({place_id:'mock:area:'+r.slug,text:r.name,secondary:`${r.level}, Kenya (development suggestion)`});
  }
  return{suggestions:out.slice(0,8),provider:'mock',note:MOCK_LABEL};
 },
 async placeDetails({placeId}){
  const f=fault('details');if(f)throw new MapsError(f==='malformed'?'malformed':'provider_error','Injected details fault');
  const id=String(placeId||'');
  const lm=MOCK_LANDMARKS.find(l=>'mock:'+l.name.toLowerCase().replace(/[^a-z0-9]+/g,'-')===id);
  if(lm)return{place_id:id,formatted_address:lm.name+', Embu, Kenya',display_name:lm.name,lat:lm.lat,lng:lm.lng,provider:'mock'};
  if(id.startsWith('mock:area:')&&dbq){
   const r=(await dbq(`SELECT slug,name,config FROM geo_areas WHERE slug=$1`,[id.slice(10)])).rows[0];
   if(r){
    const c=r.config&&r.config.center||{};
    return{place_id:id,formatted_address:r.name+', Kenya',display_name:r.name,lat:Number(c.lat)||-0.5310,lng:Number(c.lng)||37.4575,provider:'mock'};
   }
  }
  throw new MapsError('provider_error','Unknown development place');
 },
 async reverseGeocode({lat,lng}){
  let best=null,bd=1/0;
  for(const l of MOCK_LANDMARKS){const d=havM(lat,lng,l.lat,l.lng);if(d<bd){bd=d;best=l;}}
  return{formatted_address:best&&bd<8000?`Near ${best.name} (development label)`:`${lat.toFixed(5)}, ${lng.toFixed(5)} (development label)`,provider:'mock'};
 },
 async computeRoute({origin,dest}){
  const f=fault('route');
  if(f==='timeout')throw new MapsError('timeout','Injected route timeout');
  if(f==='quota')throw new MapsError('quota','Injected route quota error');
  if(f==='malformed')throw new MapsError('malformed','Injected malformed route');
  const straight=havM(origin.lat,origin.lng,dest.lat,dest.lng);
  const distance_m=Math.round(straight*1.4);// road-factor heuristic, labelled
  return{distance_m,duration_s:Math.round(distance_m/(30/3.6)),
   polyline:encodePolyline([[origin.lat,origin.lng],[dest.lat,dest.lng]]),
   travel_mode:'DRIVE',routing_preference:'DEVELOPMENT_ESTIMATE',provider:'mock',note:MOCK_LABEL};
 },
 async computeRouteMatrix({origins,dest}){
  const f=fault('matrix');
  if(f==='timeout')throw new MapsError('timeout','Injected matrix timeout');
  const rows=origins.slice(0,MATRIX_MAX).map((o,i)=>{
   if(f==='partial'&&i%2===1)return{id:o.id,ok:false,error_category:'provider_error'};
   const d=Math.round(havM(o.lat,o.lng,dest.lat,dest.lng)*1.4);
   return{id:o.id,ok:true,distance_m:d,eta_s:Math.round(d/(30/3.6))};
  });
  return{results:rows,provider:'mock',note:MOCK_LABEL};
 },
};

// ── Google adapter (Places API (New) + Routes API; field-masked) ────────────
const google={
 async autocomplete({input,sessionToken,bias}){
  if(!serverKey())throw new MapsError('not_configured','Google Maps server key not configured');
  const body={input:String(input||'').slice(0,120),
   includedRegionCodes:['ke'],
   ...(sessionToken?{sessionToken:String(sessionToken).slice(0,64)}:{}),
   ...(bias&&Number.isFinite(bias.lat)?{locationBias:{circle:{center:{latitude:bias.lat,longitude:bias.lng},radius:Math.min(50000,Number(bias.radius_m)||30000)}}}:{})};
  const d=await gfetch('https://places.googleapis.com/v1/places:autocomplete',{
   method:'POST',
   headers:{'Content-Type':'application/json','X-Goog-Api-Key':serverKey(),
    'X-Goog-FieldMask':'suggestions.placePrediction.placeId,suggestions.placePrediction.text,suggestions.placePrediction.structuredFormat'},
   body:JSON.stringify(body)},'autocomplete');
  const suggestions=(d.suggestions||[]).map(s=>s.placePrediction).filter(Boolean).map(p=>({
   place_id:p.placeId,
   text:p.structuredFormat?.mainText?.text||p.text?.text||'',
   secondary:p.structuredFormat?.secondaryText?.text||''}));
  return{suggestions,provider:'google'};
 },
 async placeDetails({placeId,sessionToken}){
  if(!serverKey())throw new MapsError('not_configured','Google Maps server key not configured');
  const url=`https://places.googleapis.com/v1/places/${encodeURIComponent(String(placeId||''))}`+(sessionToken?`?sessionToken=${encodeURIComponent(String(sessionToken).slice(0,64))}`:'');
  const d=await gfetch(url,{headers:{'X-Goog-Api-Key':serverKey(),'X-Goog-FieldMask':'id,displayName,formattedAddress,location'}},'details');
  if(!d.location)throw new MapsError('malformed','Place has no location');
  return{place_id:d.id,formatted_address:d.formattedAddress||'',display_name:d.displayName?.text||'',
   lat:d.location.latitude,lng:d.location.longitude,provider:'google'};
 },
 async reverseGeocode({lat,lng}){
  if(!serverKey())throw new MapsError('not_configured','Google Maps server key not configured');
  const d=await gfetch(`https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&region=ke&key=${serverKey()}`,{},'geocode');
  if(d.status==='OVER_QUERY_LIMIT')throw new MapsError('quota','Geocoding quota exceeded');
  const first=(d.results||[])[0];
  return{formatted_address:first?first.formatted_address:null,provider:'google'};
 },
 async computeRoute({origin,dest}){
  if(!serverKey())throw new MapsError('not_configured','Google Maps server key not configured');
  const d=await gfetch('https://routes.googleapis.com/directions/v2:computeRoutes',{
   method:'POST',
   headers:{'Content-Type':'application/json','X-Goog-Api-Key':serverKey(),
    'X-Goog-FieldMask':'routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline'},
   body:JSON.stringify({
    origin:{location:{latLng:{latitude:origin.lat,longitude:origin.lng}}},
    destination:{location:{latLng:{latitude:dest.lat,longitude:dest.lng}}},
    travelMode:'DRIVE',routingPreference:'TRAFFIC_AWARE',
    languageCode:'en-KE',units:'METRIC'})},'route');
  const r=(d.routes||[])[0];
  if(!r||!Number.isFinite(Number(r.distanceMeters)))throw new MapsError('malformed','Route response missing distance');
  return{distance_m:Math.round(Number(r.distanceMeters)),
   duration_s:Math.round(parseFloat(String(r.duration||'0').replace(/s$/,''))||0),
   polyline:r.polyline?.encodedPolyline||null,
   travel_mode:'DRIVE',routing_preference:'TRAFFIC_AWARE',provider:'google'};
 },
 async computeRouteMatrix({origins,dest}){
  if(!serverKey())throw new MapsError('not_configured','Google Maps server key not configured');
  const caps=origins.slice(0,MATRIX_MAX);
  const d=await gfetch('https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix',{
   method:'POST',
   headers:{'Content-Type':'application/json','X-Goog-Api-Key':serverKey(),
    'X-Goog-FieldMask':'originIndex,destinationIndex,distanceMeters,duration,condition'},
   body:JSON.stringify({
    origins:caps.map(o=>({waypoint:{location:{latLng:{latitude:o.lat,longitude:o.lng}}}})),
    destinations:[{waypoint:{location:{latLng:{latitude:dest.lat,longitude:dest.lng}}}}],
    travelMode:'DRIVE',routingPreference:'TRAFFIC_AWARE'})},'matrix');
  const rows=Array.isArray(d)?d:(d.elements||[]);
  const results=caps.map((o,i)=>{
   const el=rows.find(r=>Number(r.originIndex)===i);
   if(!el||el.condition==='ROUTE_NOT_FOUND'||!Number.isFinite(Number(el.distanceMeters)))
    return{id:o.id,ok:false,error_category:'provider_error'};
   return{id:o.id,ok:true,distance_m:Math.round(Number(el.distanceMeters)),
    eta_s:Math.round(parseFloat(String(el.duration||'0').replace(/s$/,''))||0)};
  });
  return{results,provider:'google'};
 },
};

// ── Public interface with health recording ───────────────────────────────────
function impl(){return provider()==='google'?google:mock;}
async function call(capability,fn,args){
 try{const out=await fn(args);rec(capability,true);return out;}
 catch(e){rec(capability,false,e.category||'provider_error');throw e;}
}
const api={
 MapsError,MOCK_LABEL,MATRIX_MAX,init,provider,webKey:()=>!!webKey(),serverKeyConfigured:()=>!!serverKey(),
 publicWebKey:webKey,// referrer-restricted browser key: public-by-design, never the server key
 autocomplete:a=>call('autocomplete',impl().autocomplete,a),
 placeDetails:a=>call('details',impl().placeDetails,a),
 reverseGeocode:a=>call('geocode',impl().reverseGeocode,a),
 computeRoute:a=>call('route',impl().computeRoute,a),
 computeRouteMatrix:a=>call('matrix',impl().computeRouteMatrix,a),
 navLink({lat,lng},origin){
  // Only coordinates — never names, phones, notes, ride IDs or tokens.
  const dst=`${Number(lat).toFixed(6)},${Number(lng).toFixed(6)}`;
  const org=origin&&Number.isFinite(Number(origin.lat))?`&origin=${Number(origin.lat).toFixed(6)},${Number(origin.lng).toFixed(6)}`:'';
  return `https://www.google.com/maps/dir/?api=1&destination=${dst}${org}&travelmode=driving`;
 },
 snapshotHash(s){
  // Tamper-evidence for stored route snapshots (keyed, deterministic).
  const basis=[s.provider,s.origin_lat,s.origin_lng,s.dest_lat,s.dest_lng,s.distance_m,s.duration_s,s.polyline||'',s.computed_at||''].join('|');
  return crypto.createHmac('sha256',String(process.env.SESSION_SECRET||process.env.JWT_SECRET||'hapa')).update(basis).digest('hex');
 },
 status(){
  return{
   provider:provider(),
   mode_forced:!!process.env.MAPS_PROVIDER,
   mock_label:provider()==='mock'?MOCK_LABEL:null,
   keys:{web:!!webKey(),server:!!serverKey()},// booleans only — never values
   matrix_max_candidates:MATRIX_MAX,timeout_ms:TIMEOUT_MS,
   capabilities:Object.fromEntries(Object.entries(health).map(([k,v])=>[k,{...v}])),
  };
 },
 _categories:CATEGORIES,
};
module.exports=api;
