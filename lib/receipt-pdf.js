// HAPA ride receipt PDF generator — pdfkit + embedded (subset) DejaVu Sans,
// single A4 page. Produces a branded, customer-facing financial record from
// the immutable ride_receipts row. NEVER includes commission, driver
// earnings, internal payment mode, IDs or any internal accounting fields.
//
// UNICODE POLICY (shared with the statement PDF via pdfSafe):
//  - DejaVu Sans (Bitstream Vera licence, committed in fonts/ with
//    fonts/DEJAVU-LICENSE.txt) is embedded and subset by pdfkit, so output is
//    identical on any machine — no reliance on system fonts.
//  - Swahili / Kenyan names, Latin Extended (Mũthatari, Kĩrĩnyaga), curly
//    quotes, apostrophes (O’Connor) and en/em dashes render natively.
//  - Emoji and other pictographs are NOT in the font: they are removed
//    deterministically (never a crash, never a tofu box). Arrows become "to".
'use strict';
const path=require('path');
const PDFDocument=require('pdfkit');

const FONT_REG=path.join(__dirname,'..','fonts','DejaVuSans.ttf');
const FONT_BOLD=path.join(__dirname,'..','fonts','DejaVuSans-Bold.ttf');

const PAGE_W=595.28,PAGE_H=841.89; // A4 points
const NAVY='#101C2C',AMBER='#F5A623',GREEN='#198754',INK='#172033',MUTED='#667085',LINE='#E1E6ED';

// Deterministic text sanitizer for all HAPA accounting PDFs.
const pdfSafe=s=>String(s==null?'':s)
 .replace(/[\u2192\u2794\u27A1]/g,' to ')            // arrows → readable
 .replace(/[\u{1F000}-\u{1FFFF}]/gu,'')              // emoji / pictographs (SMP)
 .replace(/[\u2600-\u26FF\u2700-\u27BF]/g,'')        // misc symbols & dingbats
 .replace(/[\u2B00-\u2BFF\uFE00-\uFE0F\u200D\u20E3\uFFFD]/g,'') // arrows-B, VS, ZWJ, keycap
 .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g,'')  // control chars
 .replace(/ {2,}/g,' ');

function moneyKES(n){
 const v=Number(n||0);
 return 'KES '+v.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
}

function nairobi(dt){
 try{
  return new Intl.DateTimeFormat('en-KE',{
   timeZone:'Africa/Nairobi',day:'2-digit',month:'short',year:'numeric',
   hour:'2-digit',minute:'2-digit',hour12:false,
  }).format(new Date(dt))+' EAT';
 }catch{return String(dt||'')}
}

// Build the customer-facing view (single source of truth for what a rider
// may ever see; PDF and any text export must go through this).
function customerReceiptView(reference,body,createdAt){
 const c=body.components||{};
 const lines=[
  ['Base fare',c.base_fare],
  ['Booking fee',c.booking_fee],
  ['Distance charge',c.distance_charge],
  ['Time charge',c.time_charge],
 ].filter(([,v])=>v!=null);
 if(Number(c.waiting_charge)>0)lines.push(['Waiting charge',c.waiting_charge]);
 return{
  reference:String(reference),
  datetime:nairobi(body.datetime||createdAt),
  pickup:body.pickup||'',destination:body.destination||'',
  driver:body.driver||'HAPA Driver',
  vehicle:body.vehicle||'',registration:body.registration||'',
  distance_km:body.distance_m!=null?(Number(body.distance_m)/1000).toFixed(1)+' km':'',
  duration_min:body.duration_s!=null?Math.round(Number(body.duration_s)/60)+' min':'',
  payment_method:body.payment_method==='mpesa'?'M-Pesa':body.payment_method==='cash'?'Cash':String(body.payment_method||''),
  payment_ref:body.payment_ref||null,
  breakdown:lines.map(([label,v])=>({label,amount:moneyKES(v)})),
  total:moneyKES(body.total),
  note:body.note||null,
 };
}

function buildReceiptPdf(reference,body,createdAt){
 const v=customerReceiptView(reference,body,createdAt);
 const doc=new PDFDocument({size:[PAGE_W,PAGE_H],margin:0,autoFirstPage:true,
  info:{Title:'HAPA ride receipt '+v.reference,Author:'HAPA',CreationDate:new Date(body.datetime||createdAt||0)}});
 doc.registerFont('R',FONT_REG);doc.registerFont('B',FONT_BOLD);
 const chunks=[];doc.on('data',c=>chunks.push(c));
 const done=new Promise((resolve,reject)=>{doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject)});

 const wOf=(s,size,bold)=>doc.font(bold?'B':'R').fontSize(size).widthOfString(pdfSafe(s));
 const rect=(x,yy,w,h,color)=>doc.rect(x,PAGE_H-yy-h,w,h).fill(color);
 const hline=(x1,x2,yy,color)=>doc.moveTo(x1,PAGE_H-yy).lineTo(x2,PAGE_H-yy).lineWidth(0.75).strokeColor(color).stroke();
 const text=(x,yy,str,{size=10,bold=false,color=INK}={})=>
  doc.font(bold?'B':'R').fontSize(size).fillColor(color).text(pdfSafe(str),x,PAGE_H-yy,{baseline:'alphabetic',lineBreak:false});
 const textR=(xRight,yy,str,opt={})=>text(xRight-wOf(str,opt.size||10,!!opt.bold),yy,str,opt);

 const L=54,R=PAGE_W-54;
 // Header band
 rect(0,PAGE_H-110,PAGE_W,110,NAVY);
 rect(0,PAGE_H-114,PAGE_W,4,AMBER);
 text(L,PAGE_H-58,'HAPA',{size:30,bold:true,color:'#FFFFFF'});
 text(L,PAGE_H-80,'Official ride receipt',{size:12,color:'#D9E0EB'});
 textR(R,PAGE_H-58,v.reference,{size:12,bold:true,color:'#FFFFFF'});
 textR(R,PAGE_H-76,v.datetime,{size:10,color:'#D9E0EB'});

 let y=PAGE_H-150;
 // PAID badge (label text, not colour alone)
 rect(L,y-6,64,22,GREEN);
 text(L+14,y,'PAID',{size:12,bold:true,color:'#FFFFFF'});
 textR(R,y,'Payment: '+v.payment_method+(v.payment_ref?'  (Ref '+v.payment_ref+')':''),{size:10,color:MUTED});

 y-=44;
 text(L,y,'TRIP',{size:9,bold:true,color:MUTED});y-=18;
 text(L,y,'From:',{size:10,color:MUTED});text(L+60,y,v.pickup,{size:10,bold:true});y-=16;
 text(L,y,'To:',{size:10,color:MUTED});text(L+60,y,v.destination,{size:10,bold:true});y-=16;
 if(v.distance_km||v.duration_min){text(L,y,'Trip:',{size:10,color:MUTED});text(L+60,y,[v.distance_km,v.duration_min].filter(Boolean).join(' - '),{size:10});y-=16;}

 y-=14;
 text(L,y,'DRIVER & VEHICLE',{size:9,bold:true,color:MUTED});y-=18;
 text(L,y,'Driver:',{size:10,color:MUTED});text(L+60,y,v.driver,{size:10,bold:true});y-=16;
 if(v.vehicle){text(L,y,'Vehicle:',{size:10,color:MUTED});text(L+60,y,v.vehicle+(v.registration?' - '+v.registration:''),{size:10});y-=16;}

 y-=14;
 text(L,y,'FARE BREAKDOWN',{size:9,bold:true,color:MUTED});y-=8;hline(L,R,y,LINE);y-=18;
 for(const row of v.breakdown){text(L,y,row.label,{size:10});textR(R,y,row.amount,{size:10});y-=16;}
 if(v.note){text(L,y,v.note,{size:9,color:MUTED});y-=16;}
 y-=2;hline(L,R,y+10,LINE);
 text(L,y-8,'Total paid',{size:13,bold:true});textR(R,y-8,v.total,{size:13,bold:true});y-=40;

 hline(L,R,y,LINE);y-=18;
 text(L,y,'Thank you for riding with HAPA - Embu, Kenya.',{size:9,color:MUTED});y-=14;
 text(L,y,'This is a ride receipt, not a tax invoice.',{size:9,color:MUTED});

 doc.end();
 return done;
}

module.exports={buildReceiptPdf,customerReceiptView,moneyKES,pdfSafe};
