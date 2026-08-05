// HAPA driver monthly statement PDF — pdfkit + embedded (subset) DejaVu Sans,
// multi-page A4 portrait. Layout: one structured card per ride (guarantees
// readability with long Kenyan names, routes and references). Text is
// measured with real font metrics, so nothing overlaps and right-aligned KES
// values line up. "Driver earnings statement — not a tax invoice."
// Never recomputes money: the statement row (opening/closing/summary JSON)
// is the source of truth.
//
// UNICODE POLICY: see lib/receipt-pdf.js — DejaVu Sans (licence committed at
// fonts/DEJAVU-LICENSE.txt) is embedded/subset, Swahili & Latin Extended text
// renders natively, emoji are deterministically removed via pdfSafe.
'use strict';
const path=require('path');
const PDFDocument=require('pdfkit');
const{moneyKES,pdfSafe}=require('./receipt-pdf');

const FONT_REG=path.join(__dirname,'..','fonts','DejaVuSans.ttf');
const FONT_BOLD=path.join(__dirname,'..','fonts','DejaVuSans-Bold.ttf');

const PAGE_W=595.28,PAGE_H=841.89,M=44;              // A4 portrait, 44pt margins
const NAVY='#101C2C',AMBER='#F5A623',INK='#172033',MUTED='#667085',
      LINE='#D6DDE7',CARD='#F7F9FC',WHITE='#FFFFFF',PALE='#D9E0EB';
const MONTHS=['January','February','March','April','May','June','July','August','September','October','November','December'];

const HUMAN={ready_for_review:'Ready for review',open:'Open',finalized:'Finalized',disputed:'Disputed',settled:'Settled',
 partially_settled:'Partially settled',unsettled:'Unsettled',completed:'Completed',closed:'Completed and closed',
 completed_and_closed:'Completed and closed',reversed:'Reversed',pending:'Pending',confirmed:'Confirmed',declared:'Declared'};
const human=s=>HUMAN[String(s||'')]||String(s||'').replace(/_/g,' ').replace(/^./,c=>c.toUpperCase());

function buildStatementPdf(st,driverName,items,meta){
 meta=meta||st.meta||{};
 const doc=new PDFDocument({size:[PAGE_W,PAGE_H],margin:0,autoFirstPage:true,
  info:{Title:'HAPA driver statement '+st.reference,Author:'HAPA',
   CreationDate:new Date(st.issued_at||st.updated_at||0)}});
 doc.registerFont('R',FONT_REG);doc.registerFont('B',FONT_BOLD);
 const chunks=[];doc.on('data',c=>chunks.push(c));
 const done=new Promise((resolve,reject)=>{doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject)});

 let y=0,pageNo=0;
 const period=`${MONTHS[st.period_month-1]} ${st.period_year}`;
 const nrb=(d,withTime)=>{try{return new Intl.DateTimeFormat('en-KE',{timeZone:'Africa/Nairobi',day:'2-digit',month:'short',year:'numeric',...(withTime?{hour:'2-digit',minute:'2-digit',hour12:false}:{})}).format(new Date(d))}catch{return ''}};
 const nrbT=d=>{try{return new Intl.DateTimeFormat('en-KE',{timeZone:'Africa/Nairobi',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(d))}catch{return ''}};

 const textW=(s,size,bold)=>doc.font(bold?'B':'R').fontSize(size).widthOfString(pdfSafe(s));
 const rect=(x,yy,w,h,c)=>doc.rect(x,PAGE_H-yy-h,w,h).fill(c);
 const box=(x,yy,w,h,c)=>doc.rect(x,PAGE_H-yy-h,w,h).lineWidth(0.9).strokeColor(c).stroke();
 const hline=(x1,x2,yy)=>doc.moveTo(x1,PAGE_H-yy).lineTo(x2,PAGE_H-yy).lineWidth(0.75).strokeColor(LINE).stroke();
 const text=(x,yy,s,{size=9.5,bold=false,color=INK}={})=>
  doc.font(bold?'B':'R').fontSize(size).fillColor(color).text(pdfSafe(s),x,PAGE_H-yy,{baseline:'alphabetic',lineBreak:false});
 const textR=(xr,yy,s,opt={})=>text(xr-textW(s,opt.size||9.5,!!opt.bold),yy,s,opt);
 const L=M,R=PAGE_W-M,CW=R-L;

 function wrap(s,size,bold,maxW){
  const words=pdfSafe(s).split(/\s+/).filter(Boolean);const lines=[];let cur='';
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

 function footer(){
  hline(L,R,52);
  text(L,40,'Driver earnings statement - not a tax invoice. HAPA - Embu, Kenya.',{size:8.5,color:MUTED});
  textR(R,40,`Page ${pageNo}`,{size:8.5,color:MUTED});
 }
 function header(first){
  pageNo++;
  const bandH=first?96:64;
  rect(0,PAGE_H-bandH,PAGE_W,bandH,NAVY);rect(0,PAGE_H-bandH-4,PAGE_W,4,AMBER);
  text(L,PAGE_H-40,'HAPA',{size:20,bold:true,color:WHITE});
  text(L,PAGE_H-56,'Driver earnings statement - not a tax invoice',{size:9.5,color:PALE});
  textR(R,PAGE_H-40,st.reference,{size:12,bold:true,color:WHITE});
  textR(R,PAGE_H-56,period+'   Timezone: Africa/Nairobi',{size:9.5,color:PALE});
  if(first){
   text(L,PAGE_H-78,`Driver: ${driverName||''}`,{size:10,bold:true,color:WHITE});
   textR(R,PAGE_H-78,`Status: ${human(st.status)}`,{size:10,bold:true,color:AMBER});
  }
  y=PAGE_H-bandH-24;
 }
 function newPage(){footer();doc.addPage();header(false)}
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

 footer();
 doc.end();
 return done;
}
module.exports={buildStatementPdf,human};
