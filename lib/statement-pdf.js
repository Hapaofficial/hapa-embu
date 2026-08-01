// HAPA driver monthly statement PDF — dependency-free, multi-page A4.
// "Driver earnings statement — not a tax invoice." Built from the statement
// row + items; never recomputes money (statement JSON is the source).
'use strict';
const{moneyKES}=require('./receipt-pdf');

const PAGE_W=595.28,PAGE_H=841.89;
const NAVY='0.063 0.110 0.173',AMBER='0.961 0.651 0.137',INK='0.090 0.125 0.200',MUTED='0.400 0.439 0.522',LINE='0.882 0.902 0.929';
const esc=s=>String(s==null?'':s).replace(/[\u2192\u2794\u27A1]/g,'to').replace(/[\u2018\u2019]/g,"'").replace(/[\u201C\u201D]/g,'"').replace(/\u00B7/g,'-').replace(/[\u2013\u2014]/g,'-').split('').map(c=>c.charCodeAt(0)>255?'?':c).join('').replace(/\\/g,'\\\\').replace(/\(/g,'\\(').replace(/\)/g,'\\)');
const MONTHS=['January','February','March','April','May','June','July','August','September','October','November','December'];

function buildStatementPdf(st,driverName,items){
 const pages=[];let ops=[];let y=0;
 const L=48,R=PAGE_W-48;
 const rect=(x,yy,w,h,c)=>ops.push(`${c} rg ${x} ${yy} ${w} ${h} re f`);
 const hline=(x1,x2,yy)=>ops.push(`${LINE} RG 0.75 w ${x1} ${yy} m ${x2} ${yy} l S`);
 const text=(x,yy,s,{size=9,bold=false,color=INK}={})=>ops.push(`BT ${color} rg /${bold?'F2':'F1'} ${size} Tf ${x} ${yy} Td (${esc(s)}) Tj ET`);
 const textR=(xr,yy,s,opt={})=>{const size=opt.size||9;text(xr-String(s).length*size*(opt.bold?0.55:0.5),yy,s,opt)};
 const period=`${MONTHS[st.period_month-1]} ${st.period_year}`;
 function header(first){
  rect(0,PAGE_H-90,PAGE_W,90,NAVY);rect(0,PAGE_H-94,PAGE_W,4,AMBER);
  text(L,PAGE_H-46,'HAPA',{size:24,bold:true,color:'1 1 1'});
  text(L,PAGE_H-66,'Driver earnings statement - not a tax invoice',{size:10,color:'0.85 0.88 0.92'});
  textR(R,PAGE_H-46,st.reference,{size:11,bold:true,color:'1 1 1'});
  textR(R,PAGE_H-64,period+'  -  Timezone: Africa/Nairobi',{size:9,color:'0.85 0.88 0.92'});
  y=PAGE_H-120;
  if(first){
   text(L,y,'Driver:',{color:MUTED});text(L+50,y,driverName||'',{bold:true});
   textR(R,y,'Status: '+String(st.status).replace(/_/g,' '),{color:MUTED});y-=24;
  }
 }
 function newPage(){pages.push(ops.join('\n'));ops=[];header(false)}
 const ensure=h=>{if(y-h<60)newPage()};
 header(true);

 const opening=st.opening||{},closing=st.closing||{},sum=st.summary||{};
 text(L,y,'OPENING BALANCES',{bold:true,color:MUTED});y-=14;hline(L,R,y+6);y-=6;
 for(const[k,label]of[['driver_owes_hapa','Driver owes HAPA'],['hapa_owes_driver','HAPA owes Driver'],['reserve','Commission Reserve balance']]){
  text(L,y,label);textR(R,y,moneyKES(opening[k]||0));y-=13;
 }
 y-=10;text(L,y,'RIDES THIS PERIOD',{bold:true,color:MUTED});y-=14;hline(L,R,y+6);y-=8;
 const cols={date:L,ref:L+62,route:L+150,pay:L+330,gross:L+400,com:L+455,net:R};
 text(cols.date,y,'Date',{bold:true,size:8,color:MUTED});text(cols.ref,y,'Reference',{bold:true,size:8,color:MUTED});
 text(cols.route,y,'Route',{bold:true,size:8,color:MUTED});text(cols.pay,y,'Payment',{bold:true,size:8,color:MUTED});
 textR(cols.gross+40,y,'Gross',{bold:true,size:8,color:MUTED});textR(cols.com+40,y,'Commission',{bold:true,size:8,color:MUTED});textR(cols.net,y,'Driver net',{bold:true,size:8,color:MUTED});
 y-=13;
 const rideItems=(items||[]).filter(i=>i.item_type==='ride');
 if(!rideItems.length){text(L,y,'No completed rides this month.',{color:MUTED});y-=13}
 const nrb=d=>{try{return new Intl.DateTimeFormat('en-KE',{timeZone:'Africa/Nairobi',day:'2-digit',month:'2-digit'}).format(new Date(d))}catch{return ''}};
 for(const it of rideItems){
  ensure(14);const d=it.data||{};
  text(cols.date,y,nrb(d.completed_at),{size:8});
  text(cols.ref,y,String(d.ride_reference||d.receipt_reference||'').slice(0,16),{size:8});
  text(cols.route,y,(String(d.pickup_label||'')+' to '+String(d.dest_label||'')).slice(0,38),{size:8});
  text(cols.pay,y,d.payment_method==='cash'?'Cash':'M-Pesa',{size:8});
  textR(cols.gross+40,y,moneyKES(d.gross_fare),{size:8});textR(cols.com+40,y,moneyKES(d.commission_amount),{size:8});textR(cols.net,y,moneyKES(d.net_earnings),{size:8});
  y-=12;
 }
 const other=[['reserve_entry','COMMISSION RESERVE ACTIVITY'],['settlement','SETTLEMENTS']];
 for(const[type,title]of other){
  const list=(items||[]).filter(i=>i.item_type===type);
  ensure(46);y-=10;text(L,y,title,{bold:true,color:MUTED});y-=14;hline(L,R,y+6);y-=8;
  if(!list.length){text(L,y,'None this month.',{color:MUTED});y-=13;continue}
  for(const it of list){
   ensure(14);const d=it.data||{};
   const label=type==='reserve_entry'?String(d.entry_type||'').replace(/_/g,' '):(d.direction==='driver_to_hapa'?'Driver paid HAPA':'HAPA paid Driver')+' ('+String(d.method||'').replace(/_/g,' ')+')';
   text(L,y,nrb(d.created_at||d.completed_at),{size:8});text(L+62,y,String(it.reference||'').slice(0,26),{size:8});
   text(L+230,y,label,{size:8});textR(R,y,moneyKES(d.amount),{size:8});y-=12;
  }
 }
 ensure(170);y-=12;text(L,y,'SUMMARY',{bold:true,color:MUTED});y-=14;hline(L,R,y+6);y-=8;
 const S=[['Completed rides',sum.rides,true],['Gross fares',sum.gross],['HAPA commission',sum.commission],['Driver fare earnings',sum.net],
  ['Cash collected by Driver',sum.cash_gross],['M-Pesa fares collected by HAPA',sum.mpesa_gross],
  ['Tips (M-Pesa, 100% to Driver)',sum.tips_mpesa],['Tips (cash, declared by Rider - not verified by HAPA)',sum.tips_cash_declared],
  ['Reserve top-ups',sum.reserve_topups],['Commission covered by Reserve',sum.reserve_debits],
  ['Settled: Driver to HAPA',sum.settled_to_hapa],['Settled: HAPA to Driver',sum.settled_to_driver]];
 for(const[label,v,raw]of S){text(L,y,label);textR(R,y,raw?String(v||0):moneyKES(v||0));y-=13}
 y-=10;text(L,y,'CLOSING BALANCES',{bold:true,color:MUTED});y-=14;hline(L,R,y+6);y-=6;
 for(const[k,label]of[['driver_owes_hapa','Driver owes HAPA'],['hapa_owes_driver','HAPA owes Driver'],['reserve','Commission Reserve balance']]){
  text(L,y,label,{bold:true});textR(R,y,moneyKES(closing[k]||0),{bold:true});y-=13;
 }
 ensure(40);y-=14;hline(L,R,y+8);
 text(L,y-6,'Driver earnings statement - not a tax invoice. HAPA - Embu, Kenya.',{size:8,color:MUTED});
 pages.push(ops.join('\n'));

 // Assemble multi-page PDF
 const n=pages.length,objs=[];const kids=[];
 objs[1]='';objs[2]='';
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
module.exports={buildStatementPdf};
