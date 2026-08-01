// Statement quality: accounting reconciliation (opening + movements = closing),
// PDF visual-layout verification via poppler (pdftotext -bbox): no overlapping
// word bounding boxes, nothing outside page bounds, required strings present,
// ride lines exactly once, humanized status, and API/PDF/CSV total consistency.
// Usage: TEST_OWNER_EMAIL=.. TEST_OWNER_PASSWORD=.. node tests/statement-quality.test.js [baseUrl]
const{execFileSync}=require('child_process');
const fs=require('fs');
const B=process.argv[2]||'http://127.0.0.1:5000';
const OWNER_EMAIL=process.env.TEST_OWNER_EMAIL,OWNER_PASSWORD=process.env.TEST_OWNER_PASSWORD;
const RUN='sq'+Date.now().toString(36);
const PW='TestPass2026x!';
const PICKUP={lat:-0.5310,lng:37.4575},DEST={lat:-0.4990,lng:37.4600};
const DIST_M=4922,DUR_S=591; // => 346.13 / 51.92 / 294.21

let pass=0,fail=0;
const ok=(n,c,x)=>{if(c){pass++;console.log('PASS',n)}else{fail++;console.log('FAIL',n,x!==undefined?JSON.stringify(x).slice(0,300):'')}};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const j=async(m,p,t,b)=>{const r=await fetch(B+p,{method:m,headers:{'Content-Type':'application/json',...(t?{Authorization:'Bearer '+t}:{})},body:b?JSON.stringify(b):undefined});return{s:r.status,d:await r.json().catch(()=>({}))}};

async function makeUser(ownerTok,label,capType,details){
 const em=`${RUN}.${label}@example.com`;
 const reg=await j('POST','/api/auth/register',null,{name:'SQ '+label,email:em,password:PW,selfie:'data:image/png;base64,iVBORw0KGgo='});
 if(reg.s!==201)throw new Error('register failed '+JSON.stringify(reg.d));
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
async function makeDriver(ownerTok,label){
 const d=await makeUser(ownerTok,label,'driver',{fullName:'SQ '+label,drivingLicenceNumber:'DL-'+RUN+label,vehicleType:'Boda Boda',registrationNumber:'K'+label.toUpperCase()+' 6'+RUN.slice(-2).toUpperCase(),county:'Embu'});
 await j('POST','/api/me/driver-profile',d.tok);
 const veh=await j('POST','/api/me/vehicles',d.tok,{category:'Passenger Car',make:'Toyota',model:'Vitz',colour:'Blue',registration_number:'KG'+label.slice(-1).toUpperCase()+' '+Math.floor(Math.random()*900+100)+'Y'});
 await j('PATCH','/api/owner/vehicles/'+veh.d.id,ownerTok,{status:'approved'});
 for(const t of DOCS){const doc=await j('POST','/api/me/driver-documents',d.tok,{doc_type:t,reference:'REF-'+t,expires_on:'2027-12-31'});await j('PATCH','/api/owner/driver-documents/'+doc.d.id,ownerTok,{status:'approved'});}
 await j('POST','/api/me/operating-zones',d.tok,{zone:'zone-embu-pilot'});
 await j('POST','/api/agreements/accept',d.tok,{agreement:'driver_agreement'});
 return{...d,vehicleId:veh.d.id};
}
async function runRide(riderTok,drvTok,pay){
 const q1=await j('POST','/api/rides/quote',riderTok,{pickup_lat:PICKUP.lat,pickup_lng:PICKUP.lng,dest_lat:DEST.lat,dest_lng:DEST.lng,zone:'zone-embu-pilot',vehicle_category:'Passenger Car',distance_m:DIST_M,duration_s:DUR_S});
 const r1=await j('POST','/api/rides',riderTok,{quote_id:q1.d.quote.id,payment_method:pay,pickup_lat:PICKUP.lat,pickup_lng:PICKUP.lng,dest_lat:DEST.lat,dest_lng:DEST.lng,pickup_address:'Embu Town CBD',dest_address:'Kangaru School gate'});
 const rideId=r1.d.ride.id,pin=r1.d.pin;
 let offer=null;
 for(let i=0;i<40&&!offer;i++){offer=(await j('GET','/api/driver/hub',drvTok)).d.offer;if(!offer)await sleep(1000);}
 if(!offer)throw new Error('no offer');
 await j('POST','/api/offers/'+offer.id+'/accept',drvTok);
 await j('POST',`/api/rides/${rideId}/arrived`,drvTok);
 await j('POST',`/api/rides/${rideId}/verify-pin`,drvTok,{pin});
 await j('POST',`/api/rides/${rideId}/start`,drvTok);
 await sleep(1200);
 await j('POST',`/api/rides/${rideId}/complete`,drvTok);
 if(pay==='cash')await j('POST',`/api/rides/${rideId}/cash-collected`,drvTok);
 return rideId;
}
function bboxWords(pdfPath){
 execFileSync('pdftotext',['-bbox',pdfPath,'/tmp/sq-bbox.html']);
 const h=fs.readFileSync('/tmp/sq-bbox.html','utf8');
 const pages=h.split('<page ').slice(1);
 return pages.map(p=>{
  const dims=/width="([\d.]+)" height="([\d.]+)"/.exec(p);
  const words=[...p.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g)]
   .map(m=>({x1:+m[1],y1:+m[2],x2:+m[3],y2:+m[4],t:m[5]}));
  return{w:+dims[1],h:+dims[2],words};
 });
}

(async()=>{
 if(!OWNER_EMAIL||!OWNER_PASSWORD){console.error('owner creds required');process.exit(1);}
 const ownerTok=(await j('POST','/api/auth/login',null,{identifier:OWNER_EMAIL,password:OWNER_PASSWORD})).d.token;
 await j('PATCH','/api/owner/compliance/offer_timeout_s',ownerTok,{value:3});
 await j('POST','/api/owner/fare-cards',ownerTok,{area:'zone-embu-pilot',vehicle_category:'Passenger Car',base_fare:100,per_km:40,per_min:5,minimum_fare:150});
 const rider=await makeUser(ownerTok,'rider');
 await j('POST','/api/agreements/accept',rider.tok,{agreement:'rider_terms'});
 const drv=await makeDriver(ownerTok,'drv');
 await j('POST','/api/driver/online',drv.tok,{zone:'zone-embu-pilot',vehicle_id:drv.vehicleId});
 await j('POST','/api/driver/location',drv.tok,{lat:PICKUP.lat+0.001,lng:PICKUP.lng,seq:1,accuracy:8});

 // one cash ride, then two (single-ride numbers checked first)
 await runRide(rider.tok,drv.tok,'cash');
 const now=new Date(Date.now()+3*3600*1000);const y=now.getUTCFullYear(),m=now.getUTCMonth()+1;
 let gen=await j('POST','/api/owner/statements/generate',ownerTok,{year:y,month:m,driver_id:drv.uid});
 ok('statement generated for one ride',gen.s===200,gen.d);
 let st=gen.d.generated[0];
 let full=(await j('GET','/api/statements/'+st.id,ownerTok)).d;
 ok('one ride: closing Driver owes HAPA = 51.92',Number(full.statement.closing.driver_owes_hapa)===51.92,full.statement.closing);
 ok('one ride: HAPA owes Driver = 0.00',Number(full.statement.closing.hapa_owes_driver)===0);
 ok('reconciliation recorded as balanced',full.statement.meta?.reconciliation?.balanced===true,full.statement.meta);

 await runRide(rider.tok,drv.tok,'cash');
 gen=await j('POST','/api/owner/statements/generate',ownerTok,{year:y,month:m,driver_id:drv.uid});
 ok('regeneration reuses reference (idempotent)',gen.d.generated[0].reference===st.reference);
 full=(await j('GET','/api/statements/'+gen.d.generated[0].id,ownerTok)).d;
 const stm=full.statement,sum=stm.summary,close=stm.closing;
 ok('two rides: gross 692.26 / commission 103.84 / net 588.42',Number(sum.gross)===692.26&&Number(sum.commission)===103.84&&Number(sum.net)===588.42,sum);
 ok('two rides: closing owes 103.84 / owed 0.00 / reserve 0.00',Number(close.driver_owes_hapa)===103.84&&Number(close.hapa_owes_driver)===0&&Number(close.reserve)===0,close);
 ok('closing matches live receivables',Number((await j('GET','/api/driver/finance',drv.tok)).d.balances.driver_owes_hapa)===103.84);
 ok('summary outstanding equals closing owes',Number(sum.outstanding)===103.84,sum.outstanding);
 ok('API exposes humanized status',full.status_label==='Ready for review'||full.status_label==='Open',full.status_label);
 ok('statement meta has zones + vehicles + account ref',(stm.meta.zones||[]).length>=1&&(stm.meta.vehicles||[]).length>=1&&/^DRV-/.test(stm.meta.driver_account_reference||''),stm.meta);

 // ── PDF: fetch, verify geometry with poppler ────────────────────────────────
 const pdfR=await fetch(B+`/api/statements/${stm.id}.pdf`,{headers:{Authorization:'Bearer '+ownerTok}});
 const pdfBytes=Buffer.from(await pdfR.arrayBuffer());
 fs.writeFileSync('/tmp/sq-stmt.pdf',pdfBytes);
 ok('PDF downloads (%PDF)',pdfR.status===200&&pdfBytes.slice(0,4).toString()==='%PDF');
 const pages=bboxWords('/tmp/sq-stmt.pdf');
 ok('PDF page size is A4 portrait',Math.abs(pages[0].w-595.28)<1&&Math.abs(pages[0].h-841.89)<1,{w:pages[0].w,h:pages[0].h});
 let overlaps=0,oob=0;
 for(const p of pages){
  for(let i=0;i<p.words.length;i++){
   const a=p.words[i];
   if(a.x2>p.w+0.5||a.y2>p.h+0.5||a.x1<-0.5||a.y1<-0.5)oob++;
   for(let k=i+1;k<p.words.length;k++){
    const b=p.words[k];
    const ix=Math.min(a.x2,b.x2)-Math.max(a.x1,b.x1),iy=Math.min(a.y2,b.y2)-Math.max(a.y1,b.y1);
    if(ix>1&&iy>2)overlaps++;
   }
  }
 }
 ok('PDF: zero overlapping word bounding boxes',overlaps===0,{overlaps});
 ok('PDF: nothing outside page bounds',oob===0,{oob});
 const txt=pages.map(p=>p.words.map(w=>w.t).join(' ')).join(' ');
 const expectedLabel=stm.status==='ready_for_review'?'Ready for review':stm.status.charAt(0).toUpperCase()+stm.status.slice(1).replace(/_/g,' ');
 for(const s of[stm.reference,expectedLabel,'103.84','692.26','588.42','346.13','51.92','294.21','Kangaru School gate','Embu Town CBD','not a tax invoice','OPENING','CLOSING','Africa/Nairobi'])
  ok(`PDF contains "${s.slice(0,26)}"`,txt.includes(s),s);
 ok('PDF has no raw ready_for_review status',!txt.includes('ready_for_review'));
 const rideCount=(txt.match(/Embu Town CBD to Kangaru School gate/g)||[]).length;
 ok('each ride line appears exactly once',rideCount===2,{rideCount});
 const closingOwes=(txt.match(/103\.84/g)||[]).length;
 ok('totals present, not duplicated wildly',closingOwes>=2&&closingOwes<=6,{closingOwes});

 // ── CSV: identical totals + safety ──────────────────────────────────────────
 const csvR=await fetch(B+`/api/statements/${stm.id}.csv`,{headers:{Authorization:'Bearer '+ownerTok}});
 const csv=Buffer.from(await csvR.arrayBuffer()).toString();
 ok('CSV totals match (692.26/103.84/588.42, closing 103.84)',csv.includes('692.26')&&csv.includes('103.84')&&csv.includes('588.42'));
 ok('CSV has opening + closing rows',/Opening balances/.test(csv)&&/Closing balances/.test(csv));
 ok('CSV has no GPS coordinates',!/-0\.53|37\.45/.test(csv));
 ok('CSV humanizes statuses',!/ready_for_review/.test(csv));
 ok('CSV blocked for other users',(await j('GET',`/api/statements/${stm.id}.csv`,rider.tok)).s===403);
 ok('PDF blocked for other users',(await j('GET',`/api/statements/${stm.id}.pdf`,rider.tok)).s===403);

 console.log(`\n${pass} passed, ${fail} failed`);
 process.exit(fail?1:0);
})().catch(e=>{console.error('FATAL',e);process.exit(1);});
