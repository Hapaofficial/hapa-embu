// Geo module — configurable geographic hierarchy (Kenya-wide from day one).
// Embu is the first ACTIVE market; all other Kenyan counties are seeded but
// stay inactive until the Owner activates them through configuration (no code
// deployment). Fare rate cards are per area + vehicle category + effective date.
module.exports=function(app,deps){
 const{q,auth,active,owner,audit}=deps;

 // ── Seed: Kenya + all 47 counties (Embu active) + Embu pilot zone. Idempotent.
 const KENYA_COUNTIES=['Baringo','Bomet','Bungoma','Busia','Elgeyo-Marakwet','Embu','Garissa','Homa Bay','Isiolo','Kajiado','Kakamega','Kericho','Kiambu','Kilifi','Kirinyaga','Kisii','Kisumu','Kitui','Kwale','Laikipia','Lamu','Machakos','Makueni','Mandera','Marsabit','Meru','Migori','Mombasa','Murang\u2019a','Nairobi','Nakuru','Nandi','Narok','Nyamira','Nyandarua','Nyeri','Samburu','Siaya','Taita-Taveta','Tana River','Tharaka-Nithi','Trans Nzoia','Turkana','Uasin Gishu','Vihiga','Wajir','West Pokot'];
 const slugify=s=>String(s).toLowerCase().replace(/\u2019/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
 async function seedGeo(){
  const ke=(await q(`INSERT INTO geo_areas(slug,name,level,active) VALUES('kenya','Kenya','country',TRUE)
   ON CONFLICT(slug) DO UPDATE SET active=TRUE RETURNING id`)).rows[0];
  for(const c of KENYA_COUNTIES){
   await q(`INSERT INTO geo_areas(slug,name,level,parent_id,active) VALUES($1,$2,'county',$3,$4) ON CONFLICT(slug) DO NOTHING`,
    ['county-'+slugify(c),c,ke.id,c==='Embu']);
  }
  const embu=(await q(`SELECT id FROM geo_areas WHERE slug='county-embu'`)).rows[0];
  await q(`INSERT INTO geo_areas(slug,name,level,parent_id,active,config) VALUES('zone-embu-pilot','Embu pilot area','zone',$1,TRUE,'{"search_radius_km":15,"cross_county":false}'::jsonb) ON CONFLICT(slug) DO NOTHING`,[embu.id]);
 }
 deps.seedGeo=seedGeo;

 // ── Helpers used by dispatch/publish enforcement elsewhere ────────────────
 // A provider county is serviceable only when it matches an ACTIVE county area.
 async function countyActive(name){
  if(!String(name||'').trim())return false;
  return!!(await q(`SELECT 1 FROM geo_areas WHERE level='county' AND active AND (LOWER(name)=LOWER($1) OR slug=$2) LIMIT 1`,[String(name).trim(),'county-'+slugify(name)])).rowCount;
 }
 async function countyKnown(name){
  if(!String(name||'').trim())return false;
  return!!(await q(`SELECT 1 FROM geo_areas WHERE level='county' AND (LOWER(name)=LOWER($1) OR slug=$2) LIMIT 1`,[String(name).trim(),'county-'+slugify(name)])).rowCount;
 }
 deps.geo={countyActive,countyKnown,slugify};

 // ── Public: active service areas only (drives onboarding dropdowns & filters;
 // newly activated towns/counties appear automatically — no client update).
 app.get('/api/public/areas',async(req,res)=>{
  try{
   // Only areas whose FULL ancestor chain is active are public: pausing a
   // county hides its towns/zones even if those rows remain flagged active.
   const rows=(await q(`WITH RECURSIVE act AS(
     SELECT id,slug,name,level,parent_id FROM geo_areas WHERE level='country' AND active
     UNION ALL
     SELECT a.id,a.slug,a.name,a.level,a.parent_id FROM geo_areas a JOIN act ON a.parent_id=act.id WHERE a.active
    )SELECT * FROM act ORDER BY level,name`)).rows;
   res.json({country:'Kenya',launch_note:'Launching first in Embu',areas:rows});
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });

 // ── Owner: full area management (activate/pause markets by configuration) ──
 app.get('/api/owner/areas',auth,owner,async(req,res)=>{
  try{
   const rows=(await q(`SELECT a.*,p.name AS parent_name,
     (SELECT count(*)::int FROM fare_rate_cards f WHERE f.area_id=a.id AND f.active) AS rate_cards
    FROM geo_areas a LEFT JOIN geo_areas p ON p.id=a.parent_id ORDER BY a.level,a.name`)).rows;
   res.json(rows);
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });
 app.post('/api/owner/areas',auth,owner,async(req,res)=>{
  try{
   const b=req.body||{};
   const name=String(b.name||'').trim().slice(0,120);
   const level=String(b.level||'');
   if(!name)return res.status(400).json({error:'Name is required'});
   if(!['county','sub_county','town','zone'].includes(level))return res.status(400).json({error:'Invalid level'});
   const parent=(await q(`SELECT id,level FROM geo_areas WHERE id::text=$1 OR slug=$1`,[String(b.parent||'')])).rows[0];
   if(!parent)return res.status(400).json({error:'Parent area not found'});
   const slug=level+'-'+slugify(name)+(level==='zone'||level==='town'?'-'+slugify(parent.level==='country'?'ke':String(b.parent)).slice(0,20):'');
   const r=await q(`INSERT INTO geo_areas(slug,name,level,parent_id,active,config) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(slug) DO NOTHING RETURNING *`,
    [slug,name,level,parent.id,b.active===true,JSON.stringify(typeof b.config==='object'&&b.config?b.config:{})]);
   if(!r.rowCount)return res.status(409).json({error:'Area already exists'});
   await audit(req.user.id,'geo_area_created','geo_area',r.rows[0].id,name+' ('+level+')');
   res.status(201).json(r.rows[0]);
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });
 app.patch('/api/owner/areas/:id',auth,owner,async(req,res)=>{
  try{
   const b=req.body||{};
   const a=(await q(`SELECT * FROM geo_areas WHERE id::text=$1 OR slug=$1`,[req.params.id])).rows[0];
   if(!a)return res.status(404).json({error:'Area not found'});
   if(a.level==='country')return res.status(400).json({error:'The country cannot be deactivated'});
   const sets=[],vals=[a.id];
   if(typeof b.active==='boolean'){vals.push(b.active);sets.push(`active=$${vals.length}`);}
   if(b.config&&typeof b.config==='object'){vals.push(JSON.stringify(b.config));sets.push(`config=$${vals.length}::jsonb`);}
   if(!sets.length)return res.status(400).json({error:'Nothing to update'});
   const r=(await q(`UPDATE geo_areas SET ${sets.join(',')},updated_at=NOW() WHERE id=$1 RETURNING *`,vals)).rows[0];
   await audit(req.user.id,'geo_area_updated','geo_area',a.id,'active='+String(b.active));
   res.json(r);
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });

 // ── Owner: per-area statistics (dashboard filters by location) ─────────────
 app.get('/api/owner/areas/stats',auth,owner,async(req,res)=>{
  try{
   const rows=(await q(`SELECT a.id,a.slug,a.name,a.active,
     (SELECT count(*)::int FROM professional_profiles p WHERE LOWER(p.county)=LOWER(a.name) AND p.status='active') AS professionals,
     (SELECT count(*)::int FROM merchant_profiles m WHERE LOWER(m.county)=LOWER(a.name) AND m.status='active') AS merchants,
     (SELECT count(*)::int FROM driver_profiles d WHERE LOWER(d.county)=LOWER(a.name) AND d.status='active') AS drivers,
     (SELECT count(*)::int FROM service_requests sr JOIN driver_profiles dp ON dp.id=sr.profile_id WHERE sr.provider_type='driver' AND LOWER(dp.county)=LOWER(a.name)) AS rides
    FROM geo_areas a WHERE a.level='county' ORDER BY a.active DESC,a.name`)).rows;
   res.json(rows);
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });

 // ── Owner: fare rate cards ──────────────────────────────────────────────────
 app.get('/api/owner/fare-cards',auth,owner,async(req,res)=>{
  try{
   const rows=(await q(`SELECT f.*,to_char(f.effective_from,'YYYY-MM-DD') AS effective_from,a.name AS area_name,a.slug AS area_slug,a.level AS area_level FROM fare_rate_cards f JOIN geo_areas a ON a.id=f.area_id ORDER BY a.name,f.vehicle_category,f.effective_from DESC`)).rows;
   res.json(rows);
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });
 app.post('/api/owner/fare-cards',auth,owner,async(req,res)=>{
  try{
   const b=req.body||{};
   const area=(await q(`SELECT id FROM geo_areas WHERE id::text=$1 OR slug=$1`,[String(b.area||'')])).rows[0];
   if(!area)return res.status(400).json({error:'Area not found'});
   const cat=String(b.vehicle_category||'').trim().slice(0,60);
   if(!cat)return res.status(400).json({error:'Vehicle category is required'});
   const n=x=>{const v=Number(x);return Number.isFinite(v)&&v>=0&&v<1e6?Math.round(v*100)/100:null;};
   const base=n(b.base_fare),perKm=n(b.per_km??0),perMin=n(b.per_min??0),min=n(b.minimum_fare??0);
   if(base==null||perKm==null||perMin==null||min==null)return res.status(400).json({error:'Invalid fare values'});
   const eff=b.effective_from?String(b.effective_from).slice(0,10):null;
   if(eff&&!/^\d{4}-\d{2}-\d{2}$/.test(eff))return res.status(400).json({error:'Invalid effective date'});
   // Date-only value stored as a Nairobi calendar date; duplicates of an
   // identical active card (area + category + effective date) are rejected.
   const r=(await q(`INSERT INTO fare_rate_cards(area_id,vehicle_category,base_fare,per_km,per_min,minimum_fare,effective_from) VALUES($1,$2,$3,$4,$5,$6,COALESCE($7::date,(NOW() AT TIME ZONE 'Africa/Nairobi')::date)) RETURNING *,to_char(effective_from,'YYYY-MM-DD') AS effective_from`,
    [area.id,cat,base,perKm,perMin,min,eff])).rows[0];
   await audit(req.user.id,'fare_card_created','fare_card',r.id,String(b.area)+' '+cat);
   res.status(201).json(r);
  }catch(e){
   if(e.code==='23505')return res.status(409).json({error:'An identical active rate card already exists for this area, vehicle category and effective date'});
   console.error(e);res.status(500).json({error:'Server error'})}
 });
 app.patch('/api/owner/fare-cards/:id',auth,owner,async(req,res)=>{
  try{
   const b=req.body||{};
   if(typeof b.active!=='boolean')return res.status(400).json({error:'Only {active} can be updated; create a new card for rate changes'});
   const r=await q(`UPDATE fare_rate_cards SET active=$2,updated_at=NOW() WHERE id::text=$1 RETURNING *`,[req.params.id,b.active]);
   if(!r.rowCount)return res.status(404).json({error:'Card not found'});
   await audit(req.user.id,'fare_card_updated','fare_card',req.params.id,'active='+String(b.active));
   res.json(r.rows[0]);
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });

 // ── Public fare estimate: newest effective active card for the area.
 // Zone/town cards override county cards. No coordinates accepted or returned.
 app.get('/api/public/fare-estimate',async(req,res)=>{
  try{
   const area=(await q(`SELECT id,name,active,level,parent_id FROM geo_areas WHERE slug=$1 OR LOWER(name)=LOWER($1) ORDER BY (slug=$1) DESC LIMIT 1`,[String(req.query.area||'')])).rows[0];
   if(!area||!area.active)return res.status(404).json({error:'Service area not available'});
   // The full ancestor chain must be active — a paused county hides its zones.
   const chainOk=(await q(`WITH RECURSIVE chain AS(
     SELECT id,parent_id,active FROM geo_areas WHERE id=$1
     UNION ALL SELECT g.id,g.parent_id,g.active FROM geo_areas g JOIN chain c ON g.id=c.parent_id
    )SELECT bool_and(active) AS ok FROM chain`,[area.id])).rows[0];
   if(!chainOk||chainOk.ok!==true)return res.status(404).json({error:'Service area not available'});
   const cat=String(req.query.vehicle_category||'').trim();
   if(!cat)return res.status(400).json({error:'vehicle_category is required'});
   // Nearest card wins: the area's own card first, then each ancestor in turn
   // (zone → town → sub-county → county), newest effective date breaking ties.
   const card=(await q(`WITH RECURSIVE chain AS(
     SELECT id,parent_id,0 AS depth FROM geo_areas WHERE id=$1
     UNION ALL SELECT g.id,g.parent_id,c.depth+1 FROM geo_areas g JOIN chain c ON g.id=c.parent_id
    )SELECT f.* FROM fare_rate_cards f JOIN chain c ON c.id=f.area_id
     WHERE f.active AND f.effective_from<=(NOW() AT TIME ZONE 'Africa/Nairobi')::date AND LOWER(f.vehicle_category)=LOWER($2)
     ORDER BY c.depth,f.effective_from DESC LIMIT 1`,[area.id,cat])).rows[0];
   if(!card)return res.status(404).json({error:'No rate card configured for this area yet'});
   const distKm=Math.max(0,Math.min(2000,Number(req.query.distance_m||0)/1000||0));
   const durMin=Math.max(0,Math.min(3300,Number(req.query.duration_s||0)/60||0));
   const est=Math.max(Number(card.minimum_fare),Number(card.base_fare)+distKm*Number(card.per_km)+durMin*Number(card.per_min));
   res.json({area:area.name,vehicle_category:card.vehicle_category,currency:card.currency,effective_from:card.effective_from,
    base_fare:Number(card.base_fare),per_km:Number(card.per_km),per_min:Number(card.per_min),minimum_fare:Number(card.minimum_fare),
    estimate:Math.round(est)});
  }catch(e){console.error(e);res.status(500).json({error:'Server error'})}
 });
};
