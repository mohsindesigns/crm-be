// Allowlist HTML sanitizer for admin-authored rich text (document template
// bodies, default terms, per-document scope/terms) — the only place in this
// app that stores and re-renders HTML rather than plain text. Applied on
// every write (services/DocumentTemplateService.js, CustomerDocumentService.js)
// so a stale/compromised admin session or a copy-pasted snippet can't leave
// `<script>`/event-handler HTML sitting in the DB, since this content is later
// dumped verbatim (dangerouslySetInnerHTML) into the public, unauthenticated
// review page.
//
// Strategy: strip every attribute from every tag (no href/src/style/on*, so
// there's no attribute-based vector at all), keep only a small allowlist of
// structural/formatting tags, and drop everything else (script/style content
// removed entirely; any other disallowed tag is unwrapped, keeping its text).

const ALLOWED_TAGS = new Set([
  'h2', 'h3', 'p', 'br', 'b', 'strong', 'i', 'em', 'u', 'ul', 'ol', 'li', 'blockquote', 'div', 'span',
]);

// Tags whose entire contents (not just the tag) must be dropped — never
// unwrapped-and-kept, since their "text" is actually code.
const STRIP_CONTENTS_TAGS = new Set(['script', 'style']);

function sanitizeDocumentHtml(input) {
  if (!input) return '';
  let html = String(input);

  // Drop comments (can be used to smuggle content past naive parsers).
  html = html.replace(/<!--[\s\S]*?-->/g, '');

  // Remove tags whose content is dangerous outright, contents included.
  for (const tag of STRIP_CONTENTS_TAGS) {
    const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi');
    html = html.replace(re, '');
  }

  // Walk every remaining tag (open or close) and either keep it bare
  // (allowlisted, attributes stripped) or drop just the tag (unwrap).
  html = html.replace(/<\/?([a-zA-Z0-9]+)\b[^>]*>/g, (match, rawTag) => {
    const tag = rawTag.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) return '';
    const isClosing = match.startsWith('</');
    if (isClosing) return `</${tag}>`;
    // Self-closing <br> (and tolerate <br/> input) — no attributes ever kept.
    if (tag === 'br') return '<br>';
    return `<${tag}>`;
  });

  return html.trim();
}

module.exports = { sanitizeDocumentHtml };
