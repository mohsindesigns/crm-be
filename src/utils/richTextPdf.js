// Parses the small sanitized-HTML dialect this app stores for document
// narratives (see utils/htmlSanitizer.js — h2/h3/p/br/b/strong/i/em/u/ul/ol/li/
// blockquote, no attributes) into a flat list of drawable blocks, each holding
// styled inline "runs". services/DocumentLetterheadPdf.js turns these into
// pdf-lib draw calls (see drawRichBlocks / wrapRuns in pdfLetterheadUtils.js).
//
// No DOM/XML library is available on the backend (see repo README on
// dependency choices), so this is a small hand-rolled tokenizer rather than a
// real parser — it only needs to understand the exact tag set the sanitizer
// allows through, not arbitrary HTML.

const BLOCK_TAGS = ['h2', 'h3', 'p', 'ul', 'ol', 'blockquote', 'div'];
const INLINE_STYLE_TAGS = { b: 'bold', strong: 'bold', i: 'italic', em: 'italic', u: 'underline' };

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ',
};

function decodeEntities(text) {
  return String(text || '').replace(/&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, code) => {
    if (code[0] === '#') {
      const cp = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : match;
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, code) ? ENTITIES[code] : match;
  });
}

// Parses inline content (text + b/strong/i/em/u) into runs of styled text.
// `<br>` inside an inline run is returned as a run with `br: true` so callers
// can force a line break without starting a new block.
function parseInlineRuns(html) {
  const runs = [];
  const stack = []; // active style names, innermost last
  let i = 0;
  const tagRe = /<(\/?)(\w+)>/g;
  let lastIndex = 0;
  let match;
  const pushText = (text) => {
    const decoded = decodeEntities(text);
    if (!decoded) return;
    runs.push({
      text: decoded,
      bold: stack.includes('bold'),
      italic: stack.includes('italic'),
      underline: stack.includes('underline'),
    });
  };
  tagRe.lastIndex = 0;
  while ((match = tagRe.exec(html))) {
    if (match.index > lastIndex) pushText(html.slice(lastIndex, match.index));
    const [, closing, rawTag] = match;
    const tag = rawTag.toLowerCase();
    if (tag === 'br') {
      runs.push({ text: '', br: true, bold: false, italic: false, underline: false });
    } else if (INLINE_STYLE_TAGS[tag]) {
      const style = INLINE_STYLE_TAGS[tag];
      if (closing) {
        const pos = stack.lastIndexOf(style);
        if (pos !== -1) stack.splice(pos, 1);
      } else {
        stack.push(style);
      }
    }
    lastIndex = tagRe.lastIndex;
  }
  if (lastIndex < html.length) pushText(html.slice(lastIndex));
  return runs;
}

// Splits `html` into top-level block elements. Anything between recognized
// blocks (stray text the editor left unwrapped) becomes an implicit paragraph.
function splitBlocks(html) {
  const blockRe = new RegExp(`<(${BLOCK_TAGS.join('|')})>([\\s\\S]*?)<\\/\\1>`, 'gi');
  const blocks = [];
  let lastIndex = 0;
  let match;
  while ((match = blockRe.exec(html))) {
    if (match.index > lastIndex) {
      const stray = html.slice(lastIndex, match.index).trim();
      if (stray) blocks.push({ tag: 'p', inner: stray });
    }
    blocks.push({ tag: match[1].toLowerCase(), inner: match[2] });
    lastIndex = blockRe.lastIndex;
  }
  if (lastIndex < html.length) {
    const stray = html.slice(lastIndex).trim();
    if (stray) blocks.push({ tag: 'p', inner: stray });
  }
  return blocks;
}

function splitListItems(inner) {
  const liRe = /<li>([\s\S]*?)<\/li>/gi;
  const items = [];
  let match;
  while ((match = liRe.exec(inner))) items.push(match[1]);
  return items;
}

// html -> [{ type: 'h2'|'h3'|'p'|'quote'|'bullet'|'number', runs: [...] }]
function htmlToBlocks(html) {
  if (!html) return [];
  const out = [];
  for (const block of splitBlocks(html)) {
    if (block.tag === 'ul' || block.tag === 'ol') {
      const items = splitListItems(block.inner);
      items.forEach((itemHtml, idx) => {
        out.push({
          type: block.tag === 'ul' ? 'bullet' : 'number',
          index: idx + 1,
          runs: parseInlineRuns(itemHtml),
        });
      });
      continue;
    }
    const type = block.tag === 'blockquote' ? 'quote' : (block.tag === 'div' ? 'p' : block.tag);
    const runs = parseInlineRuns(block.inner);
    if (runs.some((r) => r.text.trim() || r.br)) out.push({ type, runs });
  }
  return out;
}

module.exports = { htmlToBlocks, decodeEntities };
