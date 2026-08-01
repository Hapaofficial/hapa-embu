// HAPA driver monthly statement PDF — dependency-free, multi-page A4 portrait.
// Layout: one structured card per ride (guarantees readability with long
// Kenyan names, routes and references). Text is measured with real Helvetica
// AFM widths, so nothing overlaps and right-aligned KES values line up.
// "Driver earnings statement — not a tax invoice." Never recomputes money:
// the statement row (opening/closing/summary JSON) is the source of truth.
'use strict';
const{moneyKES}=require('./receipt-pdf');

const PAGE_W=595.28,PAGE_H=841.89,M=44;              // A4 portrait, 44pt margins
const NAVY='0.063 0.110 0.173',AMBER='0.961 0.651 0.137',INK='0.090 0.125 0.200',
      MUTED='0.400 0.439 0.522',LINE='0.839 0.867 0.906',CARD='0.969 0.976 0.988';
const MONTHS=['January','February','March','April','May','June','July','August','September','October','November','December'];

// Real Helvetica / Helvetica-Bold advance widths (1000-unit em) for chars 32..126.
const W_REG=[278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const W_BOLD=[278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];
function textW(s,size,bold){
 const t=String(s==null?'':s);const w=bold?W_BOLD:W_REG;let u=0;
 for(let i=0;i<t.length;i++){const c=t.charCodeAt(i);u+=(c>=32&&c<=126)?w[c-32]:556;}
 return u*size/1000;
}
const sanitize=s=>String(s==null?'':s).replace(/[\u2192\u2794\u27A1]/g,'to').replace(/[\u2018\u2019]/g,"'").replace(/[\u201C\u201D]/g,'"').replace(/\u00B7/g,'-').replace(/[\u2013\u2014]/g,'-').split('').map(c=>c.charCodeAt(0)>126?'?':c).join('');
const esc=s=>sanitize(s).replace(/\\/g,'\\\\').replace(/\(/g,'\\(').replace(/\)/g,'\\)');
function wrap(s,size,bold,maxW){
 const words=sanitize(s).split(/\s+/).filter(Boolean);const lines=[];let cur='';
 for(const w of words){
  const cand=cur?cur+' '+w:w;
  if(textW(cand,size,bold)<=maxW)cur=cand;
  else{
   if(cur)lines.push(cur);
   if(textW(w,size,bold)<=maxW)cur=w;
   else{let piece='';for(const ch of w){if(textW(piece+ch,size,bold)>maxW){lines.push(piece);piece=ch}else piece+=ch}cur=piece}
  }
 }
 if(cur)lines.push(cur);
 return lines.length?lines:[''];
}
const HUMAN={ready_for_review:'Ready for review',open:'Open',finalized:'Finalized',disputed:'Disputed',settled:'Settled',
 partially_settled:'Partially settled',unsettled:'Unsettled',completed:'Completed',closed:'Completed and closed',
 completed_and_closed:'Completed and closed',reversed:'Reversed',pending:'Pending',confirmed:'Confirmed',declared:'Declared'};
const human=s=>HUMAN[String(s||'')]||String(s||'').replace(/_/g,' ').replace(/^./,c=>c.toUpperCase());

function buildStatementPdf(st,driverName,items,meta){
 meta=meta||st.meta||{};
 const pages=[];let ops=[];let y=0;let pageNo=0;
 const period=`${MONTHS[st.period_month-1]} ${st.period_year}`;
 const nrb=(d,withTime)=>{try{return new Intl.DateTimeFormat('en-KE',{timeZone:'Africa/Nairobi',day:'2-digit',month:'short',year:'numeric',...(withTime?{hour:'2-digit',minute:'2-digit',hour12:false}:{})}).format(new Date(d))}catch{return ''}};
 const nrbT=d=>{try{return new Intl.DateTimeFormat('en-KE',{timeZone:'Africa/Nairobi',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(d))}catch{return ''}};

 const rect=(x,yy,w,h,c)=>ops.push(`${c} rg ${x.toFixed(2)} ${yy.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`);
 const box=(x,yy,w,h,c)=>ops.push(`${c} RG 0.9 w ${x.toFixed(2)} ${yy.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re S`);
 const hline=(x1,x2,yy)=>ops.push(`${LINE} RG 0.75 w ${x1.toFixed(2)} ${yy.toFixed(2)} m ${x2.toFixed(2)} ${yy.toFixed(2)} l S`);
 const text=(x,yy,s,{size=9.5,bold=false,color=INK}={})=>ops.push(`BT ${color} rg /${bold?'F2':'F1'} ${size} Tf ${x.toFixed(2)} ${yy.toFixed(2)} Td (${esc(s)}) Tj ET`);
 const textR=(xr,yy,s,opt={})=>text(xr-textW(sanitize(s),opt.size||9.5,!!opt.bold),yy,s,opt);
 const L=M,R=PAGE_W-M,CW=R-L;

 function footer(){
  hline(L,R,52);
  text(L,40,'Driver earnings statement - not a tax invoice. HAPA - Embu, Kenya.',{size:8.5,color:MUTED});
  textR(R,40,`Page ${pageNo}`,{size:8.5,color:MUTED});
 }
 function header(first){
  pageNo++;
  const bandH=first?96:64;
  rect(0,PAGE_H-bandH,PAGE_W,bandH,NAVY);rect(0,PAGE_H-bandH-4,PAGE_W,4,AMBER);
  text(L,PAGE_H-40,'HAPA',{size:20,bold:true,color:'1 1 1'});
  text(L,PAGE_H-56,'Driver earnings statement - not a tax invoice',{size:9.5,color:'0.85 0.88 0.92'});
  textR(R,PAGE_H-40,st.reference,{size:12,bold:true,color:'1 1 1'});
  textR(R,PAGE_H-56,period+'   Timezone: Africa/Nairobi',{size:9.5,color:'0.85 0.88 0.92'});
  if(first){
   text(L,PAGE_H-78,`Driver: ${driverName||''}`,{size:10,bold:true,color:'1 1 1'});
   textR(R,PAGE_H-78,`Status: ${human(st.status)}`,{size:10,bold:true,color:AMBER});
  }
  y=PAGE_H-bandH-24;
 }
 function newPage(){footer();pages.push(ops.join('\n'));ops=[];header(false)}
 const ensure=h=>{if(y-h<64)newPage()};
 header(true);

 // ── Statement details block ─────────────────────────────────────────────────
 const issued=st.issued_at||st.updated_at||new Date().toISOString();
 const details=[
  ['Statement reference',st.reference],['Driver',driverName||''],
  ['Driver account reference',meta.driver_account_reference||''],
  ['Statement period',period+' (Africa/Nairobi)'],
  ['Issued',nrb(issued,true)+' EAT'],['Status',human(st.status)],
  ['Service zone(s)',(meta.zones&&meta.zones.length?meta.zones.join(', '):'Embu')],
  ['Vehicle(s) used',(meta.vehicles&&meta.vehicles.length?meta.vehicles.join(', '):'-')]
 ];
 for(const[k,v]of details){ensure(15);text(L,y,k,{size:9.5,color:MUTED});text(L+150,y,String(v),{size:9.5,bold:k==='Statement reference'});y-=14}
 y-=6;

 const opening=st.opening||{},closing=st.closing||{},sum=st.summary||{};
 const BAL=[['driver_owes_hapa','Driver owes HAPA'],['hapa_owes_driver','HAPA owes Driver (pending Driver payout)'],['reserve','Commission Reserve balance']];
 function balances(title,src,boldVals){
  ensure(76);text(L,y,title,{size:11,bold:true,color:MUTED});y-=8;hline(L,R,y);y-=16;
  for(const[k,label]of BAL){text(L,y,label,{bold:!!boldVals});textR(R,y,moneyKES(src[k]||0),{bold:!!boldVals});y-=15}
  y-=8;
 }
 balances('OPENING BALANCES',opening,false);

 // ── Ride cards ──────────────────────────────────────────────────────────────
 ensure(30);text(L,y,'RIDES THIS PERIOD',{size:11,bold:true,color:MUTED});y-=8;hline(L,R,y);y-=16;
 const rideItems=(items||[]).filter(i=>i.item_type==='ride');
 if(!rideItems.length){text(L,y,'No completed rides this month.',{color:MUTED});y-=16}
 for(const it of rideItems){
  const d=it.data||{};
  const routeLines=wrap(`${d.pickup_label||''}  to  ${d.dest_label||''}`,9.5,true,CW-24);
  const owes=d.payment_method==='cash'?(d.receivable_amount||d.commission_amount):'0',
        owed=d.payment_method==='cash'?'0':(d.payable_amount||d.net_earnings);
  const settle=d.payment_method==='cash'
   ?(d.receivable_status?human(d.receivable_status):'Unsettled')
   :(d.payable_status?human(d.payable_status):'Unsettled');
  const cardH=24+routeLines.length*13+13+34+15+10;
  ensure(cardH+10);
  const top=y+10;
  rect(L,top-cardH,CW,cardH,CARD);box(L,top-cardH,CW,cardH,LINE);
  let cy=top-16;const IX=L+12,IR=R-12;
  text(IX,cy,nrb(d.completed_at,true)+' EAT',{size:9.5,bold:true});
  textR(IR,cy,`${d.ride_reference||''}${d.receipt_reference?'   Receipt: '+d.receipt_reference:''}`,{size:9,color:MUTED});
  cy-=14;
  for(const ln of routeLines){text(IX,cy,ln,{size:9.5,bold:true});cy-=13}
  const meta1=[
   d.requested_at?`Requested ${nrbT(d.requested_at)}`:null,d.accepted_at?`Accepted ${nrbT(d.accepted_at)}`:null,
   d.started_at?`Started ${nrbT(d.started_at)}`:null,d.completed_at?`Completed ${nrbT(d.completed_at)}`:null,
   d.distance_m?`${(d.distance_m/1000).toFixed(1)} km`:null,
   d.actual_duration_s!=null?`${Math.floor(d.actual_duration_s/60)} min ${d.actual_duration_s%60} s`:null,
   d.vehicle_registration?`Vehicle ${d.vehicle_registration}`:null
  ].filter(Boolean).join('   ');
  text(IX,cy,meta1,{size:9,color:MUTED});cy-=15;
  // money row: four measured columns, labels above right-aligned values
  const colW=(CW-24)/4;
  const cols=[['Gross fare',d.gross_fare],['Driver fare earnings',d.net_earnings],['HAPA commission',d.commission_amount],
   ['Tip'+(d.tip_method==='cash'?' (cash, declared)':d.tip_method?' (M-Pesa)':''),d.tip_amount||0]];
  cols.forEach(([lab,v],i)=>{
   const cx=IX+i*colW;
   text(cx,cy,lab,{size:8.5,color:MUTED});
   text(cx,cy-12,moneyKES(v),{size:9.5,bold:true});
  });
  cy-=27;
  const payLab=`${d.payment_method==='cash'?'Cash - collected by Driver':'M-Pesa - collected by HAPA'}   Driver owes HAPA ${moneyKES(owes)}   HAPA owes Driver ${moneyKES(owed)}   Settlement: ${settle}`;
  text(IX,cy,payLab,{size:9,color:MUTED});
  y=top-cardH-10;
 }

 // ── Reserve + settlement activity ───────────────────────────────────────────
 const sections=[['reserve_entry','COMMISSION RESERVE ACTIVITY'],['settlement','SETTLEMENT ACTIVITY']];
 for(const[type,title]of sections){
  const list=(items||[]).filter(i=>i.item_type===type);
  ensure(48);y-=4;text(L,y,title,{size:11,bold:true,color:MUTED});y-=8;hline(L,R,y);y-=16;
  if(!list.length){text(L,y,'None this month.',{color:MUTED});y-=16;continue}
  for(const it of list){
   ensure(16);const d=it.data||{};
   let label;
   if(type==='reserve_entry')label=`${human(d.entry_type)}  -  running Reserve balance ${moneyKES(d.balance_after)}`;
   else label=`${d.direction==='driver_to_hapa'?'Driver paid HAPA':'HAPA paid Driver'} (${human(d.method)})${d.external_ref?'  Ext: '+d.external_ref:''}  -  ${human(d.status)}`;
   text(L,y,nrb(d.created_at||d.completed_at),{size:9});
   text(L+86,y,String(it.reference||''),{size:9});
   const labMax=R-90-(L+210);
   text(L+210,y,wrap(label,9,false,labMax)[0],{size:9});
   textR(R,y,moneyKES(d.amount),{size:9.5,bold:true});
   y-=14;
  }
  y-=4;
 }

 // ── Summary ─────────────────────────────────────────────────────────────────
 ensure(40);y-=4;text(L,y,'SUMMARY',{size:11,bold:true,color:MUTED});y-=8;hline(L,R,y);y-=16;
 const S=[
  ['Completed rides',sum.rides,true],['Cancelled rides',sum.cancelled_rides||0,true],
  ['Gross fares',sum.gross],['Cash collected by Driver',sum.cash_gross],
  ['M-Pesa fares collected by HAPA',sum.mpesa_gross],['Driver fare earnings',sum.net],
  ['Tips through M-Pesa (100% to Driver)',sum.tips_mpesa],
  ['Cash tips declared by Rider - not collected or verified by HAPA',sum.tips_cash_declared],
  ['HAPA commission',sum.commission],['Reserve top-ups',sum.reserve_topups],
  ['Commission covered by Reserve',sum.reserve_debits],
  ['Settled: Driver to HAPA',sum.settled_to_hapa],['Settled: HAPA to Driver payouts',sum.settled_to_driver],
  ['Refunds',sum.refunds||0],['Adjustments',sum.adjustments||0],
  ['Amount settled',sum.amount_settled||sum.settled_to_hapa],['Amount outstanding (Driver owes HAPA)',sum.outstanding!=null?sum.outstanding:closing.driver_owes_hapa]
 ];
 for(const[label,v,raw]of S){ensure(15);text(L,y,label);textR(R,y,raw?String(v||0):moneyKES(v||0));y-=14}
 y-=6;
 balances('CLOSING BALANCES',closing,true);

 footer();pages.push(ops.join('\n'));

 // ── Assemble multi-page PDF ─────────────────────────────────────────────────
 const n=pages.length,objs=[];const kids=[];
 const fontA=3+2*n,fontB=fontA+1;
 for(let i=0;i<n;i++){
  const pageObj=3+2*i,contObj=4+2*i;kids.push(`${pageObj} 0 R`);
  objs[pageObj]=`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 ${fontA} 0 R /F2 ${fontB} 0 R >> >> /Contents ${contObj} 0 R >>`;
  objs[contObj]=`<< /Length ${Buffer.byteLength(pages[i],'latin1')} >>\nstream\n${pages[i]}\nendstream`;
 }
 objs[1]='<< /Type /Catalog /Pages 2 0 R >>';
 objs[2]=`<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${n} >>`;
 objs[fontA]='<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
 objs[fontB]='<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
 let out='%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';const offsets=[0];
 for(let i=1;i<objs.length;i++){offsets[i]=Buffer.byteLength(out,'latin1');out+=`${i} 0 obj\n${objs[i]}\nendobj\n`;}
 const xref=Buffer.byteLength(out,'latin1');
 out+=`xref\n0 ${objs.length}\n0000000000 65535 f \n`;
 for(let i=1;i<objs.length;i++)out+=String(offsets[i]).padStart(10,'0')+' 00000 n \n';
 out+=`trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
 return Buffer.from(out,'latin1');
}
module.exports={buildStatementPdf,human};
