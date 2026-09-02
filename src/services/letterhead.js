/**
 * The company letterhead — drawn in code, not stamped from an image.
 *
 * Every generated document (invoices, quotations/agreements, HR letters, SEO
 * reports) puts the same header block at the top of page 1: logo, registered
 * entity name, the office address block(s), tax registration, contact details,
 * and the quoted official-communication note.
 *
 * Previously quotations/agreements were drawn on top of a pre-rendered
 * `mohsin_designs_letterhead.pdf`, which meant the header couldn't be edited
 * without re-exporting artwork, printed fuzzy at small sizes, and wasn't
 * searchable/selectable text. Everything here is real text + a single logo
 * image, so changing the address once updates every document type.
 *
 * ─── Multi-entity ────────────────────────────────────────────────────────────
 * The details no longer come from one WhiteLabelConfig row. An org can register
 * several legal entities (see models/Company.js) and tick, per entity, whether
 * it appears on BILLING documents (invoices, quotations, agreements, proposals)
 * or HR documents (appointment/experience/bank letters, salary slips) — or both.
 *
 * That check is what this module renders:
 *   • one entity ticked  → only that entity's block prints
 *   • both ticked        → both blocks print, stacked
 *   • none ticked        → falls back to the legacy WhiteLabelConfig letterhead
 *
 * Entities sharing a legal name (the common case — one company, a US office and
 * a Pakistan office) print the name once with an office block each, which is
 * exactly what the single-config letterhead used to produce. Entities with
 * different legal names each get their own heading.
 *
 * Two renderers are exported because the codebase runs two PDF stacks:
 *   • drawPdfLibLetterhead — pdf-lib (invoices, customer documents)
 *   • drawPdfKitLetterhead — pdfkit  (HR letters, salary slips, SEO reports)
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { rgb, PDFName, PDFArray, PDFString } = require('pdf-lib');
const { wrapText } = require('./pdfLetterheadUtils');

/** Clickable URI annotation — used for "PAY INVOICE" on invoice PDFs. */
function addUriLinkAnnotation(page, { x, y, width, height, url }) {
  if (!url || !page?.doc?.context) return;
  const ctx = page.doc.context;
  const annot = ctx.obj({
    Type: 'Annot',
    Subtype: 'Link',
    Rect: [x, y, x + width, y + height],
    Border: [0, 0, 0],
    A: {
      Type: 'Action',
      S: 'URI',
      URI: PDFString.of(String(url)),
    },
  });
  let annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
  if (!annots) {
    annots = ctx.obj([]);
    page.node.set(PDFName.of('Annots'), annots);
  }
  annots.push(annot);
}

// Fallbacks used when neither companies nor Admin → Branding have been filled
// in. These are the live Mohsin Designs LLC details, so a fresh install still
// produces a correct letterhead out of the box.
const LETTERHEAD_DEFAULTS = {
  legalName: 'MOHSIN DESIGNS LLC',
  usOfficeAddress: '312 W 2nd St\nUnit #A7077\nCasper, WY 82601',
  einNumber: '37-2241622',
  pkOfficeAddress: '5th Floor\nZ Collective Gohar Rabi Center\nTariq Road, Karachi-Pakistan 74200',
  contactEmail: 'info@mohsindesigns.com',
  businessPhone: '+1-(307)-449-2070',
  letterheadNote:
    'For all official matters, the preferred communication channel is email, and no verbal '
    + 'commitment will be regarded as authentic or binding & All payments instruments must be '
    + 'made in the name of Mohsin Designs LLC',
};

const pick = (value, fallback = '') => {
  const s = value == null ? '' : String(value).trim();
  return s || fallback;
};

/**
 * Normalizes a WhiteLabelConfig row (or plain object, or null) into the flat
 * shape both renderers consume. Blank strings fall back to the defaults the
 * same way missing fields do — an admin clearing a field shouldn't silently
 * produce a letterhead with a gap in the address block.
 *
 * Retained for callers that still work from branding alone; `resolveEntities`
 * is the multi-company entry point.
 */
function resolveLetterhead(config) {
  return {
    legalName: pick(config?.legalName, LETTERHEAD_DEFAULTS.legalName),
    usOfficeAddress: pick(config?.usOfficeAddress, LETTERHEAD_DEFAULTS.usOfficeAddress),
    pkOfficeAddress: pick(config?.pkOfficeAddress, LETTERHEAD_DEFAULTS.pkOfficeAddress),
    einNumber: pick(config?.einNumber, LETTERHEAD_DEFAULTS.einNumber),
    contactEmail: pick(config?.contactEmail, LETTERHEAD_DEFAULTS.contactEmail),
    businessPhone: pick(config?.businessPhone, LETTERHEAD_DEFAULTS.businessPhone),
    website: pick(config?.website, ''),
    taxNumber: pick(config?.taxNumber, ''),
    letterheadNote: pick(config?.letterheadNote, LETTERHEAD_DEFAULTS.letterheadNote),
    brandName: pick(config?.brandName, 'Mohsin Designs'),
    logoUrl: pick(config?.logoUrl, ''),
  };
}

/**
 * Build the renderable letterhead from the companies ticked for a document
 * category, falling back to the legacy branding row when none are.
 *
 * @param {Array} companies  Company rows (or plain objects) already filtered to
 *   the document category by Company.forCategory().
 * @param {object|null} config  WhiteLabelConfig row, used as the fallback and
 *   for the brand name.
 */
function resolveEntities(companies, config) {
  const rows = (companies || []).filter(Boolean).map((c) => (c.toJSON ? c.toJSON() : c));
  const brandName = pick(config?.brandName, 'Mohsin Designs');

  if (!rows.length) {
    // Legacy shape: one config row carrying a US block and a PK block. Split it
    // into the same entity list so downstream rendering has a single code path.
    const lh = resolveLetterhead(config);
    const entities = [];
    if (lh.usOfficeAddress) {
      entities.push({
        legalName: lh.legalName,
        officeLabel: 'US Office',
        address: lh.usOfficeAddress,
        taxLabel: 'EIN',
        taxNumber: lh.einNumber,
        email: lh.contactEmail,
        phone: lh.businessPhone,
        website: lh.website,
        logoUrl: '',
      });
    }
    if (lh.pkOfficeAddress) {
      entities.push({
        legalName: lh.legalName,
        officeLabel: 'Pakistan Office',
        address: lh.pkOfficeAddress,
        // The legacy row's generic `taxNumber` only belongs to the PK side when
        // it differs from the EIN already printed above.
        taxLabel: 'NTN',
        taxNumber: lh.taxNumber && lh.taxNumber !== lh.einNumber ? lh.taxNumber : '',
        email: lh.contactEmail,
        phone: lh.businessPhone,
        website: lh.website,
        logoUrl: '',
      });
    }
    if (!entities.length) {
      entities.push({
        legalName: lh.legalName,
        officeLabel: 'Office',
        address: '',
        taxLabel: 'EIN',
        taxNumber: lh.einNumber,
        email: lh.contactEmail,
        phone: lh.businessPhone,
        website: lh.website,
        logoUrl: '',
      });
    }
    return {
      entities,
      // The issuing entity's name, for callers that need it as a plain string
      // (PDF metadata, document footers) rather than as a rendered block.
      legalName: entities[0].legalName,
      note: lh.letterheadNote,
      logoUrl: '',
      brandName,
      invoiceNotes: config?.invoiceNotes || '',
      invoiceTerms: config?.invoiceTerms || '',
      fromCompanies: false,
    };
  }

  const entities = rows.map((c) => ({
    legalName: pick(c.legalName, LETTERHEAD_DEFAULTS.legalName),
    officeLabel: pick(c.officeLabel, 'Office'),
    address: pick(c.address, ''),
    taxLabel: pick(c.taxLabel, 'EIN'),
    taxNumber: pick(c.taxNumber, ''),
    email: pick(c.email, ''),
    phone: pick(c.phone, ''),
    website: pick(c.website, ''),
    logoUrl: pick(c.logoUrl, ''),
  }));

  return {
    entities,
    legalName: entities[0].legalName,
    // A shared note printed once beneath the address blocks. Two entities with
    // identical notes must not print the same paragraph twice.
    note: pick(rows.find((c) => pick(c.letterheadNote))?.letterheadNote, LETTERHEAD_DEFAULTS.letterheadNote),
    logoUrl: pick(rows.find((c) => pick(c.logoUrl))?.logoUrl, ''),
    brandName,
    // Billing copy comes from the issuing entity, falling back to the org's.
    invoiceNotes: pick(rows.find((c) => pick(c.invoiceNotes))?.invoiceNotes, config?.invoiceNotes || ''),
    invoiceTerms: pick(rows.find((c) => pick(c.invoiceTerms))?.invoiceTerms, config?.invoiceTerms || ''),
    fromCompanies: true,
  };
}

/**
 * Convenience wrapper: load the companies ticked for a category and resolve
 * them against the org's branding row in one call.
 *
 * @param {string} orgId
 * @param {'billing'|'hr'} category
 */
/**
 * The legal entity that issues a client-facing commercial document.
 *
 *   Pay via CRM (Stripe)  → the LLC
 *   Anything else         → the LLP
 *
 * Deliberately NOT configurable, and read from every ACTIVE company rather than
 * the ones ticked in Admin → Companies. Both matter: this used to key off the
 * "Primary" star and the "Use for invoices & quotations" checkbox, so a toggle
 * in the admin UI silently moved documents onto the wrong legal entity. Which
 * entity bills a client is a tax-reporting fact, not a preference.
 *
 * Shared by InvoiceService and CustomerDocumentService so an invoice and the
 * quotation it came from can never disagree about who is selling.
 *
 * @param {boolean} isStripe  whether this client pays via Stripe
 * @returns {Promise<object|null>} the Company row, or null if the org has none
 */
async function billingCompanyFor(orgId, isStripe, { transaction = null } = {}) {
  const db = require('../models');
  const all = await db.Company.findAll({
    where: { orgId, isActive: true },
    order: [['isPrimary', 'DESC'], ['sortOrder', 'ASC'], ['createdAt', 'ASC']],
    transaction,
  });
  if (!all.length) return null;

  const wanted = isStripe ? /\bLLC\b/i : /\bLLP\b/i;
  const named = (c) => `${c.legalName || ''} ${c.name || ''} ${c.code || ''}`;
  const match = all.find((c) => wanted.test(named(c)));
  if (match) return match;

  // No entity carries LLC/LLP in its name — an org not using that structure.
  // Fall back to the positional split so those installs still behave sensibly.
  console.warn(
    `[letterhead] No ${isStripe ? 'LLC' : 'LLP'} company for org ${orgId}; using primary/secondary order. `
    + 'Name the entities so Stripe and manual documents bill from the right one.',
  );
  const billing = all.filter((c) => c.useForBilling);
  const pool = billing.length ? billing : all;
  if (isStripe) return pool[0];
  return pool.find((c) => c.id !== pool[0].id) || pool[0];
}

/**
 * A resolved letterhead for the entity that should issue this client's
 * commercial documents. Falls back to the org-wide billing letterhead when the
 * org has no companies configured at all.
 */
async function letterheadForClient(orgId, isStripe) {
  const db = require('../models');
  const [company, config] = await Promise.all([
    billingCompanyFor(orgId, isStripe).catch(() => null),
    db.WhiteLabelConfig.findOne({ where: { orgId } }).catch(() => null),
  ]);
  const plainConfig = config ? config.toJSON() : null;
  if (!company) return resolveEntities(null, plainConfig);
  return resolveEntities([company], plainConfig);
}

async function letterheadForOrg(orgId, category) {
  // Required lazily: models/index.js pulls in services during association setup,
  // so a top-level require here would be circular.
  const db = require('../models');
  const [companies, config] = await Promise.all([
    db.Company.forCategory(orgId, category).catch(() => []),
    db.WhiteLabelConfig.findOne({ where: { orgId } }).catch(() => null),
  ]);
  const resolved = resolveEntities(companies, config ? config.toJSON() : null);

  // The letterhead note is a COMMERCIAL statement — "no verbal commitment is
  // binding, all payment instruments must be made in the name of …". That
  // belongs on quotations and invoices, not on an employee's payslip or
  // experience letter, where it reads as boilerplate aimed at the wrong reader.
  // Dropped for the HR category here rather than at each HR renderer, so every
  // current and future HR document inherits the right behaviour.
  if (category === 'hr') return { ...resolved, note: '' };
  return resolved;
}

/**
 * The header body, as an ordered list of renderable entries:
 *
 *   { type: 'heading', value }            → a legal entity name, bolded
 *   { type: 'line', label, value }        → an address/contact line
 *   { type: 'gap' }                       → vertical breathing room
 *
 * Entities sharing a legal name are grouped under one heading, so the ordinary
 * "one company, two offices" case reads exactly as it always has. Contact
 * details common to every entity print once at the bottom; details unique to
 * one entity print inside that entity's block.
 */
function letterheadBlocks(resolved) {
  const entities = resolved?.entities || [];
  if (!entities.length) return [];

  const out = [];
  const pushAddress = (label, value) => {
    const s = String(value || '').trim();
    if (!s) return;
    const parts = s.split(/\r?\n/).map((p) => p.trim()).filter(Boolean);
    parts.forEach((part, i) => out.push({ type: 'line', label: i === 0 ? label : null, value: part }));
  };

  // Contact values shared by every entity are hoisted out of the per-entity
  // blocks so a two-office letterhead doesn't print the same email twice.
  const shared = {};
  for (const field of ['email', 'phone', 'website']) {
    const values = entities.map((e) => e[field]).filter(Boolean);
    if (values.length === entities.length && new Set(values).size === 1) {
      shared[field] = values[0];
    }
  }

  // Preserve tick order while grouping by legal name.
  const groups = [];
  for (const entity of entities) {
    const existing = groups.find((g) => g.legalName === entity.legalName);
    if (existing) existing.items.push(entity);
    else groups.push({ legalName: entity.legalName, items: [entity] });
  }

  // `showHeading` is set by `filterLetterheadFields`; absent (undefined) for
  // every other caller, which keeps the heading on by default.
  const showHeading = resolved.showHeading !== false;

  groups.forEach((group, gi) => {
    if (gi > 0) out.push({ type: 'gap' });
    if (showHeading) out.push({ type: 'heading', value: group.legalName });

    for (const entity of group.items) {
      pushAddress(`${entity.officeLabel}:`, entity.address);
      if (entity.taxNumber) {
        out.push({ type: 'line', label: `${entity.taxLabel}:`, value: entity.taxNumber });
      }
      if (entity.email && !shared.email) out.push({ type: 'line', label: 'email:', value: entity.email });
      if (entity.phone && !shared.phone) out.push({ type: 'line', label: 'phone:', value: entity.phone });
      if (entity.website && !shared.website) out.push({ type: 'line', label: 'web:', value: entity.website });
    }
  });

  if (shared.email) out.push({ type: 'line', label: 'email:', value: shared.email });
  if (shared.phone) out.push({ type: 'line', label: 'phone:', value: shared.phone });
  if (shared.website) out.push({ type: 'line', label: 'web:', value: shared.website });

  return out;
}

/**
 * Back-compat shim for the original single-config API: returns just the
 * `{ label, value }` address lines, with entity names folded in as unlabelled
 * lines. New code should use `letterheadBlocks`.
 */
function letterheadLines(lh) {
  const resolved = lh?.entities ? lh : resolveEntities(null, lh);
  return letterheadBlocks(resolved)
    .filter((b) => b.type === 'line')
    .map(({ label, value }) => ({ label, value }));
}

/**
 * Field keys a "what company details show on this export" checkbox list lets
 * a caller toggle per document.
 */
const LETTERHEAD_FIELD_KEYS = ['logo', 'name', 'address', 'tax', 'email', 'phone', 'website', 'note'];

/**
 * Normalizes a checkbox selection from a request into what a caller stores or
 * forwards: an array of the enabled keys, or null meaning "not specified" —
 * anyone who never passes the option keeps showing everything, the
 * pre-existing default.
 */
function normalizeLetterheadFields(input) {
  if (!Array.isArray(input)) return null;
  return input.filter((k) => LETTERHEAD_FIELD_KEYS.includes(k));
}

/**
 * Applies a stored field selection to a resolved letterhead before it's drawn
 * — clears whichever contact/address fields weren't ticked. `fields` null (not
 * specified) means "show everything", the pre-existing default.
 *
 * Logo visibility is deliberately NOT handled here — see `letterheadShowsLogo`.
 * `loadLetterheadLogo` treats a blank URL as "fall back to the bundled default
 * wordmark", not "draw nothing", so clearing `logoUrl` here would print a logo
 * instead of suppressing it.
 *
 * The legal-name heading is handled via `showHeading` (consumed by
 * `letterheadBlocks`) rather than by blanking `legalName` on each entity —
 * `legalName` is also used to group entities sharing a name, so clearing it
 * here would break that grouping.
 */
function filterLetterheadFields(resolved, fields) {
  if (!resolved || fields == null) return resolved;
  const enabled = new Set(fields);
  const entities = (resolved.entities || []).map((e) => ({
    ...e,
    address: enabled.has('address') ? e.address : '',
    taxNumber: enabled.has('tax') ? e.taxNumber : '',
    email: enabled.has('email') ? e.email : '',
    phone: enabled.has('phone') ? e.phone : '',
    website: enabled.has('website') ? e.website : '',
  }));
  return {
    ...resolved, entities, note: enabled.has('note') ? resolved.note : '', showHeading: enabled.has('name'),
  };
}

/** Whether the logo should be drawn at all — see `filterLetterheadFields`. */
function letterheadShowsLogo(fields) {
  return fields == null || fields.includes('logo');
}

// ─── Logo ─────────────────────────────────────────────────────────────────────

// PNG, not the original JPEG — the source logo was a progressive JPEG, which
// pdf-lib will embed without erroring but which many PDF viewers render
// inconsistently (blank/missing) since progressive DCT isn't universally
// supported inside a PDF's DCTDecode filter.
function resolveLogoPath() {
  // Prefer the Mohsin Designs wordmark used on invoices / quotations / letters.
  // LOGO_IMAGE_PATH overrides everything for deploys that store the file elsewhere.
  const candidates = [
    process.env.LOGO_IMAGE_PATH,
    path.join(__dirname, '../../assets/logo.png'),
    path.join(__dirname, '../../assets/mohsin-designs-logo.png'),
    path.join(__dirname, '../../../cadence-fe/public/MOHSIN-DESIGN-LOGO (1).png'),
    path.join(__dirname, '../../../cadence-fe/public/logo-file.png'),
    path.join(__dirname, '../../../frontend/public/logo-file.png'),
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function readLogoBuffer() {
  const p = resolveLogoPath();
  if (!p) return null;
  try {
    return { buffer: fs.readFileSync(p), ext: path.extname(p).toLowerCase() };
  } catch {
    return null;
  }
}

// Remote company logos are fetched once per process. Document generation is
// hot (an invoice list can render several PDFs back to back) and the artwork
// changes about never, so re-downloading it each time is pure latency.
const remoteLogoCache = new Map();

function fetchRemoteLogo(url) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    try {
      const transport = url.startsWith('https:') ? https : http;
      const req = transport.get(url, (res) => {
        if (res.statusCode !== 200) { res.resume(); return done(null); }
        const type = String(res.headers['content-type'] || '');
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          // A "logo" larger than this is a mistake; don't buffer it into a PDF.
          if (size > 5 * 1024 * 1024) { req.destroy(); return done(null); }
          chunks.push(c);
        });
        res.on('end', () => done({
          buffer: Buffer.concat(chunks),
          ext: /jpe?g/i.test(type) || /\.jpe?g($|\?)/i.test(url) ? '.jpg' : '.png',
        }));
        return undefined;
      });
      req.setTimeout(4000, () => { req.destroy(); done(null); });
      req.on('error', () => done(null));
    } catch {
      done(null);
    }
  });
}

/**
 * The logo to stamp on a document: the issuing company's own artwork when it has
 * some, otherwise the bundled Mohsin Designs wordmark. Never throws and never
 * blocks a document — an unreachable media server produces a text-only header
 * rather than a failed PDF.
 */
async function loadLetterheadLogo(logoUrl) {
  const url = String(logoUrl || '').trim();
  if (!url) return readLogoBuffer();
  if (remoteLogoCache.has(url)) return remoteLogoCache.get(url) || readLogoBuffer();

  const fetched = /^https?:\/\//i.test(url) ? await fetchRemoteLogo(url) : null;
  remoteLogoCache.set(url, fetched);
  return fetched || readLogoBuffer();
}

// ─── pdf-lib renderer ─────────────────────────────────────────────────────────

const LH_TEXT = rgb(0.13, 0.13, 0.13);
const LH_MUTED = rgb(0.42, 0.45, 0.50);
const LH_RULE = rgb(0.80, 0.83, 0.87);

/**
 * Draws the letterhead into a pdf-lib page and returns the Y coordinate content
 * may start at. The caller owns page/margin geometry; this only draws inside the
 * band it's given.
 *
 * Layout follows the reference invoice exactly — a title row across the top,
 * then two columns running in parallel beneath it:
 *
 *   [logo]                                    INVOICE     ← titleBlock
 *                                          # INV-0002
 *                                              DRAFT
 *
 *   MOHSIN DESIGNS LLC                        Bill To:    ← rightColumn starts
 *   US Office: 312 W 2nd St                  VERENSOFT      level with the
 *   …                                    Daniyal Ahmed      company block
 *   Note: "For all official matters…"  Invoice Date: …
 *   ───────────────────────────────────────────────────
 *
 * `titleBlock` prints right-aligned at the very top (document type, number,
 * status). `rightColumn` prints right-aligned starting level with the company
 * name — the recipient block. Both are `{ text, size, bold, color, gap }`
 * entries; an entry with `spacer: true` just advances Y.
 *
 * `letterhead` accepts either a resolved multi-entity object (from
 * `resolveEntities`/`letterheadForOrg`) or a legacy single-config object.
 */
async function drawPdfLibLetterhead(outDoc, page, {
  letterhead,
  font,
  fontBold,
  marginLeft,
  contentWidth,
  top,
  titleBlock = [],
  rightColumn = [],
  accentColor = rgb(0.10, 0.25, 0.45),
  // Callers (e.g. invoices) can pass a larger wordmark; default keeps other
  // documents at the compact letterhead size.
  logoHeight = 26,
  // Invoices omit the shared letterhead "Note:" paragraph.
  omitNote = false,
}) {
  const resolved = letterhead?.entities ? letterhead : resolveEntities(null, letterhead);
  const blocks = letterheadBlocks(resolved);
  const rightEdge = marginLeft + contentWidth;
  let y = top;

  /**
   * Draws right-aligned entries downward from `startY`; returns the ending Y.
   *
   * `ry` tracks the TOP of each line box and text is drawn at `ry - size`, so an
   * entry's advance must never be smaller than its own type size or the next
   * line lands on top of it — which is exactly how an 18pt "INVOICE" given a
   * 13pt gap ended up overlapping the invoice number beneath it. The floor here
   * makes that impossible regardless of what a caller passes.
   */
  function drawRightEntries(entries, startY, maxWidth) {
    let ry = startY;
    for (const entry of entries) {
      const size = entry.size || 10;
      const advance = Math.max(entry.gap || 12.5, size + 3);
      if (entry.spacer) { ry -= (entry.gap || size); continue; }

      // Composite right-aligned line, e.g. "OVERDUE - PAY INVOICE" where the
      // last segment is a clickable green link (matches the BizCore reference).
      if (Array.isArray(entry.segments) && entry.segments.length) {
        const parts = entry.segments.map((seg) => {
          const f = seg.bold ? fontBold : font;
          const text = String(seg.text || '');
          return {
            text,
            font: f,
            color: seg.color || accentColor,
            url: seg.url || null,
            width: f.widthOfTextAtSize(text, size),
          };
        });
        const totalW = parts.reduce((sum, p) => sum + p.width, 0);
        let x = rightEdge - totalW;
        const textY = ry - size;
        for (const p of parts) {
          page.drawText(p.text, { x, y: textY, size, font: p.font, color: p.color });
          if (p.url) {
            addUriLinkAnnotation(page, {
              x,
              y: textY - 2,
              width: Math.max(p.width, 8),
              height: size + 4,
              url: p.url,
            });
          }
          x += p.width;
        }
        ry -= advance;
        continue;
      }

      const f = entry.bold ? fontBold : font;
      // Long recipient lines wrap within the column instead of running left
      // across the company block.
      const lines = maxWidth ? wrapText(entry.text, f, size, maxWidth) : [entry.text];
      for (const line of lines) {
        const textWidth = f.widthOfTextAtSize(line, size);
        const x = rightEdge - textWidth;
        const textY = ry - size;
        page.drawText(line, {
          x,
          y: textY,
          size,
          font: f,
          color: entry.color || accentColor,
        });
        if (entry.url) {
          addUriLinkAnnotation(page, {
            x,
            y: textY - 2,
            width: Math.max(textWidth, 8),
            height: size + 4,
            url: entry.url,
          });
        }
        ry -= advance;
      }
    }
    return ry;
  }

  // ── Title row: logo left, document title right ─────────────────────────────
  const logo = await loadLetterheadLogo(resolved.logoUrl);
  let logoBottom = y;
  if (logo) {
    try {
      const image = logo.ext === '.png'
        ? await outDoc.embedPng(logo.buffer)
        : await outDoc.embedJpg(logo.buffer);
      const logoH = Math.max(16, Number(logoHeight) || 26);
      const logoW = image.width * (logoH / image.height);
      page.drawImage(image, { x: marginLeft, y: y - logoH, width: logoW, height: logoH });
      logoBottom = y - logoH;
    } catch {
      // Malformed logo — carry on with a text-only letterhead rather than
      // failing the whole document.
    }
  }
  const titleBottom = titleBlock.length ? drawRightEntries(titleBlock, y) : y;

  // Both columns below start under whichever of the two is taller.
  const columnTop = Math.min(logoBottom, titleBottom) - 16;

  // ── Left column: company block(s) + note ───────────────────────────────────
  const columnGap = 28;
  const leftWidth = rightColumn.length ? contentWidth * 0.55 - columnGap / 2 : contentWidth;
  const rightWidth = contentWidth * 0.45 - columnGap / 2;

  // 10pt on a 12.5pt line, matching the reference invoice's header block
  // measured glyph-for-glyph — the address previously set at 7.8pt read as
  // noticeably smaller and lighter than the document it's modelled on. Two
  // entities stacked in the same band get a slightly tighter setting so the
  // header doesn't push the invoice table onto page 2.
  const dense = blocks.filter((b) => b.type !== 'gap').length > 9;
  const BODY_SIZE = dense ? 8.6 : 10;
  const BODY_GAP = dense ? 10.8 : 12.5;

  y = columnTop;
  for (const block of blocks) {
    if (block.type === 'gap') { y -= BODY_GAP * 0.55; continue; }

    if (block.type === 'heading') {
      page.drawText(block.value, {
        x: marginLeft, y: y - BODY_SIZE, size: BODY_SIZE, font: fontBold, color: accentColor,
      });
      y -= BODY_GAP;
      continue;
    }

    let x = marginLeft;
    if (block.label) {
      page.drawText(block.label, { x, y: y - BODY_SIZE, size: BODY_SIZE, font: fontBold, color: LH_TEXT });
      x += fontBold.widthOfTextAtSize(block.label, BODY_SIZE) + 3;
    }
    const wrapped = wrapText(block.value, font, BODY_SIZE, Math.max(60, leftWidth - (x - marginLeft)));
    page.drawText(wrapped[0], { x, y: y - BODY_SIZE, size: BODY_SIZE, font, color: LH_TEXT });
    y -= BODY_GAP;
    for (const extra of wrapped.slice(1)) {
      page.drawText(extra, { x: marginLeft, y: y - BODY_SIZE, size: BODY_SIZE, font, color: LH_TEXT });
      y -= BODY_GAP;
    }
  }

  if (!omitNote && resolved.note) {
    y -= dense ? 8 : 12; // blank line between the contact details and the note
    page.drawText('Note:', { x: marginLeft, y: y - BODY_SIZE, size: BODY_SIZE, font: fontBold, color: LH_MUTED });
    const noteX = marginLeft + fontBold.widthOfTextAtSize('Note:', BODY_SIZE) + 4;
    const noteLines = wrapText(`"${resolved.note}"`, font, BODY_SIZE, Math.max(120, leftWidth - (noteX - marginLeft)));
    for (let i = 0; i < noteLines.length; i += 1) {
      page.drawText(noteLines[i], {
        x: i === 0 ? noteX : marginLeft,
        y: y - BODY_SIZE,
        size: BODY_SIZE,
        font,
        color: LH_MUTED,
      });
      y -= BODY_GAP;
    }
  }

  // ── Right column: recipient block, level with the company block ────────────
  const rightBottom = rightColumn.length ? drawRightEntries(rightColumn, columnTop, rightWidth) : y;

  y = Math.min(y, rightBottom) - 10;

  page.drawLine({
    start: { x: marginLeft, y },
    end: { x: rightEdge, y },
    thickness: 1.2,
    color: accentColor,
  });
  y -= 3;
  page.drawLine({
    start: { x: marginLeft, y },
    end: { x: rightEdge, y },
    thickness: 0.4,
    color: LH_RULE,
  });

  return y - 14;
}

// ─── pdfkit renderer ──────────────────────────────────────────────────────────

/**
 * pdfkit equivalent of the above, for the report/letter side of the codebase.
 * Returns the Y coordinate content may start at. `subtitle` prints right-aligned
 * opposite the company block (e.g. "Salary Slip · March 2026").
 *
 * Synchronous, so it uses whatever logo buffer the caller resolved (or the
 * bundled default). Callers wanting a company's own remote logo should await
 * `loadLetterheadLogo` and pass the result as `logo`.
 */
function drawPdfKitLetterhead(doc, letterhead, {
  title, subtitle, color = '#0B1D5E', logo = undefined,
} = {}) {
  const resolved = letterhead?.entities ? letterhead : resolveEntities(null, letterhead);
  const blocks = letterheadBlocks(resolved);
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const usable = right - left;
  const top = doc.page.margins.top;

  const textLeft = left;
  let blockTop = top;
  const art = logo === undefined ? readLogoBuffer() : logo;
  if (art) {
    try {
      // Wide horizontal wordmark — sized by height, stacked above the address
      // block (see the pdf-lib renderer for why it isn't set alongside).
      const logoH = 40;
      doc.image(art.buffer, left, top, { height: logoH });
      blockTop = top + logoH + 8;
    } catch {
      // Skip a malformed logo rather than failing the document.
    }
  }

  doc.y = blockTop;
  doc.x = textLeft;

  const bodySize = blocks.filter((b) => b.type !== 'gap').length > 9 ? 6.6 : 7.2;

  for (const block of blocks) {
    if (block.type === 'gap') { doc.moveDown(0.3); continue; }

    if (block.type === 'heading') {
      doc.font('Helvetica-Bold').fontSize(11).fillColor(color)
        .text(block.value, textLeft, doc.y, { width: usable * 0.6 });
      doc.font('Helvetica').fontSize(bodySize).fillColor('#222222');
      continue;
    }

    doc.font('Helvetica').fontSize(bodySize).fillColor('#222222');
    const y = doc.y;
    if (block.label) {
      doc.font('Helvetica-Bold').text(block.label, textLeft, y, { continued: true, width: usable * 0.6 });
      doc.font('Helvetica').text(` ${block.value}`, { width: usable * 0.6 });
    } else {
      doc.font('Helvetica').text(block.value, textLeft, y, { width: usable * 0.6 });
    }
  }

  const companyBottom = doc.y;

  // Right-hand title/subtitle block, drawn from the top of the header band.
  if (title || subtitle) {
    if (title) {
      doc.font('Helvetica-Bold').fontSize(16).fillColor(color)
        .text(title, left + usable * 0.55, top, { width: usable * 0.45, align: 'right' });
    }
    if (subtitle) {
      doc.font('Helvetica').fontSize(8.5).fillColor('#888888')
        .text(subtitle, left + usable * 0.55, doc.y + 2, { width: usable * 0.45, align: 'right' });
    }
  }

  doc.y = Math.max(companyBottom, doc.y) + 4;

  if (resolved.note) {
    doc.font('Helvetica-Bold').fontSize(6.8).fillColor('#888888')
      .text('Note:', left, doc.y, { continued: true, width: usable });
    doc.font('Helvetica').text(` "${resolved.note}"`, { width: usable });
  }

  doc.moveDown(0.4);
  const ruleY = doc.y;
  doc.moveTo(left, ruleY).lineTo(right, ruleY).lineWidth(1.2).strokeColor(color).stroke();
  doc.moveTo(left, ruleY + 2.5).lineTo(right, ruleY + 2.5).lineWidth(0.4).strokeColor('#D0D5DD').stroke();
  doc.x = left;
  doc.y = ruleY + 12;
  doc.fillColor('#222222');
  return doc.y;
}

module.exports = {
  LETTERHEAD_DEFAULTS,
  resolveLetterhead,
  resolveEntities,
  letterheadForOrg,
  billingCompanyFor,
  letterheadForClient,
  letterheadBlocks,
  letterheadLines,
  LETTERHEAD_FIELD_KEYS,
  normalizeLetterheadFields,
  filterLetterheadFields,
  letterheadShowsLogo,
  resolveLogoPath,
  readLogoBuffer,
  loadLetterheadLogo,
  drawPdfLibLetterhead,
  drawPdfKitLetterhead,
};
