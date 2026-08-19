// Pure-JS PDF generation via pdfkit — no external browser binary required (no
// Chrome/Chromium install, no CHROME_PATH, no platform-specific launch failures).
// Previously this rendered an HTML string through Puppeteer, which meant every
// PDF download depended on a working Chrome install on whatever server this runs
// on — the #1 way that broke in production. pdfkit draws directly onto the PDF
// canvas from Node with zero native/external dependencies.
const PDFDocument = require('pdfkit');
const http = require('http');
const https = require('https');

const { BRAND_PRIMARY } = require('../config/brand');

const BRAND_COLOR = BRAND_PRIMARY;
const TEXT_COLOR = '#222222';
const MUTED_COLOR = '#888888';
const BORDER_COLOR = '#E5E7EB';
const HEADER_BG = '#F9FAFB';

// Builds a PDF via `drawFn(doc)` and resolves with the finished buffer. `drawFn`
// gets a live pdfkit PDFDocument to draw on with the normal pdfkit API
// (doc.text/rect/moveTo/etc.) — see drawTable() below for tabular data.
function createPdfBuffer(drawFn, docOptions = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true, ...docOptions });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      drawFn(doc);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// Fetches an image URL into a Buffer for pdfkit's doc.image() (which needs raw
// bytes, not a URL). Used for org logos in white-labeled reports — resolves to
// null (never rejects) on any failure, so a broken/unreachable logoUrl just
// skips the logo instead of crashing PDF generation.
function fetchImageBuffer(url) {
  return new Promise((resolve) => {
    try {
      const transport = url.startsWith('https:') ? https : http;
      const req = transport.get(url, (res) => {
        if (res.statusCode !== 200) { res.resume(); return resolve(null); }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      });
      req.on('error', () => resolve(null));
      req.setTimeout(5000, () => { req.destroy(); resolve(null); });
    } catch {
      resolve(null);
    }
  });
}

// Draws a branded report header (brand name + subtitle line + rule) at the top
// of the current page and returns the Y position to start content below it.
// `opts.color` overrides the default brand color (used for org-specific
// white-labeled reports); `opts.logoBuffer` draws a logo image left of the text
// when present (fetch it first via fetchImageBuffer — this function stays sync).
function drawHeader(doc, brand, subtitle, opts = {}) {
  const color = opts.color || BRAND_COLOR;
  let textLeft = doc.page.margins.left;
  if (opts.logoBuffer) {
    try {
      const logoSize = 32;
      doc.image(opts.logoBuffer, textLeft, doc.y, { fit: [logoSize, logoSize] });
      textLeft += logoSize + 10;
    } catch {
      // Malformed image data — skip the logo, don't fail the whole report.
    }
  }
  const startY = doc.y;
  doc.font('Helvetica-Bold').fontSize(18).fillColor(color).text(brand, textLeft, startY);
  if (subtitle) {
    doc.font('Helvetica').fontSize(10).fillColor(MUTED_COLOR).text(subtitle, textLeft, doc.y + 2);
  }
  doc.moveDown(0.5);
  const ruleY = doc.y;
  doc.moveTo(doc.page.margins.left, ruleY)
    .lineTo(doc.page.width - doc.page.margins.right, ruleY)
    .lineWidth(1.5).strokeColor(color).stroke();
  doc.moveDown(1);
  return doc.y;
}

// Word-wrapped, bordered table with a header row — pdfkit has no built-in table
// support, so this measures each row's wrapped height (via doc.heightOfString)
// before drawing so rows never overlap, and starts a fresh page (redrawing the
// header row) when a row would run past the bottom margin.
//
// columns: [{ label, key, width, align?, render? }] — `render(doc, value, box)`
//   (box: { x, y, width, height, row }) draws the cell itself instead of the
//   default left/right-aligned text, for things like colored status pills
//   (see drawPill below). Row-height is still measured off the plain value —
//   fine for the short single-line badges this is meant for.
// rows: array of plain objects keyed by column.key (string/number values)
// `headerBg`/`headerTextColor` let a caller brand the header row (e.g. a
// client-facing report) without changing the default look for every other
// table already using this.
function drawTable(doc, {
  columns, rows, fontSize = 9, cellPadding = 5, zebra = true,
  headerBg = HEADER_BG, headerTextColor = '#555555', borderColor = BORDER_COLOR, zebraColor = '#FBFCFC',
}) {
  const left = doc.page.margins.left;
  const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const totalDefinedWidth = columns.reduce((sum, c) => sum + (c.width || 0), 0);
  const scale = totalDefinedWidth > 0 ? usableWidth / totalDefinedWidth : 1;
  const colWidths = columns.map((c) => (c.width || usableWidth / columns.length) * scale);
  const bottomLimit = doc.page.height - doc.page.margins.bottom;

  function colX(i) {
    return left + colWidths.slice(0, i).reduce((a, b) => a + b, 0);
  }

  function drawHeaderRow() {
    const y = doc.y;
    doc.font('Helvetica-Bold').fontSize(fontSize).fillColor(headerTextColor);
    const headerHeight = Math.max(...columns.map((c, i) =>
      doc.heightOfString(c.label, { width: colWidths[i] - cellPadding * 2 })
    )) + cellPadding * 2;
    doc.rect(left, y, usableWidth, headerHeight).fill(headerBg);
    doc.fillColor(headerTextColor);
    columns.forEach((c, i) => {
      doc.text(c.label.toUpperCase(), colX(i) + cellPadding, y + cellPadding, {
        width: colWidths[i] - cellPadding * 2,
        align: c.align || 'left',
      });
    });
    doc.y = y + headerHeight;
    doc.moveTo(left, doc.y).lineTo(left + usableWidth, doc.y).strokeColor(borderColor).lineWidth(0.5).stroke();
  }

  drawHeaderRow();

  rows.forEach((row, rowIndex) => {
    doc.font('Helvetica').fontSize(fontSize);
    const rowHeight = Math.max(...columns.map((c, i) => {
      const value = row[c.key] ?? '—';
      return doc.heightOfString(String(value), { width: colWidths[i] - cellPadding * 2 });
    })) + cellPadding * 2;

    if (doc.y + rowHeight > bottomLimit) {
      doc.addPage();
      doc.y = doc.page.margins.top;
      drawHeaderRow();
      doc.font('Helvetica').fontSize(fontSize); // drawHeaderRow() leaves the bold header font active
    }

    const y = doc.y;
    if (zebra && rowIndex % 2 === 1) {
      doc.rect(left, y, usableWidth, rowHeight).fill(zebraColor);
    }
    columns.forEach((c, i) => {
      const value = row[c.key] ?? '—';
      if (c.render) {
        c.render(doc, row[c.key], { x: colX(i), y, width: colWidths[i], height: rowHeight, row });
        return;
      }
      doc.font('Helvetica').fontSize(fontSize).fillColor(TEXT_COLOR);
      doc.text(String(value), colX(i) + cellPadding, y + cellPadding, {
        width: colWidths[i] - cellPadding * 2,
        align: c.align || 'left',
      });
    });
    doc.y = y + rowHeight;
    doc.moveTo(left, doc.y).lineTo(left + usableWidth, doc.y).strokeColor(borderColor).lineWidth(0.5).stroke();
  });

  doc.x = left;
  doc.moveDown(1);
}

// Small rounded-rect badge (status chips, difficulty tiers), centered within a
// table cell's box ({ x, y, width }) — used via a column's `render` in
// drawTable, or standalone.
function drawPill(doc, text, { x, y, width }, { bg = '#F3F4F6', color = TEXT_COLOR, fontSize = 8 } = {}) {
  doc.font('Helvetica-Bold').fontSize(fontSize);
  const label = String(text);
  const textWidth = doc.widthOfString(label);
  const paddingX = 7;
  const pillWidth = Math.min(width, textWidth + paddingX * 2);
  const pillHeight = fontSize + 6;
  const pillX = x + Math.max(0, (width - pillWidth) / 2);
  doc.roundedRect(pillX, y, pillWidth, pillHeight, pillHeight / 2).fill(bg);
  doc.fillColor(color).text(label, pillX, y + 3, { width: pillWidth, align: 'center', lineBreak: false });
}

// A row of "big number + label" summary cards under a report's letterhead —
// the at-a-glance stats block real agency reports lead with, instead of
// dropping the reader straight into a raw data table.
// cards: [{ label, value }]
function drawStatCards(doc, cards, { color = BRAND_COLOR, cardBg = '#F9FAFB', borderColor = BORDER_COLOR } = {}) {
  if (!cards.length) return;
  const left = doc.page.margins.left;
  const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const gap = 10;
  const cardWidth = (usableWidth - gap * (cards.length - 1)) / cards.length;
  const cardHeight = 46;
  const y = doc.y;
  cards.forEach((card, i) => {
    const x = left + i * (cardWidth + gap);
    doc.roundedRect(x, y, cardWidth, cardHeight, 6).fillAndStroke(cardBg, borderColor);
    doc.font('Helvetica-Bold').fontSize(16).fillColor(color)
      .text(String(card.value), x + 10, y + 9, { width: cardWidth - 20, lineBreak: false });
    doc.font('Helvetica').fontSize(7.5).fillColor(MUTED_COLOR)
      .text(card.label.toUpperCase(), x + 10, y + 29, { width: cardWidth - 20, lineBreak: false });
  });
  doc.x = left;
  doc.y = y + cardHeight;
  doc.moveDown(1);
}

// Footer stamped on EVERY buffered page (drawFooter above only stamps the
// last one) — `leftText` left-aligned, "Page X of Y" right-aligned, both on
// the same line. Call once, after all content is drawn.
function drawReportFooter(doc, { leftText = '', color = MUTED_COLOR } = {}) {
  const range = typeof doc.bufferedPageRange === 'function' ? doc.bufferedPageRange() : null;
  if (!range || !range.count) return;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  for (let i = 0; i < range.count; i += 1) {
    doc.switchToPage(range.start + i);
    const bottom = doc.page.height - Math.max(24, doc.page.margins.bottom - 4);
    // pdfkit auto-adds a page when text this close to the physical edge would
    // "overflow" the margin box, even with an explicit y — same trap drawFooter
    // avoids by only ever drawing once. Zeroing the bottom margin for this one
    // write disables that check without touching layout anywhere else.
    const savedBottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font('Helvetica').fontSize(8).fillColor(color);
    if (leftText) {
      doc.text(leftText, doc.page.margins.left, bottom, { width: width / 2, lineBreak: false });
    }
    doc.text(`Page ${i + 1} of ${range.count}`, doc.page.margins.left, bottom, {
      width, align: 'right', lineBreak: false,
    });
    doc.page.margins.bottom = savedBottomMargin;
  }
}

// A simple two-column "label: value" info table for letters/documents (info-grid
// style), not a data table — one row per entry, label bold on the left.
function drawInfoRows(doc, entries, { labelWidth = 160, fontSize = 10 } = {}) {
  const left = doc.page.margins.left;
  const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  entries.forEach(([label, value]) => {
    const y = doc.y;
    doc.font('Helvetica-Bold').fontSize(fontSize).fillColor('#555555')
      .text(label, left, y, { width: labelWidth });
    doc.font('Helvetica').fontSize(fontSize).fillColor(TEXT_COLOR)
      .text(String(value ?? '—'), left + labelWidth, y, { width: usableWidth - labelWidth });
    doc.moveDown(0.3);
    doc.moveTo(left, doc.y).lineTo(left + usableWidth, doc.y).strokeColor(BORDER_COLOR).lineWidth(0.5).stroke();
    doc.moveDown(0.3);
  });
  // Reset cursor to the left margin — value cells leave doc.x mid-page, which
  // otherwise misaligns any following free-flow text (e.g. signature labels).
  doc.x = left;
}

function drawFooter(doc, text) {
  // Pin to the bottom margin without letting pdfkit auto-add a blank next page
  // when the cursor is already near the end of the letter.
  const range = typeof doc.bufferedPageRange === 'function' ? doc.bufferedPageRange() : null;
  if (range && range.count > 0) {
    doc.switchToPage(range.start + range.count - 1);
  }
  const bottom = doc.page.height - Math.max(24, doc.page.margins.bottom - 4);
  doc.font('Helvetica').fontSize(8).fillColor('#AAAAAA')
    .text(text, doc.page.margins.left, bottom, {
      width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
      align: 'center',
      lineBreak: false,
    });
}

module.exports = {
  createPdfBuffer,
  drawHeader,
  drawTable,
  drawPill,
  drawStatCards,
  drawInfoRows,
  drawFooter,
  drawReportFooter,
  fetchImageBuffer,
  BRAND_COLOR,
  TEXT_COLOR,
  MUTED_COLOR,
  BORDER_COLOR,
};
