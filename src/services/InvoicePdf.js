/**
 * Renders invoices on the coded company letterhead (see services/letterhead.js),
 * laid out to match the reference invoice the business supplied:
 *
 *   ┌───────────────────────────────────────────────────────┐
 *   │ [logo]                                       INVOICE  │
 *   │                                           # INV-0007  │
 *   │                                               UNPAID  │
 *   │                                                       │
 *   │ MOHSIN DESIGNS LLC                          Bill To:  │
 *   │ US Office: 312 W 2nd St            410 MUSCLE THERAPY │
 *   │ EIN: … / Pakistan Office: …            <client block> │
 *   │ Note: "For all official matters …"  Invoice Date: …   │
 *   │                                         Due Date: …   │
 *   ├───────────────────────────────────────────────────────┤
 *   │ #  Item                   Qty   Rate   Tax   Amount   │
 *   │ 1  SEO Premium — Aug        1  $950…    0%   $950…    │
 *   │ 2  Web Design               1  $…       0%   $…       │
 *   │                                    Sub Total     $…   │
 *   │                          <date> · <method>    -$…   │  ← one per payment
 *   │                                        Total     $…   │  ← shaded
 *   │                                   Total Paid    -$…   │
 *   │                                   Amount Due     $…   │  ← shaded
 *   ├───────────────────────────────────────────────────────┤
 *   │ Transactions: Payment # / Mode / Date / Amount        │
 *   │ Note: …            Terms & Conditions: …              │
 *   │ Authorized Signature              [QR] Scan to view   │
 *   └───────────────────────────────────────────────────────┘
 *
 * The company block and Bill To run as parallel columns beneath the title row —
 * not stacked — and the margins, 10pt body type and column stops are taken from
 * the reference measured glyph-by-glyph. The header is text drawn in code, not a
 * stamped letterhead image, so Admin → Branding is the single place it changes.
 */
const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const QRCode = require('qrcode');
const { money, formatDate, wrapText } = require('./pdfLetterheadUtils');
const { resolveLetterhead, drawPdfLibLetterhead } = require('./letterhead');

const TEXT = rgb(0.13, 0.13, 0.13);
const MUTED = rgb(0.42, 0.45, 0.50);
const RULE = rgb(0.85, 0.87, 0.90);
const BRAND = rgb(0.043, 0.114, 0.369); // #0B1D5E — matches the logo's navy
// Lifted straight out of the reference invoice's content stream rather than
// eyeballed: the items table heads a dark slate bar with white type, and the
// two emphasis rows in the totals block sit on a light grey band.
const TABLE_HEAD_BG = rgb(0.196078, 0.227451, 0.270588); // #323A45
const TABLE_HEAD_TEXT = rgb(1, 1, 1);
const BAND_BG = rgb(0.898039, 0.905882, 0.921569); // #E5E7EB
const GREEN = rgb(0.05, 0.45, 0.28);
const PAY_LINK_GREEN = rgb(0.20, 0.62, 0.35); // Matches reference "PAY INVOICE"
const RED = rgb(0.72, 0.14, 0.14);
const AMBER = rgb(0.68, 0.48, 0.04);

const STATUS_LABEL = {
  draft: 'Draft', sent: 'Unpaid', overdue: 'Overdue',
  payment_review: 'Payment Under Review', paid: 'Paid', void: 'Void',
};
const STATUS_COLOR = {
  draft: MUTED, sent: RED, overdue: RED, payment_review: AMBER, paid: GREEN, void: MUTED,
};

/** Header status line — optionally "STATUS - PAY INVOICE" with a live link. */
function buildInvoiceTitleStatus(data) {
  const amountPaid = Number(data.amountPaid) || 0;
  const amountDue = Number(data.amountDue);
  const dueLeft = Number.isFinite(amountDue) ? amountDue : null;
  const isPartial = amountPaid > 0 && (dueLeft === null ? true : dueLeft > 0)
    && !['paid', 'void'].includes(data.status);
  const statusText = (isPartial
    ? 'Partially Paid'
    : (STATUS_LABEL[data.status] || data.status || '')
  ).toUpperCase();
  const statusColor = isPartial ? AMBER : (STATUS_COLOR[data.status] || MUTED);
  const payUrl = String(data.payUrl || '').trim();
  const canPay = !!payUrl
    && !['paid', 'void'].includes(data.status)
    && (dueLeft === null || dueLeft > 0);

  if (!canPay) {
    return { text: statusText, size: 10, bold: true, color: statusColor, gap: 13 };
  }

  return {
    size: 10,
    bold: true,
    gap: 13,
    segments: [
      { text: statusText, bold: true, color: statusColor },
      { text: ' - ', bold: true, color: MUTED },
      { text: 'PAY INVOICE', bold: true, color: PAY_LINK_GREEN, url: payUrl },
    ],
  };
}

const PAGE_WIDTH = 595.28; // A4
const PAGE_HEIGHT = 841.89;

function resolveAsset(envVar, filename) {
  const candidates = [process.env[envVar], path.join(__dirname, '../../assets', filename)].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function resolveSignaturePath() { return resolveAsset('SIGNATURE_IMAGE_PATH', 'signature.png'); }

async function buildInvoicePdf(data) {
  const outDoc = await PDFDocument.create();
  // Callers pass `letterhead` already resolved from the companies ticked for
  // billing (see services/letterhead.js#letterheadForOrg). `data.org` remains
  // the fallback for any caller still handing over a raw WhiteLabelConfig row.
  const letterhead = data.letterhead?.entities
    ? data.letterhead
    : resolveLetterhead(data.org);

  // Browsers title the PDF viewer tab from the document's own /Title metadata,
  // falling back to the last URL path segment — which is why an invoice opened
  // from a blob: URL was titled with a raw UUID and one served from
  // /documents/:id/pdf was just titled "pdf". Naming the document fixes both.
  const docTitle = ['Invoice', data.number, data.client?.name].filter(Boolean).join(' — ');
  outDoc.setTitle(docTitle);
  outDoc.setSubject(`Invoice ${data.number || ''}`.trim());
  outDoc.setAuthor(letterhead.legalName);
  outDoc.setProducer(letterhead.legalName);
  outDoc.setCreator(letterhead.legalName);

  const font = await outDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await outDoc.embedFont(StandardFonts.HelveticaBold);

  // Margins, type sizes and column stops below are taken from the reference
  // invoice measured glyph-by-glyph, so this renders at the same scale rather
  // than a smaller lookalike.
  const marginLeft = 34;
  const marginRight = 34;
  const marginTop = 42;
  const marginBottom = 58;
  const contentWidth = PAGE_WIDTH - marginLeft - marginRight;

  let page = null;
  let y = 0;

  function newPage() {
    page = outDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    y = PAGE_HEIGHT - marginTop;
  }

  function ensureSpace(needed) {
    if (y - needed < marginBottom) newPage();
  }

  function drawWrapped(text, opts = {}) {
    const size = opts.size || 10;
    const f = opts.bold ? fontBold : font;
    const gap = opts.gap || size + 4;
    const lines = wrapText(text, f, size, opts.width || contentWidth);
    for (const line of lines) {
      ensureSpace(gap + 2);
      page.drawText(line, { x: opts.x ?? marginLeft, y: y - size, size, font: f, color: opts.color || TEXT });
      y -= gap;
    }
  }

  function drawRule() {
    ensureSpace(12);
    y -= 4;
    page.drawLine({ start: { x: marginLeft, y }, end: { x: marginLeft + contentWidth, y }, thickness: 0.8, color: RULE });
    y -= 12;
  }

  function drawSectionTitle(title) {
    ensureSpace(28);
    page.drawText(title.toUpperCase(), { x: marginLeft, y: y - 10, size: 10, font: fontBold, color: BRAND });
    y -= 17;
  }

  // ── Page 1: letterhead + Bill To, as two parallel columns ──────────────────
  newPage();

  // Everything the recipient block needs, right-aligned. It runs level with the
  // company block rather than below it — the reference invoice sets the two side
  // by side, which is what keeps the header compact.
  const billName = data.client?.billingName || data.client?.name || '—';
  const billTo = [
    { text: 'Bill To:', bold: true, color: BRAND },
    { text: billName.toUpperCase(), bold: true, color: TEXT },
  ];
  if (data.client?.contactName && data.client.contactName !== billName) {
    billTo.push({ text: data.client.contactName, color: TEXT });
  }
  for (const raw of String(data.client?.billingAddress || '').split(/\r?\n/)) {
    if (raw.trim()) billTo.push({ text: raw.trim(), color: TEXT });
  }
  if (data.client?.state) billTo.push({ text: data.client.state, color: TEXT });
  if (data.client?.contactEmail) billTo.push({ text: data.client.contactEmail, color: TEXT });
  if (data.client?.contactPhone) billTo.push({ text: data.client.contactPhone, color: TEXT });
  billTo.push({ spacer: true, gap: 14 });
  billTo.push({ text: `Invoice Date: ${formatDate(data.issuedAt)}`, color: TEXT });
  billTo.push({ text: `Due Date: ${formatDate(data.dueAt)}`, color: TEXT });
  if (data.salesAgent) billTo.push({ text: `Sale Agent: ${data.salesAgent}`, color: TEXT });

  y = await drawPdfLibLetterhead(outDoc, page, {
    letterhead,
    font,
    fontBold,
    marginLeft,
    contentWidth,
    top: y,
    accentColor: BRAND,
    // Match the reference invoice wordmark — 26pt read as a tiny badge.
    // Make the wordmark slightly smaller (~7-10%) for tighter header spacing.
    logoHeight: 40,
    // Invoices should not print the shared letterhead "Note:" paragraph.
    omitNote: true,
    titleBlock: [
      { text: 'INVOICE', size: 18, bold: true, color: BRAND, gap: 22 },
      { text: `# ${data.number || ''}`, size: 10, color: MUTED, gap: 13 },
      // Reference style: "OVERDUE - PAY INVOICE" / "PARTIALLY PAID - PAY INVOICE"
      buildInvoiceTitleStatus(data),
    ],
    rightColumn: billTo,
  });

  // ── Itemized table ─────────────────────────────────────────────────────────
  // Columns and stops mirror the reference invoice: a row number, the item (a
  // bold code/title with its description flowing underneath at the same left
  // edge), then Qty / Rate / Tax / Amount right-aligned at fixed positions.
  const ROW_SIZE = 9.2;
  const ROW_GAP = 11.7;
  const HEAD_SIZE = 10;
  const numX = marginLeft + 2;
  const itemX = marginLeft + 27;
  const itemWidth = 245;
  const qtyRight = marginLeft + 291;
  const rateRight = marginLeft + 369;
  const taxRight = marginLeft + 446;
  const amountRight = marginLeft + 520;

  function drawRightAt(str, rightX, yPos, size, f, color) {
    page.drawText(str, { x: rightX - f.widthOfTextAtSize(str, size), y: yPos, size, font: f, color });
  }

  function drawTableHeader() {
    ensureSpace(29);
    const headerH = 23;
    page.drawRectangle({ x: marginLeft, y: y - headerH, width: contentWidth, height: headerH, color: TABLE_HEAD_BG });
    const ty = y - 15;
    page.drawText('#', { x: numX, y: ty, size: HEAD_SIZE, font: fontBold, color: TABLE_HEAD_TEXT });
    page.drawText('Item', { x: itemX, y: ty, size: HEAD_SIZE, font: fontBold, color: TABLE_HEAD_TEXT });
    drawRightAt('Qty', qtyRight, ty, HEAD_SIZE, fontBold, TABLE_HEAD_TEXT);
    drawRightAt('Rate', rateRight, ty, HEAD_SIZE, fontBold, TABLE_HEAD_TEXT);
    drawRightAt('Tax', taxRight, ty, HEAD_SIZE, fontBold, TABLE_HEAD_TEXT);
    drawRightAt('Amount', amountRight, ty, HEAD_SIZE, fontBold, TABLE_HEAD_TEXT);
    y -= headerH;
  }

  drawTableHeader();

  const lineItems = Array.isArray(data.lineItems) ? data.lineItems : [];
  for (let idx = 0; idx < lineItems.length; idx += 1) {
    const li = lineItems[idx];

    // An item's first line is its title/code and is set in bold; anything after
    // a newline is its description, flowing beneath at the same left edge. Most
    // of our invoice lines are a single line, which simply renders as the title.
    const raw = String(li.description || 'Item').split(/\r?\n/);
    const titleLines = wrapText(raw[0] || 'Item', fontBold, ROW_SIZE, itemWidth);
    const detailText = raw.slice(1).join('\n').trim();
    const detailLines = detailText ? wrapText(detailText, font, ROW_SIZE, itemWidth) : [];

    const rowH = (titleLines.length + detailLines.length) * ROW_GAP + 9;

    if (y - rowH < marginBottom) {
      newPage();
      drawTableHeader();
    }

    // Rows stay white with a hairline separator, as in the reference — the dark
    // header bar is what carries the structure, so zebra striping on top of it
    // just added noise.
    const firstBaseline = y - ROW_SIZE - 5;
    page.drawText(String(idx + 1), { x: numX, y: firstBaseline, size: ROW_SIZE, font, color: TEXT });

    let ty = firstBaseline;
    for (const tl of titleLines) {
      page.drawText(tl, { x: itemX, y: ty, size: ROW_SIZE, font: fontBold, color: TEXT });
      ty -= ROW_GAP;
    }
    for (const dl of detailLines) {
      page.drawText(dl, { x: itemX, y: ty, size: ROW_SIZE, font, color: MUTED });
      ty -= ROW_GAP;
    }

    // Numeric cells sit on the item's first line, as in the reference.
    drawRightAt(String(li.qty ?? 1), qtyRight, firstBaseline, ROW_SIZE, font, TEXT);
    drawRightAt(money(li.unitPrice, data.currency), rateRight, firstBaseline, ROW_SIZE, font, TEXT);
    // No per-line tax is charged unless the line carries a label, in which case
    // it prints exactly as given (e.g. "GST 17%").
    drawRightAt(li.taxLabel || '0%', taxRight, firstBaseline, ROW_SIZE, font, TEXT);
    drawRightAt(money(li.amount, data.currency), amountRight, firstBaseline, ROW_SIZE, font, TEXT);

    y -= rowH;
    page.drawLine({ start: { x: marginLeft, y }, end: { x: marginLeft + contentWidth, y }, thickness: 0.4, color: RULE });
  }
  y -= 10;

  // ── Summary ────────────────────────────────────────────────────────────────
  // Labels right-align against a fixed gutter, values against the right margin,
  // and the two rows that matter (Total, Amount Due) sit on a shaded band —
  // exactly how the reference invoice sets its totals. "Total Paid" prints
  // negative so the arithmetic down to Amount Due reads at a glance.
  const summaryRows = [{ label: 'Sub Total', value: money(data.subtotal, data.currency) }];
  if (data.discountLabel) summaryRows.push({ label: 'Discount', value: data.discountLabel });
  // Tax lines, when the invoice carries any, sit between Sub Total and Total.
  for (const tax of Array.isArray(data.taxLines) ? data.taxLines : []) {
    summaryRows.push({ label: tax.label, value: money(tax.amount, data.currency) });
  }
  summaryRows.push({ label: 'Total', value: money(data.total, data.currency), emphasis: true });

  const labelRight = marginLeft + contentWidth - 80;
  const SUM_SIZE = 9.2;
  const SUM_GAP = 19;

  function drawSummaryRows(rows) {
    for (const row of rows) {
      ensureSpace(SUM_GAP + 4);
      if (row.emphasis) {
        // The band runs the full content width, not just the figures column.
        page.drawRectangle({
          x: marginLeft, y: y - SUM_GAP + 3, width: contentWidth, height: SUM_GAP,
          color: BAND_BG,
        });
      }
      const baseline = y - SUM_SIZE - 3;
      drawRightAt(row.label, labelRight, baseline, SUM_SIZE, fontBold, TEXT);
      drawRightAt(row.value, marginLeft + contentWidth, baseline, SUM_SIZE, font, row.color || TEXT);
      y -= SUM_GAP;
    }
  }

  // Everything down to Total, then payments, then what's left to pay.
  drawSummaryRows(summaryRows);
  y -= 6;

  // ── Payments received ──────────────────────────────────────────────────────
  // Built exactly like the Item table above — same dark header, same column
  // stops, same bold-title-plus-muted-detail row shape — because it is the same
  // kind of information: a list of things with amounts. Squeezing it into the
  // right-hand totals gutter made the method and reference unreadable, and
  // exiling it to its own section below Terms divorced it from the arithmetic.
  // Sitting between Total and Amount Due, it reads as the subtraction it is.
  const transactions = Array.isArray(data.transactions) ? data.transactions : [];
  const paid = Number(data.amountPaid) || 0;

  if (transactions.length) {
    ensureSpace(29);
    const headerH = 23;
    page.drawRectangle({ x: marginLeft, y: y - headerH, width: contentWidth, height: headerH, color: TABLE_HEAD_BG });
    const hy = y - 15;
    page.drawText('#', { x: numX, y: hy, size: HEAD_SIZE, font: fontBold, color: TABLE_HEAD_TEXT });
    page.drawText('Payment Received', { x: itemX, y: hy, size: HEAD_SIZE, font: fontBold, color: TABLE_HEAD_TEXT });
    drawRightAt('Date', rateRight, hy, HEAD_SIZE, fontBold, TABLE_HEAD_TEXT);
    drawRightAt('Amount', amountRight, hy, HEAD_SIZE, fontBold, TABLE_HEAD_TEXT);
    y -= headerH;

    // One clean line per payment: how they paid, when, how much. The provider's
    // transaction id (in_1U4Pxq…) is deliberately NOT printed — it means nothing
    // to the person reading the invoice, and it's on the admin's payment record
    // where reconciliation actually happens.
    for (let i = 0; i < transactions.length; i += 1) {
      const tx = transactions[i];
      const titleLines = wrapText(tx.mode || 'Payment', fontBold, ROW_SIZE, itemWidth);
      const rowH = titleLines.length * ROW_GAP + 9;
      ensureSpace(rowH + 4);

      const firstBaseline = y - ROW_SIZE - 5;
      page.drawText(String(i + 1), { x: numX, y: firstBaseline, size: ROW_SIZE, font, color: TEXT });
      let ty = firstBaseline;
      for (const tl of titleLines) {
        page.drawText(tl, { x: itemX, y: ty, size: ROW_SIZE, font: fontBold, color: TEXT });
        ty -= ROW_GAP;
      }
      drawRightAt(formatDate(tx.date), rateRight, firstBaseline, ROW_SIZE, font, TEXT);
      // Negative and green: this is money coming off the balance.
      drawRightAt(`-${money(tx.amount, data.currency)}`, amountRight, firstBaseline, ROW_SIZE, font, GREEN);

      y -= rowH;
      page.drawLine({ start: { x: marginLeft, y }, end: { x: marginLeft + contentWidth, y }, thickness: 0.4, color: RULE });
    }
    y -= 10;
  }

  // Only worth a line of its own once there are several payments to add up.
  const closingRows = [];
  if (paid > 0 && transactions.length !== 1) {
    closingRows.push({ label: 'Total Paid', value: `-${money(paid, data.currency)}`, color: GREEN });
  }
  const amountDueColor = (Number(data.amountDue) || 0) > 0
    ? (STATUS_COLOR[data.status] || RED)
    : GREEN;
  closingRows.push({
    label: 'Amount Due',
    value: money(data.amountDue ?? data.total, data.currency),
    emphasis: true,
    color: amountDueColor,
  });
  drawSummaryRows(closingRows);
  y -= 6;

  // Transactions used to print here as their own four-column table. They now
  // live inside the summary above, next to Total Paid — see the loop that builds
  // summaryRows.

  // Notes block intentionally omitted from invoice PDFs.

  // Terms & Conditions
  if (data.terms) {
    drawRule();
    drawSectionTitle('Terms & Conditions');
    drawWrapped(data.terms, { size: 10, color: MUTED, gap: 12.5 });
  }

  // Signature (left) + QR (right) — matches the reference invoice layout.
  drawRule();
  ensureSpace(100);
  const footerTop = y;
  page.drawText('Authorized Signature', { x: marginLeft, y: footerTop - 10, size: 10, font: fontBold, color: TEXT });

  const signaturePath = resolveSignaturePath();
  let sigH = 0;
  if (signaturePath) {
    try {
      const sigBytes = fs.readFileSync(signaturePath);
      const sigImage = await outDoc.embedPng(sigBytes);
      const sigMaxW = 130;
      const sigScale = sigMaxW / sigImage.width;
      const sigW = sigImage.width * sigScale;
      sigH = sigImage.height * sigScale;
      page.drawImage(sigImage, { x: marginLeft, y: footerTop - 16 - sigH, width: sigW, height: sigH });
    } catch {
      // Malformed/missing signature image — skip it, don't fail the invoice.
    }
  }

  let qrBlockH = 0;
  if (data.qrUrl) {
    try {
      const qrBuffer = await QRCode.toBuffer(data.qrUrl, { type: 'png', margin: 1, width: 200 });
      const qrImage = await outDoc.embedPng(qrBuffer);
      const qrSize = 64;
      const qrLabel = 'Scan to view online';
      const qrLabelW = font.widthOfTextAtSize(qrLabel, 7.5);
      const qrX = marginLeft + contentWidth - qrSize;
      page.drawImage(qrImage, { x: qrX, y: footerTop - 10 - qrSize, width: qrSize, height: qrSize });
      page.drawText(qrLabel, {
        x: qrX + (qrSize - qrLabelW) / 2,
        y: footerTop - 10 - qrSize - 12,
        size: 7.5,
        font,
        color: MUTED,
      });
      qrBlockH = qrSize + 14;
    } catch {
      // QR generation failure shouldn't block the invoice from being produced.
    }
  }

  y = footerTop - 16 - Math.max(sigH, qrBlockH) - 8;

  // ── Page numbers (n/total), as on the reference invoice ────────────────────
  const pages = outDoc.getPages();
  pages.forEach((p, i) => {
    const label = `${i + 1}/${pages.length}`;
    const w = font.widthOfTextAtSize(label, 8);
    p.drawText(label, {
      x: PAGE_WIDTH / 2 - w / 2, y: marginBottom - 22, size: 8, font, color: MUTED,
    });
  });

  const pdfBytes = await outDoc.save();
  return Buffer.from(pdfBytes);
}

module.exports = { buildInvoicePdf };
