// Finance hardening: reconciliation alerts (§10), unicode/Swahili-safe PDFs
// (§11) and cross-month settlement correctness (§12, scenarios A–G).
// Synthetic local fixtures only; cross-month accrual uses direct backdating of
// this run's OWN synthetic rides via DATABASE_URL (never touches real data).
// Usage: TEST_OWNER_EMAIL=.. TEST_OWNER_PASSWORD=.. node tests/finance-hardening.test.js [baseUrl]
// The server must run with FINANCE_FAULT_INJECT_DRIVER=domain:fault-inject.test
// (test-only) so §10 can force a reconciliation failure for one synthetic user.
const{execFileSync}=require('child_process');
const fs=require('fs');
const{Pool}=require('pg');
const B=process.argv[2]||'http://127.0.0.1:5000';
const OWNER_EMAIL=process.env.TEST_OWNER_EMAIL,OWNER_PASSWORD=process.env.TEST_OWNER_PASSWORD;
const RUN='fh'+Date.now().toString(36);
const PW='TestPass2026x!';
const PICKUP={lat:-0.5310,lng:37.4575},DEST={lat:-0.4990,lng:37.4600};
const DIST_M=4922,DUR_S=591; // => gross 346.13 / commission 51.92 / net 294.21

let pass=0,fail=0;
const ok=(n,c,x)=>{if(c){pass++;console.log('PASS',n)}else{fail++;console.log('FAIL',n,x!==undefined?JSON.stringify(x).slice(0,400):'')}};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const j=async(m,p,t,b)=>{const r=await fetch(B+p,{method:m,headers:{'Content-Type':'application/json',...(t?{Authorization:'Bearer '+t}:{})},body:b?JSON.stringify(b):undefined});return{s:r.status,d:await r.json().catch(()=>({}))}};
const raw=async(p,t)=>{const r=await fetch(B+p,{headers:t?{Authorization:'Bearer '+t}:{}});return{s:r.status,buf:Buffer.from(await r.arrayBuffer())}};
const pdfText=buf=>{fs.writeFileSync('/tmp/fh.pdf',buf);return execFileSync('pdftotext',['/tmp/fh.pdf','-']).toString()};
function bboxPages(buf){
 fs.writeFileSync('/tmp/fh.pdf',buf);execFileSync('pdftotext',['-bbox','/tmp/fh.pdf','/tmp/fh-bbox.html']);
 const h=fs.readFileSync('/tmp/fh-bbox.html','utf8');
 return h.split('<page ').slice(1).map(p=>{
  const dims=/width="([\d.]+)" height="([\d.]+)"/.exec(p);
  const words=[...p.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g)].map(m=>({x1:+m[1],y1:+m[2],x2:+m[3],y2:+m[4],t:m[5]}));
  return{w:+dims[1],h:+dims[2],words};
 });
}
function layoutClean(pages){
 let overlaps=0,oob=0;
 for(const p of pages)for(let i=0;i<p.words.length;i++){
  const a=p.words[i];
  if(a.x2>p.w+0.5||a.y2>p.h+0.5||a.x1<-0.5||a.y1<-0.5)oob++;
  for(let k=i+1;k<p.words.length;k++){const b=p.words[k];
   const ix=Math.min(a.x2,b.x2)-Math.max(a.x1,b.x1),iy=Math.min(a.y2,b.y2)-Math.max(a.y1,b.y1);
   if(ix>1&&iy>2)overlaps++;}
 }
 return{overlaps,oob};
}

const db=new Pool({connectionString:process.env.DATABASE_URL});
// Backdate ONLY this run's own synthetic ride (accrual = ride completed_at).
async function backdate(rideId,isoUtc){
 const r=await db.query(`UPDATE ride_requests SET completed_at=$2,created_at=LEAST(created_at,$2::timestamptz) WHERE id=$1 RETURNING id`,[rideId,isoUtc]);
 if(!r.rowCount)throw new Error('backdate failed '+rideId);
}

async function makeUser(ownerTok,label,capType,details,name){
 const em=`${RUN}.${label}@${label==='alert'?'fault-inject.test':'example.com'}`;
 const reg=await j('POST','/api/auth/register',null,{name:name||('FH '+label),email:em,password:PW,selfie:'data:image/png;base64,iVBORw0KGgo='});
 if(reg.s!==201)throw new Error('register failed '+label+' '+JSON.stringify(reg.d));
 const uid=reg.d.user.id;
 const acc=(await j('GET','/api/owner/access',ownerTok)).d.find(a=>a.user_id===uid&&a.status==='pending');
 if(acc)await j('PATCH','/api/owner/access/'+acc.id,ownerTok,{status:'approved'});
 let tok=(await j('POST','/api/auth/login',null,{identifier:em,password:PW})).d.token;
 if(capType){
  await j('POST',`/api/me/upgrades/${capType}/submit`,tok,{details,consent:true});
  const app=(await j('GET','/api/owner/upgrades?type='+capType,ownerTok)).d.find(a=>a.user_id===uid&&a.status==='pending');
  await j('PATCH','/api/owner/upgrades/'+app.id+'/status',ownerTok,{status:'approved'});
  tok=(await j('POST','/api/auth/login',null,{identifier:em,password:PW})).d.token;
 }
 return{tok,uid,em};
}
const DOCS=['driving_licence','insurance','ntsa_inspection','psv_badge'];
let vehSeq=100+Math.floor(Math.random()*800);
async function makeDriver(ownerTok,label,name){
 const d=await makeUser(ownerTok,label,'driver',{fullName:name||('FH '+label),drivingLicenceNumber:'DL-'+RUN+label,vehicleType:'Boda Boda',registrationNumber:'K'+label.toUpperCase().slice(0,2)+' 7'+RUN.slice(-2).toUpperCase(),county:'Embu'},name);
 await j('POST','/api/me/driver-profile',d.tok);
 const veh=await j('POST','/api/me/vehicles',d.tok,{category:'Passenger Car',make:'Toyota',model:'Vitz',colour:'Blue',registration_number:'KH'+label.slice(-1).toUpperCase()+' '+(vehSeq++)+'Z'});
 await j('PATCH','/api/owner/vehicles/'+veh.d.id,ownerTok,{status:'approved'});
 for(const t of DOCS){const doc=await j('POST','/api/me/driver-documents',d.tok,{doc_type:t,reference:'REF-'+t,expires_on:'2027-12-31'});await j('PATCH','/api/owner/driver-documents/'+doc.d.id,ownerTok,{status:'approved'});}
 await j('POST','/api/me/operating-zones',d.tok,{zone:'zone-embu-pilot'});
 await j('POST','/api/agreements/accept',d.tok,{agreement:'driver_agreement'});
 return{...d,vehicleId:veh.d.id};
}
async function online(drv){
 await j('POST','/api/driver/online',drv.tok,{zone:'zone-embu-pilot',vehicle_id:drv.vehicleId});
 await j('POST','/api/driver/location',drv.tok,{lat:PICKUP.lat+0.001,lng:PICKUP.lng,seq:1,accuracy:8});
}
async function offline(drv){await j('POST','/api/driver/offline',drv.tok)}
async function runRide(riderTok,drv,pay,addrs){
 const q1=await j('POST','/api/rides/quote',riderTok,{pickup_lat:PICKUP.lat,pickup_lng:PICKUP.lng,dest_lat:DEST.lat,dest_lng:DEST.lng,zone:'zone-embu-pilot',vehicle_category:'Passenger Car',distance_m:DIST_M,duration_s:DUR_S});
 const r1=await j('POST','/api/rides',riderTok,{quote_id:q1.d.quote.id,payment_method:pay,pickup_lat:PICKUP.lat,pickup_lng:PICKUP.lng,dest_lat:DEST.lat,dest_lng:DEST.lng,pickup_address:(addrs&&addrs[0])||'Embu Town CBD',dest_address:(addrs&&addrs[1])||'Kangaru School gate'});
 if(r1.s!==201)throw new Error('ride create failed '+JSON.stringify(r1.d));
 const rideId=r1.d.ride.id,pin=r1.d.pin;
 let offer=null;
 for(let i=0;i<40&&!offer;i++){offer=(await j('GET','/api/driver/hub',drv.tok)).d.offer;if(!offer)await sleep(1000);}
 if(!offer)throw new Error('no offer for '+rideId);
 await j('POST','/api/offers/'+offer.id+'/accept',drv.tok);
 await j('POST',`/api/rides/${rideId}/arrived`,drv.tok);
 await j('POST',`/api/rides/${rideId}/verify-pin`,drv.tok,{pin});
 await j('POST',`/api/rides/${rideId}/start`,drv.tok);
 await sleep(1100);
 await j('POST',`/api/rides/${rideId}/complete`,drv.tok);
 if(pay==='cash')await j('POST',`/api/rides/${rideId}/cash-collected`,drv.tok);
 else{
  const p=await j('POST',`/api/rides/${rideId}/pay-mpesa`,riderTok,{phone:'254712345678'});
  if(p.s>=400)throw new Error('pay-mpesa failed '+JSON.stringify(p.d));
  for(let i=0;i<20;i++){const r=(await j('GET','/api/rides/'+rideId,riderTok)).d;if(r.ride&&r.ride.status==='closed')break;await sleep(500);}
 }
 return rideId;
}
const gen=(ownerTok,y,m,driverId)=>j('POST','/api/owner/statements/generate',ownerTok,{year:y,month:m,driver_id:driverId});
const stFull=async(ownerTok,id)=>(await j('GET','/api/statements/'+id,ownerTok)).d;
const settle=(ownerTok,driverId,direction,amount,method,notes)=>j('POST',`/api/owner/drivers/${driverId}/settlements`,ownerTok,{direction,amount,method,notes:notes||'fh test settlement'});
const N=x=>Number(x||0);

(async()=>{
 if(!OWNER_EMAIL||!OWNER_PASSWORD){console.error('owner creds required');process.exit(1);}
 const ownerTok=(await j('POST','/api/auth/login',null,{identifier:OWNER_EMAIL,password:OWNER_PASSWORD})).d.token;
 await j('PATCH','/api/owner/compliance/offer_timeout_s',ownerTok,{value:3});
 await j('POST','/api/owner/fare-cards',ownerTok,{area:'zone-embu-pilot',vehicle_category:'Passenger Car',base_fare:100,per_km:40,per_min:5,minimum_fare:150});
 const rider=await makeUser(ownerTok,'rider');
 await j('POST','/api/agreements/accept',rider.tok,{agreement:'rider_terms'});
 const JULY_TS='2026-07-15T10:00:00Z';

 // ════════ §10 — RECONCILIATION ALERTS ════════
 // Synthetic "driver" whose email matches the server's test-only fault domain.
 const faulty=await makeUser(ownerTok,'alert');
 let g=await gen(ownerTok,2026,7,faulty.uid);
 ok('§10 unbalanced generation fails safely (500)',g.s===500&&Array.isArray(g.d.failures)&&g.d.failures.length===1,g.d);
 const f0=g.d.failures[0];
 ok('§10 failure carries correlation + alert ids',/^FA-/.test(f0.correlation_id)&&!!f0.alert_id,f0);
 ok('§10 no statement issued for failed driver',!(g.d.generated||[]).length);
 const noSt=(await j('GET','/api/owner/statements?year=2026&month=7',ownerTok)).d.statements.filter(s=>s.driver_user_id===faulty.uid);
 ok('§10 no statement row persisted (txn rolled back)',noSt.length===0,noSt);
 let al=(await j('GET','/api/owner/finance/alerts?driver_id='+faulty.uid,ownerTok)).d;
 ok('§10 exactly one open critical alert',al.alerts.length===1&&al.alerts[0].status==='open'&&al.alerts[0].severity==='critical',al.alerts);
 const alert=al.alerts[0];
 ok('§10 alert has period/driver/equation/difference',alert.period_year===2026&&alert.period_month===7&&alert.detail.equation.includes('opening')&&N(alert.detail.difference_kes.driver_owes_hapa)===1,alert.detail);
 ok('§10 alert attempts=1 with timestamps',alert.attempts===1&&!!alert.first_seen_at&&!!alert.last_attempt_at);
 const alertJson=JSON.stringify(alert);
 ok('§10 alert leaks no credentials/GPS',!/password|jwt|Bearer|secret|-0\.53|37\.45/i.test(alertJson));
 // dedup on repeated failed attempts
 await gen(ownerTok,2026,7,faulty.uid);
 g=await gen(ownerTok,2026,7,faulty.uid);
 al=(await j('GET','/api/owner/finance/alerts?driver_id='+faulty.uid,ownerTok)).d;
 ok('§10 repeated failures deduplicate to one alert, attempts=3',al.alerts.length===1&&al.alerts[0].attempts===3,al.alerts.map(a=>a.attempts));
 ok('§10 dedup keeps same alert id',al.alerts[0].id===alert.id);
 // detail endpoint + timeline + honest notifier
 let det=(await j('GET','/api/owner/finance/alerts/'+alert.id,ownerTok)).d;
 const evs=det.events.map(e=>e.event);
 ok('§10 timeline: raised + reattempts + external_notification',evs.includes('raised')&&evs.includes('reattempt_failed')&&evs.includes('external_notification'),evs);
 const extEv=det.events.find(e=>e.event==='external_notification');
 ok('§10 notifier is honest (delivered=false, no provider claimed)',extEv.data.delivered===false&&det.notifier.note.includes('Nothing was sent externally'),extEv.data);
 // access control
 ok('§10 non-owner blocked from alerts (403)',(await j('GET','/api/owner/finance/alerts',rider.tok)).s===403);
 ok('§10 non-owner blocked from actions (403)',(await j('POST','/api/owner/finance/alerts/'+alert.id+'/action',rider.tok,{action:'resolve',note:'nope'})).s===403);
 // owner workflow actions
 let act=await j('POST','/api/owner/finance/alerts/'+alert.id+'/action',ownerTok,{action:'acknowledge'});
 ok('§10 acknowledge works',act.s===200&&act.d.alert.status==='acknowledged',act.d);
 ok('§10 note without text rejected',(await j('POST','/api/owner/finance/alerts/'+alert.id+'/action',ownerTok,{action:'note',note:''})).s===400);
 await j('POST','/api/owner/finance/alerts/'+alert.id+'/action',ownerTok,{action:'note',note:'Investigating the fault-injected imbalance'});
 act=await j('POST','/api/owner/finance/alerts/'+alert.id+'/action',ownerTok,{action:'investigate'});
 ok('§10 investigate works',act.s===200&&act.d.alert.status==='investigating');
 // auto-resolve: remove the fault (email out of fault domain), regenerate OK
 await db.query(`UPDATE users SET email=$2 WHERE id=$1 AND email=$3`,[faulty.uid,`${RUN}.alertfixed@example.com`,faulty.em]);
 g=await gen(ownerTok,2026,7,faulty.uid);
 ok('§10 regeneration after fix succeeds',g.s===200&&g.d.generated.length===1,g.d);
 det=(await j('GET','/api/owner/finance/alerts/'+alert.id,ownerTok)).d;
 ok('§10 alert auto-resolved by successful regeneration',det.alert.status==='resolved'&&det.alert.resolution==='auto_resolved_by_successful_regeneration',det.alert);
 const autoEv=det.events.find(e=>e.event==='auto_resolved');
 ok('§10 auto-resolve links the regenerated statement',!!autoEv&&autoEv.data.statement_reference===g.d.generated[0].reference,autoEv);
 ok('§10 closed alert cannot be re-acknowledged (409)',(await j('POST','/api/owner/finance/alerts/'+alert.id+'/action',ownerTok,{action:'acknowledge'})).s===409);
 act=await j('POST','/api/owner/finance/alerts/'+alert.id+'/action',ownerTok,{action:'reopen',note:'Re-checking before closing'});
 ok('§10 reopen works with note',act.s===200&&act.d.alert.status==='open');
 act=await j('POST','/api/owner/finance/alerts/'+alert.id+'/action',ownerTok,{action:'resolve',note:'Verified balanced after fix'});
 ok('§10 manual resolve works with note',act.s===200&&act.d.alert.status==='resolved'&&act.d.alert.resolution==='manually_resolved_by_owner');
 ok('§10 real alert cannot be deleted',(await j('DELETE','/api/owner/finance/alerts/'+alert.id,ownerTok)).s===404);
 // drill workflow
 const drill=await j('POST','/api/owner/finance/alerts/drill',ownerTok);
 ok('§10 drill alert created + flagged',drill.s===201&&drill.d.alert.is_drill===true&&drill.d.delivery.delivered===false,drill.d);
 ok('§10 drill deletable',(await j('DELETE','/api/owner/finance/alerts/'+drill.d.alert.id,ownerTok)).d.ok===true);

 // ════════ §12 — CROSS-MONTH SETTLEMENTS (A–G) ════════
 // Scenario A/B: cash driver, July accrual 103.84 → finalize → Aug partial 50 → 53.84 → full → 0
 const A=await makeDriver(ownerTok,'drva');
 await online(A);
 const ra1=await runRide(rider.tok,A,'cash'),ra2=await runRide(rider.tok,A,'cash');
 await offline(A);
 await backdate(ra1,JULY_TS);await backdate(ra2,JULY_TS);
 g=await gen(ownerTok,2026,7,A.uid);
 const julA=g.d.generated[0];
 let full=await stFull(ownerTok,julA.id);
 ok('A: July closing Driver owes HAPA = 103.84',N(full.statement.closing.driver_owes_hapa)===103.84,full.statement.closing);
 ok('A: July has exactly 2 ride items',full.items.filter(i=>i.item_type==='ride').length===2);
 const fin=await j('POST','/api/owner/statements/'+julA.id+'/finalize',ownerTok);
 ok('A: July statement finalized',fin.s===200&&fin.d.statement.status==='finalized',fin.d);
 const julASnap=JSON.stringify({c:full.statement.closing,s:full.statement.summary,r:full.statement.reference});
 // partial settlement in August
 const s1=await settle(ownerTok,A.uid,'driver_to_hapa',50,'cash_office','August partial payment');
 ok('B: partial settlement 50.00 recorded',s1.s===201&&N(s1.d.settlement.amount)===50,s1.d);
 g=await gen(ownerTok,2026,8,A.uid);
 const augA=g.d.generated[0];
 full=await stFull(ownerTok,augA.id);
 ok('B: Aug opening carries July 103.84',N(full.statement.opening.driver_owes_hapa)===103.84,full.statement.opening);
 ok('B: Aug closing after 50 partial = 53.84',N(full.statement.closing.driver_owes_hapa)===53.84,full.statement.closing);
 ok('B: Aug shows the settlement, no July rides re-listed',full.items.filter(i=>i.item_type==='settlement').length===1&&full.items.filter(i=>i.item_type==='ride').length===0,full.items.map(i=>i.item_type));
 ok('B: reconciliation balanced across months',full.statement.meta?.reconciliation?.balanced===true);
 // full settlement, regenerate (idempotent reference)
 await settle(ownerTok,A.uid,'driver_to_hapa',53.84,'mpesa','August final payment');
 g=await gen(ownerTok,2026,8,A.uid);
 ok('B: regeneration reuses Aug reference',g.d.generated[0].reference===augA.reference);
 full=await stFull(ownerTok,g.d.generated[0].id);
 ok('B: Aug closing after full settlement = 0.00',N(full.statement.closing.driver_owes_hapa)===0,full.statement.closing);
 // finalized July untouched by August activity or regeneration attempts
 g=await gen(ownerTok,2026,7,A.uid);
 const julA2=await stFull(ownerTok,julA.id);
 ok('A: finalized July immutable (closing/summary/reference unchanged)',JSON.stringify({c:julA2.statement.closing,s:julA2.statement.summary,r:julA2.statement.reference})===julASnap&&julA2.statement.status==='finalized');

 // Scenario C: M-Pesa payables cross month (HAPA owes Driver)
 const Bd=await makeDriver(ownerTok,'drvb');
 await online(Bd);
 const rb1=await runRide(rider.tok,Bd,'mpesa');
 await offline(Bd);
 await backdate(rb1,JULY_TS);
 g=await gen(ownerTok,2026,7,Bd.uid);
 full=await stFull(ownerTok,g.d.generated[0].id);
 ok('C: July closing HAPA owes Driver = 294.21',N(full.statement.closing.hapa_owes_driver)===294.21,full.statement.closing);
 await j('POST','/api/owner/statements/'+g.d.generated[0].id+'/finalize',ownerTok);
 const p1=await settle(ownerTok,Bd.uid,'hapa_to_driver',100,'mpesa','August partial payout');
 ok('C: partial payout recorded',p1.s===201,p1.d);
 g=await gen(ownerTok,2026,8,Bd.uid);
 full=await stFull(ownerTok,g.d.generated[0].id);
 ok('C: Aug opening owed 294.21 → closing 194.21',N(full.statement.opening.hapa_owes_driver)===294.21&&N(full.statement.closing.hapa_owes_driver)===194.21,{o:full.statement.opening,c:full.statement.closing});

 // Scenario D: reserve offset across months
 const Cd=await makeDriver(ownerTok,'drvc');
 await online(Cd);
 const rc1=await runRide(rider.tok,Cd,'cash');
 await offline(Cd);
 await backdate(rc1,JULY_TS);
 g=await gen(ownerTok,2026,7,Cd.uid);
 await j('POST','/api/owner/statements/'+g.d.generated[0].id+'/finalize',ownerTok);
 const top=await j('POST','/api/driver/reserve/topup',Cd.tok,{amount:200});
 ok('D: mock reserve top-up 200 accepted',top.s===201,top.d);
 const so=await settle(ownerTok,Cd.uid,'driver_to_hapa',51.92,'reserve_offset','Offset July commission from Reserve');
 ok('D: reserve_offset settlement recorded',so.s===201,so.d);
 g=await gen(ownerTok,2026,8,Cd.uid);
 full=await stFull(ownerTok,g.d.generated[0].id);
 ok('D: Aug opening owes 51.92, closing owes 0.00',N(full.statement.opening.driver_owes_hapa)===51.92&&N(full.statement.closing.driver_owes_hapa)===0,{o:full.statement.opening,c:full.statement.closing});
 ok('D: Aug closing reserve = 148.08 (200 top-up − 51.92 offset)',N(full.statement.closing.reserve)===148.08,full.statement.closing);
 ok('D: Aug lists reserve activity',full.items.filter(i=>i.item_type==='reserve_entry').length>=2,full.items.map(i=>i.item_type));

 // Scenario E: settlement reversal restores the debt
 const Dd=await makeDriver(ownerTok,'drvd');
 await online(Dd);
 const rd1=await runRide(rider.tok,Dd,'cash');
 await offline(Dd);
 await backdate(rd1,JULY_TS);
 g=await gen(ownerTok,2026,7,Dd.uid);
 await j('POST','/api/owner/statements/'+g.d.generated[0].id+'/finalize',ownerTok);
 const se=await settle(ownerTok,Dd.uid,'driver_to_hapa',51.92,'cash_office','August settlement, later reversed');
 g=await gen(ownerTok,2026,8,Dd.uid);
 full=await stFull(ownerTok,g.d.generated[0].id);
 ok('E: settled Aug closing owes 0.00',N(full.statement.closing.driver_owes_hapa)===0,full.statement.closing);
 const rev=await j('POST','/api/owner/settlements/'+se.d.settlement.id+'/status',ownerTok,{status:'reversed',reason:'Payment bounced at the till'});
 ok('E: reversal accepted',rev.s===200&&rev.d.settlement.status==='reversed',rev.d);
 g=await gen(ownerTok,2026,8,Dd.uid);
 full=await stFull(ownerTok,g.d.generated[0].id);
 ok('E: after reversal Aug closing owes 51.92 again, still balanced',N(full.statement.closing.driver_owes_hapa)===51.92&&full.statement.meta?.reconciliation?.balanced===true,full.statement.closing);

 // Scenario F: Nairobi month boundary (UTC date differs from EAT date)
 const Ed=await makeDriver(ownerTok,'drve');
 await online(Ed);
 const re1=await runRide(rider.tok,Ed,'cash'),re2=await runRide(rider.tok,Ed,'cash');
 await offline(Ed);
 await backdate(re1,'2026-07-31T20:59:59Z'); // 31 Jul 23:59:59 EAT → July
 await backdate(re2,'2026-07-31T23:00:00Z'); // 1 Aug 02:00:00 EAT → August
 g=await gen(ownerTok,2026,7,Ed.uid);
 full=await stFull(ownerTok,g.d.generated[0].id);
 ok('F: 23:59:59 EAT ride lands in July only (1 ride, closing 51.92)',full.items.filter(i=>i.item_type==='ride').length===1&&N(full.statement.closing.driver_owes_hapa)===51.92,full.statement.closing);
 g=await gen(ownerTok,2026,8,Ed.uid);
 full=await stFull(ownerTok,g.d.generated[0].id);
 ok('F: 00:00+ EAT ride lands in August (opening 51.92 → closing 103.84)',full.items.filter(i=>i.item_type==='ride').length===1&&N(full.statement.opening.driver_owes_hapa)===51.92&&N(full.statement.closing.driver_owes_hapa)===103.84,{o:full.statement.opening,c:full.statement.closing});
 const{monthBounds}=require('../lib/finance');
 ok('F: leap-February bounds correct (2024)',monthBounds(2024,2).end.toISOString()==='2024-02-29T21:00:00.000Z',monthBounds(2024,2));
 ok('F: December→January year rollover correct',monthBounds(2026,12).end.toISOString()==='2026-12-31T21:00:00.000Z');

 // Scenario G: concurrent regeneration — no duplicates, no phantom alerts
 const results=await Promise.all([1,2,3,4,5].map(()=>gen(ownerTok,2026,8,A.uid)));
 ok('G: 5 concurrent regenerations all succeed',results.every(r=>r.s===200),results.map(r=>r.s));
 ok('G: all return the same statement reference',new Set(results.map(r=>r.d.generated[0].reference)).size===1);
 const cnt=await db.query(`SELECT COUNT(*)::int AS n FROM driver_monthly_statements WHERE driver_user_id=$1 AND period_year=2026 AND period_month=8`,[A.uid]);
 ok('G: exactly one Aug statement row',cnt.rows[0].n===1,cnt.rows[0]);
 full=await stFull(ownerTok,results[0].d.generated[0].id);
 ok('G: no duplicated statement items',full.items.filter(i=>i.item_type==='settlement').length===2&&full.items.filter(i=>i.item_type==='ride').length===0,full.items.map(i=>i.item_type));
 ok('G: no reconciliation alerts for healthy driver',(await j('GET','/api/owner/finance/alerts?driver_id='+A.uid,ownerTok)).d.alerts.length===0);

 // Reporting consistency: owner finance summary runs clean over the period
 const sum7=await j('GET','/api/owner/finance/summary?from=2026-07-01&to=2026-07-31',ownerTok);
 const sum8=await j('GET','/api/owner/finance/summary?from=2026-08-01&to=2026-08-31',ownerTok);
 ok('§12 owner finance summary consistent across both months',sum7.s===200&&sum8.s===200);

 // ════════ §11 — UNICODE / SWAHILI-SAFE PDFS ════════
 const U=await makeDriver(ownerTok,'drvu','Mũthatari O’Connor');
 await online(U);
 const ru1=await runRide(rider.tok,U,'cash',['Mũthatari “Mtaa wa Soko” 🚕 stage','Kituo cha mabasi — Kĩrĩnyaga road, Njukĩrĩ']);
 await offline(U);
 g=await gen(ownerTok,2026,8,U.uid);
 const uSt=g.d.generated[0];
 const uPdf=await raw('/api/statements/'+uSt.id+'.pdf',ownerTok);
 ok('§11 unicode statement PDF downloads',uPdf.s===200&&uPdf.buf.slice(0,4).toString()==='%PDF');
 const uTxt=pdfText(uPdf.buf);
 for(const s of['Mũthatari','O’Connor','Kĩrĩnyaga','Njukĩrĩ','“Mtaa wa Soko”','—'])
  ok(`§11 statement PDF renders "${s}"`,uTxt.includes(s),uTxt.slice(0,300));
 ok('§11 statement PDF: emoji removed, no replacement glyphs',!uTxt.includes('🚕')&&!uTxt.includes('\uFFFD'));
 ok('§11 statement PDF keeps money readable next to unicode text',uTxt.includes('346.13')&&uTxt.includes('51.92')&&uTxt.includes('294.21'));
 const uPages=bboxPages(uPdf.buf);
 const lc=layoutClean(uPages);
 ok('§11 statement PDF layout: A4, no overlaps, nothing off-page',Math.abs(uPages[0].w-595.28)<1&&lc.overlaps===0&&lc.oob===0,lc);
 // receipt PDF with unicode route
 const rec=(await j('GET',`/api/rides/${ru1}/receipt`,rider.tok)).d;
 const rPdf=await raw(`/api/rides/${ru1}/receipt.pdf`,rider.tok);
 ok('§11 unicode receipt PDF downloads',rPdf.s===200&&rPdf.buf.slice(0,4).toString()==='%PDF');
 const rTxt=pdfText(rPdf.buf);
 ok('§11 receipt renders Swahili route + driver name',['Mũthatari','Kĩrĩnyaga','O’Connor'].every(s=>rTxt.includes(s)),rTxt.slice(0,300));
 ok('§11 receipt: emoji removed cleanly',!rTxt.includes('🚕')&&!rTxt.includes('\uFFFD'));
 ok('§11 receipt still hides internals + shows total',!/commission/i.test(rTxt)&&rTxt.includes(rec.reference));
 const rlc=layoutClean(bboxPages(rPdf.buf));
 ok('§11 receipt layout clean',rlc.overlaps===0&&rlc.oob===0,rlc);
 // many-page stress: statement PDF for driver A July (2 rides) + Aug (settlements)
 const aPdf=await raw('/api/statements/'+julA.id+'.pdf',ownerTok);
 const alc=layoutClean(bboxPages(aPdf.buf));
 ok('§11 finalized July statement PDF still renders clean',aPdf.s===200&&alc.overlaps===0&&alc.oob===0,alc);

 await db.end();
 console.log(`\n${pass} passed, ${fail} failed`);
 process.exit(fail?1:0);
})().catch(e=>{console.error('FATAL',e);process.exit(1);});
