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

function wrapText(text, font, size, maxWidth) {
  const words = String(text || '').replace(/\r\n/g, '\n').split(/(\s+)/);
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

module.exports = { money, formatDate, wrapText };
