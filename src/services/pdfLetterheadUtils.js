// Shared formatting/measurement helpers for the pdf-lib documents — used by
// DocumentLetterheadPdf.js (quotations/agreements/proposals) and InvoicePdf.js
// (invoices) so both stay pixel-consistent and neither duplicates this logic.
// The letterhead header block itself lives in services/letterhead.js.
function money(amount, currency = 'USD') {
  const n = Number(amount);
  if (!Number.isFinite(n)) return '—';
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD' }).format(n);
  } catch {
    return `${currency || 'USD'} ${n.toFixed(2)}`;
  }
}

function formatDate(value) {
  if (!value) return '—';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

// pdf-lib's StandardFonts (Helvetica etc.) only support WinAnsi (Windows-1252)
// encoding — font.widthOfTextAtSize()/drawText() throw outright on anything
// outside it, rather than degrading gracefully. Admin-authored content can
// carry characters that fall outside that range (box-drawing "─" separators
// and geometric bullets "▸"/"●" from templates written before the rich-text
// editor existed, or a stray copy-pasted symbol) — replace the ones known to
// show up here with plain ASCII, and strip anything else unencodable so PDF
// generation degrades instead of failing the whole request.
function toPdfSafeText(text) {
  return String(text ?? '')
    .replace(/[─-╿]/g, '-') // box drawing: ─ ━ │ ┌ etc.
    .replace(/[■-◿]/g, '-') // geometric shapes: ▸ ▪ ● etc.
    // eslint-disable-next-line no-control-regex
    .replace(/[^\x00-\xFF‘’“”–—…•€™]/g, '');
}

function wrapText(text, font, size, maxWidth) {
  const words = toPdfSafeText(text).replace(/\r\n/g, '\n').split(/(\s+)/);
  const lines = [];
  let current = '';
  for (const word of words) {
    if (word === '\n') {
      lines.push(current);
      current = '';
      continue;
    }
    if (word.includes('\n')) {
      const parts = word.split('\n');
      for (let i = 0; i < parts.length; i += 1) {
        const part = parts[i];
        if (i > 0) {
          lines.push(current);
          current = '';
        }
        const trial = current + part;
        if (font.widthOfTextAtSize(trial, size) > maxWidth && current) {
          lines.push(current);
          current = part;
        } else {
          current = trial;
        }
      }
      continue;
    }
    const trial = current + word;
    if (font.widthOfTextAtSize(trial, size) > maxWidth && current.trim()) {
      lines.push(current.replace(/\s+$/, ''));
      current = word.replace(/^\s+/, '');
    } else {
      current = trial;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [''];
}

// Word-wraps a list of styled inline "runs" (see utils/richTextPdf.js) into
// lines, choosing the right font per word from `fonts` ({regular, bold,
// italic, boldItalic}) so bold/italic segments measure and draw correctly —
// wrapText() above can't do this since it only ever uses one font. A run with
// `br: true` forces a line break (an explicit <br> in the source HTML).
function wrapRuns(runs, fonts, size, maxWidth) {
  const lines = [];
  let current = [];
  let currentWidth = 0;
  const spaceWidth = fonts.regular.widthOfTextAtSize(' ', size);

  function fontFor(run) {
    if (run.bold && run.italic) return fonts.boldItalic;
    if (run.bold) return fonts.bold;
    if (run.italic) return fonts.italic;
    return fonts.regular;
  }
  function trimTrailingSpace() {
    while (current.length && current[current.length - 1].isSpace) current.pop();
  }
  function pushLine() {
    trimTrailingSpace();
    lines.push(current);
    current = [];
    currentWidth = 0;
  }

  for (const run of runs) {
    if (run.br) { pushLine(); continue; }
    const font = fontFor(run);
    const tokens = toPdfSafeText(run.text).split(/(\s+)/).filter((t) => t !== '');
    for (const token of tokens) {
      if (/^\s+$/.test(token)) {
        if (current.length) {
          current.push({ text: ' ', font, underline: run.underline, isSpace: true });
          currentWidth += spaceWidth;
        }
        continue;
      }
      const width = font.widthOfTextAtSize(token, size);
      if (currentWidth + width > maxWidth && current.length) pushLine();
      current.push({ text: token, font, underline: run.underline });
      currentWidth += width;
    }
  }
  trimTrailingSpace();
  if (current.length) lines.push(current);
  return lines.length ? lines : [[]];
}

module.exports = { money, formatDate, wrapText, wrapRuns, toPdfSafeText };
