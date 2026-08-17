/**
 * Salary slip PDF — a direct redraw of PAY SLIPS/payslip.html.
 *
 * Drawn natively with PDFKit rather than rendering the HTML in headless Chrome:
 * every other PDF in this app is built the same way, so this adds no Chromium
 * dependency and no deploy change, and a 50-person payroll run stays fast.
 *
 * Layout, top to bottom (mirrors the reference exactly):
 *
 *   ┌──────────────────────────────────────────────┐
 *   │ Company name              SALARY SLIP        │ navy band
 *   │ tagline                   Pay Period: …      │
 *   ├──────────────────────────────────────────────┤
 *   │ Employee Name  …  │ Employee ID   …          │ 2-col meta,
 *   │ Designation    …  │ Department    …          │ dotted rules
 *   ├───────────────────┬──────────────────────────┤
 *   │ EARNINGS          │ DEDUCTIONS               │ blue headers
 *   │ rows…             │ rows…                    │ zebra striped
 *   │ Gross Earnings    │ Total Deductions         │ grey total band
 *   ├──────────────────────────────────────────────┤
 *   │  31     20     8      2      1               │ 5-cell attendance
 *   ├──────────────────────────────────────────────┤
 *   │ NET SALARY PAYABLE            Rs 121,419     │ navy band
 *   │ Amount in words: …                           │
 *   │                        ____________________  │
 *   │                        Authorized Signatory  │
 *   └──────────────────────────────────────────────┘
 */

// Palette lifted from the reference's CSS custom properties.
const NAVY = '#1f3864';
const BLUE = '#4472c4';
const LINE = '#d5dbe6';
const INK = '#1a1f2b';
const MUTED = '#6b7280';
const BAND = '#eef2f8';
const BAND2 = '#f7f9fc';
const WHITE = '#ffffff';

const PAD = 28; // .head/.meta/.line horizontal padding in the reference

function money(n) {
  return `Rs ${Math.round(Number(n) || 0).toLocaleString('en-US')}`;
}

/** Whole rupees, spelled out — the "Amount in words" line. */
function numberToWords(value) {
  const n = Math.round(Math.abs(Number(value) || 0));
  if (n === 0) return 'Zero';
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
  const teens = ['Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const chunk = (x) => {
    if (x < 10) return ones[x];
    if (x < 20) return teens[x - 10];
    if (x < 100) return `${tens[Math.floor(x / 10)]}${x % 10 ? ` ${ones[x % 10]}` : ''}`;
    return `${ones[Math.floor(x / 100)]} Hundred${x % 100 ? ` ${chunk(x % 100)}` : ''}`;
  };
  // International grouping (thousand / million), NOT lakh-crore: the reference
  // slip reads "One Hundred Twenty One Thousand Four Hundred Nineteen", and the
  // words have to match the figure printed directly above them.
  const parts = [];
  const million = Math.floor(n / 1000000);
  const thousand = Math.floor((n % 1000000) / 1000);
  const rest = n % 1000;
  if (million) parts.push(`${chunk(million)} Million`);
  if (thousand) parts.push(`${chunk(thousand)} Thousand`);
  if (rest) parts.push(chunk(rest));
  return parts.join(' ');
}

/**
 * @param {object} doc   PDFKit document, margin 0 (the slip owns its own padding)
 * @param {object} d     Flattened payslip data — see SalarySlipService for the mapping
 */
function drawSalarySlip(doc, d) {
  const left = 0;
  const width = doc.page.width;
  const inner = width - PAD * 2;
  let y = 0;

  const text = (str, x, ty, opts = {}) => {
    doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica')
      .fontSize(opts.size || 10)
      .fillColor(opts.color || INK)
      .text(String(str ?? ''), x, ty, { lineBreak: false, ...opts });
  };
  const rightText = (str, rightX, ty, opts = {}) => {
    const f = opts.bold ? 'Helvetica-Bold' : 'Helvetica';
    doc.font(f).fontSize(opts.size || 10);
    const w = doc.widthOfString(String(str ?? ''));
    text(str, rightX - w, ty, opts);
  };
  const rule = (ty, x1 = PAD, x2 = width - PAD, color = LINE, dash = false) => {
    doc.save().moveTo(x1, ty).lineTo(x2, ty).lineWidth(0.7).strokeColor(color);
    if (dash) doc.dash(1, { space: 2 });
    doc.stroke().undash().restore();
  };

  // ── Header band ───────────────────────────────────────────────────────────
  const headH = 64;
  doc.rect(left, y, width, headH).fill(NAVY);
  text(d.companyName || 'Company', PAD, y + 17, { size: 17, bold: true, color: WHITE });
  if (d.companyTagline) text(d.companyTagline, PAD, y + 40, { size: 8.5, color: '#c9d3e8' });
  rightText('SALARY SLIP', width - PAD, y + 18, { size: 10.5, bold: true, color: WHITE, characterSpacing: 1.6 });
  rightText(`Pay Period: ${d.payPeriod || '—'}`, width - PAD, y + 36, { size: 8.5, color: '#c9d3e8' });
  y += headH;

  // ── Meta grid — two columns, dotted rule under each row ───────────────────
  const metaRows = [
    ['Employee Name', d.employeeName, 'Employee ID', d.employeeId],
    ['Designation', d.designation, 'Department', d.department],
    ['Date of Joining', d.joiningDate, 'Bank Account', d.bankAccount],
    ['Payment Date', d.paymentDate, 'Payment Method', d.paymentMethod],
  ];
  const colGap = 32;
  const colW = (inner - colGap) / 2;
  y += 12;
  for (const [k1, v1, k2, v2] of metaRows) {
    const rowH = 18;
    const pairs = [[k1, v1, PAD, PAD + colW], [k2, v2, PAD + colW + colGap, width - PAD]];
    for (const [k, v, x, rightX] of pairs) {
      text(k, x, y + 4, { size: 9, color: MUTED });
      rightText(v || '—', rightX, y + 4, { size: 9, bold: true });
    }
    y += rowH;
    rule(y - 3, PAD, PAD + colW, LINE, true);
    rule(y - 3, PAD + colW + colGap, width - PAD, LINE, true);
  }
  y += 4;
  rule(y);

  // ── Earnings / Deductions, side by side ───────────────────────────────────
  const midX = width / 2;
  const secH = 24;
  doc.rect(left, y, midX, secH).fill(BLUE);
  doc.rect(midX, y, width - midX, secH).fill(BLUE);
  text('EARNINGS', PAD, y + 8, { size: 9, bold: true, color: WHITE, characterSpacing: 1.2 });
  text('DEDUCTIONS', midX + PAD - 8, y + 8, { size: 9, bold: true, color: WHITE, characterSpacing: 1.2 });
  const colTop = y + secH;

  // Each column is drawn independently, then the shorter one is padded so the
  // total bands and the divider line up.
  const ROW_H = 22;
  function drawColumn(rows, total, x0, x1, startY) {
    let cy = startY;
    rows.forEach((r, i) => {
      if (i % 2 === 1) doc.rect(x0, cy, x1 - x0, ROW_H).fill(BAND2);
      text(r.label, x0 + PAD - (x0 ? 8 : 0), cy + 7, { size: 9 });
      rightText(money(r.amount), x1 - PAD + (x1 === width ? 0 : 8), cy + 7, { size: 9 });
      rule(cy + ROW_H, x0, x1, BAND);
      cy += ROW_H;
    });
    return { rows: rows.length, endY: cy, total };
  }

  const earnCol = drawColumn(d.earnings, d.grossEarnings, left, midX, colTop);
  const dedCol = drawColumn(d.deductions, d.totalDeductions, midX, width, colTop);

  // Pad the shorter column so both total bands sit on the same baseline.
  const bodyBottom = Math.max(earnCol.endY, dedCol.endY);
  const totalY = bodyBottom;
  const totalH = 26;
  doc.rect(left, totalY, midX, totalH).fill(BAND);
  doc.rect(midX, totalY, width - midX, totalH).fill(BAND);
  rule(totalY, left, width, LINE);
  text('Gross Earnings', PAD, totalY + 8, { size: 9.5, bold: true });
  rightText(money(d.grossEarnings), midX - PAD, totalY + 8, { size: 9.5, bold: true });
  text('Total Deductions', midX + PAD - 8, totalY + 8, { size: 9.5, bold: true });
  rightText(money(d.totalDeductions), width - PAD, totalY + 8, { size: 9.5, bold: true });

  // The vertical divider runs the full height of both columns.
  doc.save().moveTo(midX, colTop).lineTo(midX, totalY + totalH).lineWidth(0.7).strokeColor(LINE).stroke().restore();
  y = totalY + totalH;

  // ── Attendance strip — five evenly spaced figures ─────────────────────────
  rule(y);
  const attH = 46;
  const cells = [
    [d.daysInMonth, 'Days in Month'],
    [d.daysPresent, 'Days Present'],
    [d.holidays, 'Holidays'],
    [d.paidLeaveDays, 'Paid Leave'],
    [d.unpaidLeaveDays, 'Unpaid Leave'],
  ];
  const cellW = inner / cells.length;
  cells.forEach(([n, label], i) => {
    const cx = PAD + cellW * i;
    doc.font('Helvetica-Bold').fontSize(13).fillColor(INK);
    const nw = doc.widthOfString(String(n ?? 0));
    text(String(n ?? 0), cx + (cellW - nw) / 2, y + 10, { size: 13, bold: true });
    doc.font('Helvetica').fontSize(7.5);
    const lw = doc.widthOfString(label);
    text(label, cx + (cellW - lw) / 2, y + 28, { size: 7.5, color: MUTED });
  });
  y += attH;

  // ── Net payable ───────────────────────────────────────────────────────────
  const netH = 46;
  doc.rect(left, y, width, netH).fill(NAVY);
  text('NET SALARY PAYABLE', PAD, y + 18, { size: 10.5, bold: true, color: WHITE, characterSpacing: 1.1 });
  rightText(money(d.netSalary), width - PAD, y + 13, { size: 17, bold: true, color: WHITE });
  y += netH;

  // ── Amount in words ───────────────────────────────────────────────────────
  const wordsH = 26;
  text('Amount in words:', PAD, y + 9, { size: 8.5, color: MUTED });
  doc.font('Helvetica').fontSize(8.5);
  const lead = doc.widthOfString('Amount in words: ');
  text(`${numberToWords(d.netSalary)} Rupees Only`, PAD + lead, y + 9, { size: 8.5, bold: true });
  y += wordsH;
  rule(y);

  // ── Signature + footer ────────────────────────────────────────────────────
  y += 46;
  const sigW = 190;
  const sigX = width - PAD - sigW;
  if (d.signatureBuffer) {
    try { doc.image(d.signatureBuffer, sigX + 20, y - 38, { fit: [140, 36] }); } catch { /* ignore */ }
  }
  doc.save().moveTo(sigX, y).lineTo(sigX + sigW, y).lineWidth(0.8).strokeColor(INK).stroke().restore();
  doc.font('Helvetica').fontSize(8.5);
  const sigLabel = 'Authorized Signatory';
  text(sigLabel, sigX + (sigW - doc.widthOfString(sigLabel)) / 2, y + 6, { size: 8.5, color: MUTED });
  y += 30;

  doc.font('Helvetica').fontSize(7.5);
  const foot = 'This is a system-generated salary slip.';
  text(foot, (width - doc.widthOfString(foot)) / 2, y, { size: 7.5, color: MUTED });
}

module.exports = { drawSalarySlip, numberToWords };
