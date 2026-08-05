// Maps API surface: server-proxied Places autocomplete/details and reverse
// geocoding (the browser NEVER holds the server key), plus Owner-only
// maps/location health panels. All provider work happens in lib/maps.
const maps=require('../lib/maps');

module.exports=function(app,deps){
 const{q,auth,active,owner,writeLimiter}=deps;
 maps.init({q});

 // Per-user pace gate for Places calls (cost control on top of writeLimiter).
 const pace=new Map();// userId -> [timestamps]
 const AUTOCOMPLETE_MAX_PER_10S=Math.max(5,Number(process.env.MAPS_AUTOCOMPLETE_MAX_PER_10S)||25);
 function paced(userId){
  const now=Date.now(),arr=(pace.get(String(userId))||[]).filter(t=>now-t<10000);
  if(arr.length>=AUTOCOMPLETE_MAX_PER_10S)return false;
  arr.push(now);pace.set(String(userId),arr);
  if(pace.size>2000)for(const[k,v]of pace){if(!v.some(t=>now-t<10000))pace.delete(k);}
  return true;
 }
 const mapsFail=(res,e)=>{
  if(!(e instanceof maps.MapsError)){console.error(e);return res.status(500).json({error:'Server error'});}
  const code=e.category==='not_configured'?503:e.category==='timeout'?504:e.category==='quota'?429:502;
  return res.status(code).json({error:'Place lookup is temporarily unavailable',category:e.category});
 };

 // ── Public map runtime config (authed; only the referrer-restricted web key) ─
 app.get('/api/maps/config',auth,active,async(req,res)=>{
  res.json({provider:maps.provider(),web_key:maps.publicWebKey(),
   mock_label:maps.provider()!=='google'?maps.MOCK_LABEL:null,
   center:{lat:-0.5310,lng:37.4575},country:'KE'});
 });

 // ── Places autocomplete (session-token pass-through; Kenya-restricted) ─────
 app.post('/api/maps/autocomplete',auth,active,writeLimiter,async(req,res)=>{
  try{
   const b=req.body||{};
   const input=String(b.input||'').trim();
   if(input.length<3)return res.json({suggestions:[]});// too short — never bill a provider call
   if(!paced(req.user.id))return res.status(429).json({error:'Too many searches — slow down a moment'});
   const bias=Number.isFinite(Number(b.bias_lat))&&Number.isFinite(Number(b.bias_lng))?{lat:Number(b.bias_lat),lng:Number(b.bias_lng)}:{lat:-0.5310,lng:37.4575};
   const out=await maps.autocomplete({input,sessionToken:b.session_token,bias});
   res.json({suggestions:out.suggestions,provider:out.provider,note:out.note||null});
  }catch(e){mapsFail(res,e)}
 });
 app.post('/api/maps/place-details',auth,active,writeLimiter,async(req,res)=>{
  try{
   const b=req.body||{};
   if(!String(b.place_id||''))return res.status(400).json({error:'place_id required'});
   if(!paced(req.user.id))return res.status(429).json({error:'Too many lookups — slow down a moment'});
   const d=await maps.placeDetails({placeId:String(b.place_id).slice(0,256),sessionToken:b.session_token});
   res.json({place:d});
  }catch(e){mapsFail(res,e)}
 });
 app.post('/api/maps/reverse-geocode',auth,active,writeLimiter,async(req,res)=>{
  try{
   const b=req.body||{};
   const lat=Number(b.lat),lng=Number(b.lng);
   if(!Number.isFinite(lat)||!Number.isFinite(lng)||Math.abs(lat)>90||Math.abs(lng)>180)return res.status(400).json({error:'Invalid coordinates'});
   if(!paced(req.user.id))return res.status(429).json({error:'Too many lookups — slow down a moment'});
   const d=await maps.reverseGeocode({lat,lng});
   res.json({formatted_address:d.formatted_address,provider:d.provider});
  }catch(e){mapsFail(res,e)}
 });

 // ── Owner: maps configuration & provider health (no key values, ever) ──────
 app.get('/api/owner/maps/status',auth,owner,async(req,res)=>{
  try{
   const snaps=(await q(`SELECT count(*)::int AS total,count(*) FILTER(WHERE computed_at>NOW()-interval '24 hours')::int AS last_24h,
     count(*) FILTER(WHERE provider='google')::int AS google,count(*) FILTER(WHERE provider='mock')::int AS mock
    FROM route_snapshots`)).rows[0];
   res.json({...maps.status(),
    dispatch:deps.mapsDispatchState?deps.mapsDispatchState():null,
    route_snapshots:snaps});
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });
 app.get('/api/owner/location/health',auth,owner,async(req,res)=>{
  try{
   const presence=(await q(`SELECT count(*)::int AS drivers_tracked,
     count(*) FILTER(WHERE updated_at>NOW()-interval '90 seconds')::int AS fresh,
     count(*) FILTER(WHERE updated_at<=NOW()-interval '90 seconds')::int AS stale,
     COALESCE(EXTRACT(EPOCH FROM (NOW()-MAX(updated_at)))::int,NULL) AS newest_sample_age_s
    FROM driver_presence`)).rows[0];
   const samples=(await q(`SELECT count(*)::int AS total,count(*) FILTER(WHERE recorded_at>NOW()-interval '1 hour')::int AS last_hour FROM ride_location_samples`)).rows[0];
   res.json({ingest:deps.locationHealth?deps.locationHealth():null,presence,ride_samples:samples,
    retention_days_note:'Precise ride samples are pruned automatically per location_retention_days.'});
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });
};
