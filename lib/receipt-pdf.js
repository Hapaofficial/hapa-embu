// HAPA ride receipt PDF generator — dependency-free, single A4 page.
// Produces a branded, customer-facing financial record from the immutable
// ride_receipts row. NEVER includes commission, driver earnings, internal
// payment mode, IDs or any internal accounting fields.
'use strict';

const PAGE_W = 595.28, PAGE_H = 841.89; // A4 points
const NAVY = '0.063 0.110 0.173';       // #101C2C (HAPA header)
const AMBER = '0.961 0.651 0.137';      // #F5A623 (HAPA primary)
const GREEN = '0.098 0.529 0.329';      // #198754 (success)
const INK = '0.090 0.125 0.200';        // #172033 (text)
const MUTED = '0.400 0.439 0.522';      // #667085 (muted text)
const LINE = '0.882 0.902 0.929';       // #E1E6ED (borders)

// PDF text strings are Latin-1; escape delimiters, replace anything outside.
function pdfText(s) {
  return String(s == null ? '' : s)
    .replace(/[\u2192\u2794\u27A1]/g, 'to') // arrows → readable
    .replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"')
    .replace(/\u00B7/g, '-').replace(/[\u2013\u2014]/g, '-')
    .split('').map(c => c.charCodeAt(0) > 255 ? '?' : c).join('')
    .replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function moneyKES(n) {
  const v = Number(n || 0);
  return 'KES ' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function nairobi(dt) {
  try {
    return new Intl.DateTimeFormat('en-KE', {
      timeZone: 'Africa/Nairobi', day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(dt)) + ' EAT';
  } catch { return String(dt || ''); }
}

// Build the customer-facing view (single source of truth for what a rider
// may ever see; PDF and any text export must go through this).
function customerReceiptView(reference, body, createdAt) {
  const c = body.components || {};
  const lines = [
    ['Base fare', c.base_fare],
    ['Booking fee', c.booking_fee],
    ['Distance charge', c.distance_charge],
    ['Time charge', c.time_charge],
  ].filter(([, v]) => v != null);
  if (Number(c.waiting_charge) > 0) lines.push(['Waiting charge', c.waiting_charge]);
  return {
    reference: String(reference),
    datetime: nairobi(body.datetime || createdAt),
    pickup: body.pickup || '', destination: body.destination || '',
    driver: body.driver || 'HAPA Driver',
    vehicle: body.vehicle || '', registration: body.registration || '',
    distance_km: body.distance_m != null ? (Number(body.distance_m) / 1000).toFixed(1) + ' km' : '',
    duration_min: body.duration_s != null ? Math.round(Number(body.duration_s) / 60) + ' min' : '',
    payment_method: body.payment_method === 'mpesa' ? 'M-Pesa' : body.payment_method === 'cash' ? 'Cash' : String(body.payment_method || ''),
    payment_ref: body.payment_ref || null,
    breakdown: lines.map(([label, v]) => ({ label, amount: moneyKES(v) })),
    total: moneyKES(body.total),
    note: body.note || null,
  };
}

function buildReceiptPdf(reference, body, createdAt) {
  const v = customerReceiptView(reference, body, createdAt);
  const ops = [];
  const rect = (x, y, w, h, color) => ops.push(`${color} rg ${x} ${y} ${w} ${h} re f`);
  const hline = (x1, x2, y, color) => ops.push(`${color} RG 0.75 w ${x1} ${y} m ${x2} ${y} l S`);
  const text = (x, y, str, { size = 10, bold = false, color = INK } = {}) =>
    ops.push(`BT ${color} rg /${bold ? 'F2' : 'F1'} ${size} Tf ${x} ${y} Td (${pdfText(str)}) Tj ET`);
  const textR = (xRight, y, str, opt = {}) => { // right-aligned (Helvetica approx width)
    const size = opt.size || 10; const w = String(str).length * size * (opt.bold ? 0.55 : 0.5);
    text(xRight - w, y, str, opt);
  };

  const L = 54, R = PAGE_W - 54;
  // Header band
  rect(0, PAGE_H - 110, PAGE_W, 110, NAVY);
  rect(0, PAGE_H - 114, PAGE_W, 4, AMBER);
  text(L, PAGE_H - 58, 'HAPA', { size: 30, bold: true, color: '1 1 1' });
  text(L, PAGE_H - 80, 'Official ride receipt', { size: 12, color: '0.85 0.88 0.92' });
  textR(R, PAGE_H - 58, v.reference, { size: 12, bold: true, color: '1 1 1' });
  textR(R, PAGE_H - 76, v.datetime, { size: 10, color: '0.85 0.88 0.92' });

  let y = PAGE_H - 150;
  // PAID badge (label text, not colour alone)
  rect(L, y - 6, 64, 22, GREEN);
  text(L + 14, y, 'PAID', { size: 12, bold: true, color: '1 1 1' });
  textR(R, y, 'Payment: ' + v.payment_method + (v.payment_ref ? '  (Ref ' + v.payment_ref + ')' : ''), { size: 10, color: MUTED });

  y -= 44;
  text(L, y, 'TRIP', { size: 9, bold: true, color: MUTED }); y -= 18;
  text(L, y, 'From:', { size: 10, color: MUTED }); text(L + 60, y, v.pickup, { size: 10, bold: true }); y -= 16;
  text(L, y, 'To:', { size: 10, color: MUTED }); text(L + 60, y, v.destination, { size: 10, bold: true }); y -= 16;
  if (v.distance_km || v.duration_min) { text(L, y, 'Trip:', { size: 10, color: MUTED }); text(L + 60, y, [v.distance_km, v.duration_min].filter(Boolean).join(' - '), { size: 10 }); y -= 16; }

  y -= 14;
  text(L, y, 'DRIVER & VEHICLE', { size: 9, bold: true, color: MUTED }); y -= 18;
  text(L, y, 'Driver:', { size: 10, color: MUTED }); text(L + 60, y, v.driver, { size: 10, bold: true }); y -= 16;
  if (v.vehicle) { text(L, y, 'Vehicle:', { size: 10, color: MUTED }); text(L + 60, y, v.vehicle + (v.registration ? ' - ' + v.registration : ''), { size: 10 }); y -= 16; }

  y -= 14;
  text(L, y, 'FARE BREAKDOWN', { size: 9, bold: true, color: MUTED }); y -= 8; hline(L, R, y, LINE); y -= 18;
  for (const row of v.breakdown) { text(L, y, row.label, { size: 10 }); textR(R, y, row.amount, { size: 10 }); y -= 16; }
  if (v.note) { text(L, y, v.note, { size: 9, color: MUTED }); y -= 16; }
  y -= 2; hline(L, R, y + 10, LINE);
  text(L, y - 8, 'Total paid', { size: 13, bold: true }); textR(R, y - 8, v.total, { size: 13, bold: true }); y -= 40;

  hline(L, R, y, LINE); y -= 18;
  text(L, y, 'Thank you for riding with HAPA - Embu, Kenya.', { size: 9, color: MUTED }); y -= 14;
  text(L, y, 'This is a ride receipt, not a tax invoice.', { size: 9, color: MUTED });

  const content = ops.join('\n');
  const objs = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
  objs[3] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>`;
  objs[4] = `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`;
  objs[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objs[6] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';

  let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets = [0];
  for (let i = 1; i < objs.length; i++) { offsets[i] = Buffer.byteLength(out, 'latin1'); out += `${i} 0 obj\n${objs[i]}\nendobj\n`; }
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) out += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

module.exports = { buildReceiptPdf, customerReceiptView, moneyKES };
