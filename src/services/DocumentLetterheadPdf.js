/**
 * Renders customer documents (quotation / agreement / proposal) on the coded
 * company letterhead — see services/letterhead.js.
 *
 * This used to stamp each page on top of a pre-rendered
 * `mohsin_designs_letterhead.pdf`. That made the header uneditable without
 * re-exporting artwork, printed the address as a fuzzy raster, and left the
 * contact details unselectable/unsearchable. The header is now real text drawn
 * from Admin → Branding, so it matches the invoice letterhead exactly and
 * changing the address once updates every document type.
 */
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { money, formatDate, wrapText } = require('./pdfLetterheadUtils');
const { resolveLetterhead, drawPdfLibLetterhead } = require('./letterhead');

const TEXT = rgb(0.13, 0.13, 0.13);
const MUTED = rgb(0.42, 0.45, 0.50);
const RULE = rgb(0.85, 0.87, 0.90);
const BRAND = rgb(0.043, 0.114, 0.369); // #0B1D5E — matches the logo's navy

const PAGE_WIDTH = 595.28; // A4
const PAGE_HEIGHT = 841.89;

const DOC_TYPE_LABELS = { quotation: 'Quotation', agreement: 'Agreement', proposal: 'Proposal' };

async function buildDocumentPdfOnLetterhead(docData) {
  const outDoc = await PDFDocument.create();
  // Quotations, agreements and proposals are billing documents, so callers pass
  // the letterhead already resolved from the companies ticked "Use for invoices
  // & quotations". `docData.branding` stays as the fallback.
  const letterhead = docData.letterhead?.entities
    ? docData.letterhead
    : resolveLetterhead(docData.branding);

  // Browsers title the PDF viewer tab from the document's own /Title metadata,
  // falling back to the last URL path segment — which is why a quotation served
  // from /api/public/documents/:id/pdf showed a tab simply titled "pdf".
  const typeLabel = DOC_TYPE_LABELS[docData.type] || 'Document';
  outDoc.setTitle([typeLabel, docData.number, docData.businessName || docData.prospectName]
    .filter(Boolean).join(' — '));
  outDoc.setSubject(`${typeLabel} ${docData.number || ''}`.trim());
  outDoc.setAuthor(letterhead.legalName);
  outDoc.setProducer(letterhead.legalName);
  outDoc.setCreator(letterhead.legalName);

  const font = await outDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await outDoc.embedFont(StandardFonts.HelveticaBold);

  const width = PAGE_WIDTH;
  const height = PAGE_HEIGHT;

  // Same margins as the invoice, so both documents sit on an identical grid.
  const marginLeft = 34;
  const marginRight = 34;
  const marginTop = 42;
  const marginBottom = 58;
  const contentWidth = width - marginLeft - marginRight;
  const lineGap = 14;

  let page = null;
  let y = 0;

  // Only page 1 carries the letterhead block; continuation pages start at the
  // plain top margin, the same way the reference invoice does.
  async function newPage() {
    page = outDoc.addPage([width, height]);
    y = height - marginTop;
  }

  function ensureSpace(needed) {
    if (y - needed < marginBottom) {
      return newPage();
    }
    return Promise.resolve();
  }

  async function drawLines(lines, { size = 10, bold = false, color = TEXT, gap = lineGap } = {}) {
    const f = bold ? fontBold : font;
    for (const line of lines) {
      await ensureSpace(gap + 2);
      page.drawText(line, { x: marginLeft, y: y - size, size, font: f, color, maxWidth: contentWidth });
      y -= gap;
    }
  }

  async function drawWrapped(text, opts = {}) {
    const size = opts.size || 10;
    const f = opts.bold ? fontBold : font;
    const lines = wrapText(text, f, size, contentWidth);
    await drawLines(lines, opts);
  }

  async function drawRule() {
    await ensureSpace(12);
    y -= 4;
    page.drawLine({
      start: { x: marginLeft, y },
      end: { x: marginLeft + contentWidth, y },
      thickness: 0.8,
      color: RULE,
    });
    y -= 12;
  }

  async function drawSectionTitle(title) {
    await ensureSpace(28);
    page.drawText(title.toUpperCase(), {
      x: marginLeft,
      y: y - 9,
      size: 9,
      font: fontBold,
      color: BRAND,
    });
    y -= 16;
  }

  // ── Build page 1 ──────────────────────────────────────────────────────────
  await newPage();

  const number = docData.number || '';
  const dateStr = formatDate(docData.issuedAt || docData.createdAt || new Date());

  y = await drawPdfLibLetterhead(outDoc, page, {
    letterhead,
    font,
    fontBold,
    marginLeft,
    contentWidth,
    top: y,
    accentColor: BRAND,
    // Same wordmark scale as invoices — the wide logo reads too small at 26pt.
    logoHeight: 52,
    titleBlock: [
      { text: typeLabel.toUpperCase(), size: 18, bold: true, color: BRAND, gap: 22 },
      { text: number, size: 10, bold: true, color: TEXT, gap: 13 },
      { text: `Date: ${dateStr}`, size: 10, color: MUTED, gap: 13 },
    ],
    // Recipient block, level with the company block — same shape as the
    // invoice's Bill To.
    rightColumn: [
      { text: 'Prepared for:', bold: true, color: BRAND },
      { text: (docData.prospectName || '—').toUpperCase(), bold: true, color: TEXT },
      ...(docData.businessName ? [{ text: docData.businessName, color: TEXT }] : []),
      ...(docData.email ? [{ text: docData.email, color: TEXT }] : []),
      ...(docData.phone ? [{ text: docData.phone, color: TEXT }] : []),
      ...(docData.validUntil
        ? [{ spacer: true, gap: 14 }, { text: `Valid until: ${formatDate(docData.validUntil)}`, color: TEXT }]
        : []),
    ],
  });

  // "Prepared for" now lives in the letterhead's right column, level with the
  // company block — repeating it here would print the recipient twice.

  // Services table
  const services = Array.isArray(docData.services) ? docData.services : [];
  const hideServiceAmounts = !!docData.hideServiceAmounts;
  if (services.length) {
    await drawSectionTitle(hideServiceAmounts ? 'Services included' : 'Services');
    const colService = contentWidth * (hideServiceAmounts ? 0.95 : 0.68);

    await ensureSpace(22);
    page.drawText('Service', { x: marginLeft, y: y - 9, size: 9, font: fontBold, color: MUTED });
    if (!hideServiceAmounts) {
      const amtHeader = 'Amount';
      const amtHeaderW = fontBold.widthOfTextAtSize(amtHeader, 9);
      page.drawText(amtHeader, {
        x: marginLeft + contentWidth - amtHeaderW,
        y: y - 9,
        size: 9,
        font: fontBold,
        color: MUTED,
      });
    } else {
      const note = 'Included in selected package';
      const nw = font.widthOfTextAtSize(note, 8);
      page.drawText(note, {
        x: marginLeft + contentWidth - nw,
        y: y - 9,
        size: 8,
        font,
        color: MUTED,
      });
    }
    y -= 14;
    page.drawLine({
      start: { x: marginLeft, y },
      end: { x: marginLeft + contentWidth, y },
      thickness: 0.6,
      color: RULE,
    });
    y -= 12;

    for (let si = 0; si < services.length; si++) {
      const svc = services[si];
      const name = svc.name || svc.serviceTypeKey || 'Service';
      const amountStr = hideServiceAmounts
        ? ''
        : (svc.price != null ? money(svc.price, docData.currency) : '—');
      const nameLines = wrapText(name, font, 10, colService - 8);
      const rowH = Math.max(nameLines.length * 13, 16);
      await ensureSpace(rowH + 8);

      let ty = y - 10;
      for (const nl of nameLines) {
        page.drawText(nl, { x: marginLeft, y: ty, size: 10, font, color: TEXT });
        ty -= 13;
      }
      if (amountStr) {
        const aw = font.widthOfTextAtSize(amountStr, 10);
        page.drawText(amountStr, {
          x: marginLeft + contentWidth - aw,
          y: y - 10,
          size: 10,
          font,
          color: TEXT,
        });
      }
      y -= rowH;

      if (svc.packageLabel) {
        await drawWrapped(`Package: ${svc.packageLabel}`, { size: 9, color: MUTED, gap: 12 });
      }
      if (svc.featuresText) {
        await drawWrapped("What's included:", { size: 9, bold: true, gap: 12 });
        await drawWrapped(svc.featuresText, { size: 9, color: MUTED, gap: 12 });
      }
      if (svc.scope) {
        await drawWrapped(svc.featuresText ? 'Additional notes:' : "What's included:", {
          size: 9, bold: true, gap: 12,
        });
        await drawWrapped(svc.scope, { size: 9, color: MUTED, gap: 12 });
      }

      // Separator between services — drawn BELOW the block that was just written.
      //
      // `y` is the top of the next line, and drawLines() leaves the last line's
      // baseline at roughly `y + 3` (gap 12 − size 9). Drawing the rule at `y + 4`
      // therefore put it a point ABOVE that baseline, striking a line straight
      // through the final feature of every package. It now sits below the
      // descenders, and the last service skips it entirely — the summary block
      // that follows draws its own rule, so a trailing one doubled up.
      if (si < services.length - 1) {
        y -= 6;
        if (y > marginBottom) {
          page.drawLine({
            start: { x: marginLeft, y },
            end: { x: marginLeft + contentWidth, y },
            thickness: 0.4,
            color: RULE,
          });
        }
        y -= 10;
      }
    }
    y -= 4;
  }

  // Line items
  const lineItems = Array.isArray(docData.lineItems) ? docData.lineItems : [];
  if (lineItems.length) {
    await drawSectionTitle('Line items');
    for (const li of lineItems) {
      const desc = li.description || 'Item';
      const qty = Number(li.qty) || 1;
      const unit = Number(li.unitPrice) || 0;
      const lineTotal = qty * unit;
      const left = `${desc}${qty !== 1 ? ` × ${qty}` : ''}`;
      const right = money(lineTotal, docData.currency);
      const leftLines = wrapText(left, font, 10, contentWidth * 0.7);
      await ensureSpace(leftLines.length * 13 + 6);
      let ty = y - 10;
      for (const nl of leftLines) {
        page.drawText(nl, { x: marginLeft, y: ty, size: 10, font, color: TEXT });
        ty -= 13;
      }
      const rw = font.widthOfTextAtSize(right, 10);
      page.drawText(right, { x: marginLeft + contentWidth - rw, y: y - 10, size: 10, font, color: TEXT });
      y -= leftLines.length * 13 + 4;
    }
    y -= 4;
  }

  // Package options for client comparison (mutually exclusive alternatives)
  const packageOptions = Array.isArray(docData.packageOptions) ? docData.packageOptions : [];
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  if (packageOptions.length > 1) {
    await drawRule();
    const chosenLabel = docData.selectedPackageLabel;
    await drawSectionTitle(chosenLabel ? 'Package selected' : 'Choose one package');
    if (!chosenLabel) {
      await drawWrapped('These are alternatives — pick one. Your total is based on the package you choose.', {
        size: 9, color: MUTED, gap: 13,
      });
    }
    for (let i = 0; i < packageOptions.length; i += 1) {
      const pkg = packageOptions[i];
      const isChosen = docData.selectedPackageId && pkg.id === docData.selectedPackageId;
      const marker = letters[i] || String(i + 1);
      const title = `Option ${marker}: ${pkg.tier || pkg.name || 'Package'} — ${money(pkg.price, pkg.currency || docData.currency)}${isChosen ? '  (selected)' : ''}`;
      await drawWrapped(title, { size: 10, bold: true, gap: 14 });
      if (pkg.featuresText) {
        await drawWrapped(pkg.featuresText, { size: 9, color: MUTED, gap: 12 });
      }
      y -= 4;
    }
  }

  // Package menu — "build your own" per-service candidates (client picks freely,
  // independently per service, on the review link; nothing is fixed here yet).
  const packageMenu = Array.isArray(docData.packageMenu) ? docData.packageMenu : [];
  if (packageMenu.length) {
    await drawRule();
    await drawSectionTitle('Build your package');
    await drawWrapped('Pick any package for any service below, or none at all — entirely your choice. Final total locks in when you approve on the review link.', {
      size: 9, color: MUTED, gap: 13,
    });
    for (const entry of packageMenu) {
      y -= 4;
      await drawWrapped(entry.serviceName, { size: 10, bold: true, gap: 14 });
      for (const pkg of entry.packages) {
        const line = `${pkg.tier || pkg.name} — ${money(pkg.price, pkg.currency || docData.currency)}`;
        await drawWrapped(line, { size: 9, color: TEXT, gap: 12 });
        if (pkg.featuresText) {
          await drawWrapped(pkg.featuresText, { size: 8, color: MUTED, gap: 11 });
        }
      }
    }
  }

  // Pricing summary
  await drawRule();
  await drawSectionTitle('Summary');
  const summaryMode = docData.summaryMode || 'fixed';
  let summaryRows;
  if (summaryMode === 'menu_pending') {
    summaryRows = [
      ['Estimated total', 'Depends on your selections'],
    ];
  } else if (summaryMode === 'compare_range'
    && docData.optionMinAmount != null
    && docData.optionMaxAmount != null) {
    const min = Number(docData.optionMinAmount);
    const max = Number(docData.optionMaxAmount);
    const rangeStr = min === max
      ? money(min, docData.currency)
      : `${money(min, docData.currency)} – ${money(max, docData.currency)}`;
    summaryRows = [
      ['Estimated total', rangeStr],
    ];
  } else if (summaryMode === 'compare_selected') {
    summaryRows = [];
    if (docData.selectedPackageLabel) {
      summaryRows.push(['Package', docData.selectedPackageLabel]);
    }
    summaryRows.push(['Subtotal', money(docData.subtotal ?? docData.amount, docData.currency)]);
    if (docData.discountLabel) summaryRows.push(['Discount', docData.discountLabel]);
    summaryRows.push(['Total', money(docData.amount, docData.currency)]);
  } else {
    summaryRows = [
      ['Subtotal', money(docData.subtotal ?? docData.amount, docData.currency)],
    ];
    if (docData.discountLabel) summaryRows.push(['Discount', docData.discountLabel]);
    summaryRows.push(['Total', money(docData.amount, docData.currency)]);
  }

  for (const [label, value] of summaryRows) {
    const isTotal = label === 'Total' || label === 'Estimated total';
    await ensureSpace(18);
    page.drawText(label, {
      x: marginLeft,
      y: y - 10,
      size: isTotal ? 11 : 10,
      font: isTotal ? fontBold : font,
      color: TEXT,
    });
    const vw = (isTotal ? fontBold : font).widthOfTextAtSize(value, isTotal ? 11 : 10);
    page.drawText(value, {
      x: marginLeft + contentWidth - vw,
      y: y - 10,
      size: isTotal ? 11 : 10,
      font: isTotal ? fontBold : font,
      color: TEXT,
    });
    y -= isTotal ? 18 : 15;
  }

  if (summaryMode === 'compare_range') {
    y -= 2;
    await drawWrapped('Final total depends on the package you select.', { size: 9, color: MUTED, gap: 13 });
  }
  if (summaryMode === 'menu_pending') {
    y -= 2;
    await drawWrapped('Final total depends on whichever packages you select for each service.', { size: 9, color: MUTED, gap: 13 });
  }

  // "Valid until" is printed in the letterhead's right column alongside the
  // recipient, matching where the reference invoice puts its dates.

  // Terms & Conditions — same section title / content source as invoice PDFs.
  if (docData.terms) {
    await drawRule();
    await drawSectionTitle('Terms & Conditions');
    await drawWrapped(docData.terms, { size: 9, color: TEXT, gap: 12 });
  }

  // Optional narrative body (template text) — kept short / secondary
  if (docData.bodyText) {
    const cleaned = String(docData.bodyText).trim();
    if (cleaned) {
      await drawRule();
      await drawSectionTitle('Details');
      await drawWrapped(cleaned, { size: 9, color: TEXT, gap: 12 });
    }
  }

  // Page numbers, matching the invoice PDF.
  const pages = outDoc.getPages();
  pages.forEach((p, i) => {
    const label = `${i + 1}/${pages.length}`;
    const w = font.widthOfTextAtSize(label, 8);
    p.drawText(label, { x: width / 2 - w / 2, y: marginBottom - 22, size: 8, font, color: MUTED });
  });

  const pdfBytes = await outDoc.save();
  return Buffer.from(pdfBytes);
}

module.exports = {
  buildDocumentPdfOnLetterhead,
};
