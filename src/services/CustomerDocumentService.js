const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { Op } = require('sequelize');
const db = require('../models');
const ClientService = require('./ClientService');
const RetainerService = require('./RetainerService');
const InvoiceService = require('./InvoiceService');
const EmailService = require('./EmailService');
const { buildProjectName } = require('../utils/projectName');
const { buildMergeTokens, renderTemplate, renderHtmlTemplate, ensureHtml, defaultServiceFragment, formatFeatures } = require('../utils/documentRenderer');
const { buildDocumentPdfOnLetterhead } = require('./DocumentLetterheadPdf');
const { letterheadForOrg, letterheadForClient, billingCompanyFor } = require('./letterhead');
const { isTruthy } = require('./SoftDeleteService');
const { sanitizeDocumentHtml } = require('../utils/htmlSanitizer');

const EDITABLE_STATUSES = ['draft', 'rejected', 'expired'];
// Templates saved with this serviceTypeKey aren't tied to any service — they
// act as the fallback for every service and host multi-service wrapper bodies.
const STANDARD_SERVICE_KEY = 'standard';

// Same default as InvoiceService — quotations/agreements/proposals print the
// org's Admin → Branding → Terms & Conditions (invoiceTerms) so commercial
// T&Cs stay consistent across every client-facing PDF.
const DEFAULT_DOCUMENT_TERMS = 'This invoice covers only the items listed above. Any additional work outside this scope will be billed separately. Please settle payment by the due date to avoid late fees or service interruption.';

class CustomerDocumentService {
  async list(orgId, filters = {}) {
    const page = Math.max(1, parseInt(filters.page) || 1);
    const limit = Math.min(100, parseInt(filters.limit) || 25);
    const offset = (page - 1) * limit;

    const where = { orgId };
    // Deactivated documents are hidden unless explicitly asked for.
    if (!isTruthy(filters.includeInactive)) where.isActive = true;
    if (filters.status) where.status = filters.status;
    if (filters.type) where.type = filters.type;
    // Documents raised against an existing client have clientId set; older
    // ones (raised before that flow existed) only get a client at approval
    // time, via convertedClientId — match either so a client's document
    // history isn't missing pre-flow rows (see the clientId column comment).
    // Kept in Op.and (rather than assigning where[Op.or] directly) so it
    // composes with the search Op.or below instead of one clobbering the other.
    if (filters.clientId) {
      where[Op.and] = [
        ...(where[Op.and] || []),
        { [Op.or]: [{ clientId: filters.clientId }, { convertedClientId: filters.clientId }] },
      ];
    }
    if (filters.search) {
      where[Op.and] = [
        ...(where[Op.and] || []),
        {
          [Op.or]: [
            { number: { [Op.like]: `%${filters.search}%` } },
            { prospectName: { [Op.like]: `%${filters.search}%` } },
            { businessName: { [Op.like]: `%${filters.search}%` } },
            { email: { [Op.like]: `%${filters.search}%` } },
          ],
        },
      ];
    }

    const { count, rows } = await db.CustomerDocument.findAndCountAll({
      where,
      include: [{ model: db.DocumentTemplate, as: 'template', attributes: ['id', 'name'] }],
      order: [['createdAt', 'DESC']],
      limit,
      offset,
    });

    return { data: rows, total: count, page, totalPages: Math.ceil(count / limit) || 1, limit };
  }

  async findById(id, orgId) {
    const document = await db.CustomerDocument.findOne({
      where: { id, orgId },
      include: [
        { model: db.DocumentTemplate, as: 'template' },
        { model: db.Package, as: 'package', attributes: ['id', 'name', 'tier', 'price', 'isRecurring', 'billingCycle'] },
        { model: db.Package, as: 'selectedPackage', attributes: ['id', 'name', 'tier', 'price', 'currency'] },
        { model: db.Client, as: 'client', attributes: ['id', 'name', 'billingMode', 'defaultCurrency'] },
        { model: db.Client, as: 'convertedClient', attributes: ['id', 'name'] },
        { model: db.Project, as: 'convertedProject', attributes: ['id', 'name'] },
        { model: db.DocumentEvent, as: 'events', separate: true, order: [['createdAt', 'ASC']] },
      ],
    });
    if (!document) {
      const err = new Error('Document not found.');
      err.status = 404;
      throw err;
    }

    // Side-load option details so admin UI can show a min–max range before approval.
    const optionIds = Array.isArray(document.packageOptions) ? document.packageOptions : [];
    if (optionIds.length > 1) {
      const packageOptionDetails = await db.Package.findAll({
        where: { id: optionIds, orgId },
        attributes: ['id', 'name', 'tier', 'price', 'currency', 'isRecurring', 'billingCycle'],
        order: [['price', 'ASC']], // cheapest first — see _resolvePackageMenuDetails
      });
      const prices = packageOptionDetails.map((p) => Number(p.price) || 0);
      document.dataValues.packageOptionDetails = packageOptionDetails;
      document.dataValues.pricingMode = 'compare';
      document.dataValues.optionMinPrice = prices.length ? Math.min(...prices) : null;
      document.dataValues.optionMaxPrice = prices.length ? Math.max(...prices) : null;
    }

    const menu = Array.isArray(document.packageMenu) ? document.packageMenu : [];
    if (menu.length) {
      document.dataValues.packageMenuDetails = await this._resolvePackageMenuDetails(menu, orgId);
      document.dataValues.pricingMode = 'menu';
    }
    return document;
  }

  /**
   * The next document number, as `MDL-QT-26-0001` — issuing company, document
   * type (QT / AGR / PRO), year, sequence — so the entity, kind and vintage read
   * straight off the number.
   *
   * Quotations and agreements are billing documents, so the prefix follows the
   * same hard rule as invoice numbering (see InvoiceService#_nextNumber /
   * letterhead.billingCompanyFor): a client on "Pay via CRM" is quoted by the
   * LLC, everyone else by the LLP. A document with no linked client (legacy, or
   * a cold prospect) falls back to whichever company is ticked primary for
   * billing. Orgs with no companies configured keep the legacy `DOC-0001`
   * scheme so nothing renumbers on upgrade.
   */
  async _nextNumber(orgId, type = null, { transaction = null, isStripe = null } = {}) {
    const company = isStripe === null
      ? await db.Company.primaryFor(orgId, 'billing').catch(() => null)
      : await billingCompanyFor(orgId, isStripe, { transaction }).catch(() => null);

    if (!company) {
      const last = await db.CustomerDocument.findOne({
        where: { orgId, number: { [Op.like]: 'DOC-%' } },
        order: [['number', 'DESC']],
        attributes: ['number'],
        transaction,
      });
      if (!last) return 'DOC-0001';
      const n = parseInt((last.number || '').replace(/\D/g, ''), 10) || 0;
      return `DOC-${String(n + 1).padStart(4, '0')}`;
    }

    const DOC_TYPE_CODES = { quotation: 'QT', agreement: 'AGR', proposal: 'PRO' };
    return db.DocumentSequence.next({
      orgId,
      companyCode: company.code,
      docType: DOC_TYPE_CODES[type] || 'DOC',
      transaction,
    });
  }

  async _resolveTemplate(orgId, { templateId, type, serviceTypeKey }) {
    if (templateId) {
      const template = await db.DocumentTemplate.findOne({ where: { id: templateId, orgId } });
      if (!template) {
        const err = new Error('Document template not found.');
        err.status = 404;
        throw err;
      }
      return template;
    }
    // Prefer a template for the exact service; fall back to a 'standard' one
    // (not tied to any service — typically the multi-service wrapper).
    const candidates = await db.DocumentTemplate.findAll({
      where: { orgId, type, serviceTypeKey: [serviceTypeKey, STANDARD_SERVICE_KEY], isActive: true },
      order: [['createdAt', 'DESC']],
    });
    const template = candidates.find((t) => t.serviceTypeKey === serviceTypeKey)
      || candidates.find((t) => t.serviceTypeKey === STANDARD_SERVICE_KEY);
    if (!template) {
      const err = new Error('No active document template for this type and service (and no Standard template). Create one in Admin → Document Templates.');
      err.status = 400;
      throw err;
    }
    return template;
  }

  // Normalizes the `packageOptions` array (of package ids) sent by the create/
  // edit forms — dedupes and drops blanks. Null when absent/empty (equivalent
  // to "just one package, no comparison needed").
  _normalizePackageOptions(packageOptions) {
    if (!Array.isArray(packageOptions)) return null;
    const cleaned = [...new Set(packageOptions.filter(Boolean))];
    return cleaned.length ? cleaned : null;
  }

  // Normalizes the `packageMenu` array sent by the create/edit forms into
  // [{ serviceTypeKey, packageIds: [...], prices: { packageId: n } }, ...] —
  // drops entries with no serviceTypeKey or no packageIds. Null when absent/empty.
  //
  // `prices` are per-DOCUMENT overrides: "this quotation sells the Growth package
  // for 800 instead of its list 1000". The Package row itself is never touched,
  // so the same package keeps its catalogue price everywhere else. Overrides for
  // packages that aren't offered here are dropped, as are non-numeric/negative
  // values (an empty input means "use the list price", not "free").
  _normalizePackageMenu(packageMenu) {
    if (!Array.isArray(packageMenu)) return null;
    const cleaned = packageMenu
      .filter((entry) => entry && entry.serviceTypeKey && Array.isArray(entry.packageIds))
      .map((entry) => {
        const packageIds = [...new Set(entry.packageIds.filter(Boolean))];
        const raw = entry.prices && typeof entry.prices === 'object' ? entry.prices : {};
        const prices = {};
        for (const packageId of packageIds) {
          const value = raw[packageId];
          if (value === undefined || value === null || value === '') continue;
          const n = Number(value);
          if (!Number.isFinite(n) || n < 0) continue;
          prices[packageId] = Math.round(n * 100) / 100;
        }
        return {
          serviceTypeKey: entry.serviceTypeKey,
          packageIds,
          ...(Object.keys(prices).length ? { prices } : {}),
        };
      })
      .filter((entry) => entry.packageIds.length > 0);
    return cleaned.length ? cleaned : null;
  }

  // Hydrates a normalized `packageMenu` ([{serviceTypeKey, packageIds}]) into the
  // full package/service info the client needs to see cards — used by both the
  // admin document detail view and the public review page (PublicDocumentService).
  async _resolvePackageMenuDetails(menu, orgId) {
    const allPackageIds = [...new Set(menu.flatMap((e) => e.packageIds))];
    const serviceTypeKeys = [...new Set(menu.map((e) => e.serviceTypeKey))];
    const [packages, serviceTypes] = await Promise.all([
      db.Package.findAll({
        where: { id: allPackageIds, orgId },
        attributes: ['id', 'name', 'tier', 'price', 'currency', 'features', 'isRecurring', 'billingCycle'],
      }),
      db.ServiceType.findAll({
        where: { key: serviceTypeKeys, orgId },
        attributes: ['key', 'name'],
      }),
    ]);
    const packageById = Object.fromEntries(packages.map((p) => [p.id, p]));
    const nameByKey = Object.fromEntries(serviceTypes.map((s) => [s.key, s.name]));
    return menu.map((entry) => {
      const overrides = entry.prices && typeof entry.prices === 'object' ? entry.prices : {};
      return {
        serviceTypeKey: entry.serviceTypeKey,
        serviceName: nameByKey[entry.serviceTypeKey] || entry.serviceTypeKey,
        // Cheapest first — clients read a service's packages as a ladder (Starter,
        // Growth, Premium), so price order beats the order they were attached in.
        // Sorted here so the review page and the PDF present them identically.
        packages: entry.packageIds
          .map((pid) => packageById[pid])
          .filter(Boolean)
          // Plain objects, not model instances: `price` is resolved here to this
          // document's agreed price so every consumer downstream (review page,
          // PDF, approval math, admin detail) sees one number and can't disagree
          // about it. `listPrice` keeps the catalogue price for "was X" display.
          .map((pkg) => {
            const json = typeof pkg.toJSON === 'function' ? pkg.toJSON() : { ...pkg };
            const override = overrides[json.id];
            const hasOverride = override !== undefined && override !== null && Number.isFinite(Number(override));
            return {
              ...json,
              listPrice: json.price,
              price: hasOverride ? Number(override) : json.price,
              priceOverridden: hasOverride && Number(override) !== Number(json.price),
            };
          })
          .sort((a, b) => (Number(a.price) || 0) - (Number(b.price) || 0)),
      };
    }).filter((entry) => entry.packages.length > 0);
  }

  // Normalizes the `services` array sent by the create/edit forms into
  // [{ serviceTypeKey, packageId, price, scope }] — or null when absent/empty.
  _normalizeServices(services) {
    if (!Array.isArray(services)) return null;
    const cleaned = services
      .filter((s) => s && s.serviceTypeKey)
      .map((s) => ({
        serviceTypeKey: s.serviceTypeKey,
        packageId: s.packageId || null,
        price: s.price != null && s.price !== '' ? (Number(s.price) || 0) : null,
        scope: s.scope || '',
      }));
    return cleaned.length ? cleaned : null;
  }

  // Pre-discount amount only — kept separate from _computeAmount so `update()`
  // can tell "recompute the base from new inputs" apart from "reapply a new
  // discount to the base that's already stored," and never double-discounts an
  // already-discounted `document.amount`.
  _computeBaseAmount(data, pkg) {
    if (Array.isArray(data.lineItems) && data.lineItems.length) {
      return data.lineItems.reduce((sum, l) => sum + (Number(l.qty) || 0) * (Number(l.unitPrice) || 0), 0);
    }
    if (data.amount != null && data.amount !== '') return Number(data.amount) || 0;
    const services = this._normalizeServices(data.services);
    if (services && services.some((s) => s.price != null)) {
      return services.reduce((sum, s) => sum + (s.price || 0), 0);
    }
    if (pkg) return Number(pkg.price) || 0;
    return 0;
  }

  _computeAmount(data, pkg) {
    return this._applyDiscount(this._computeBaseAmount(data, pkg), data.discountType, data.discountValue);
  }

  // Same percent/fixed logic as ClientService._computeSoldPrice — kept as its
  // own method (rather than importing across services) since this only needs
  // the pure math, not the rest of ClientService's package-sale flow.
  _applyDiscount(base, discountType, discountValue) {
    const value = parseFloat(discountValue) || 0;
    if (!['percent', 'fixed'].includes(discountType) || value <= 0) {
      return Math.round(base * 100) / 100;
    }
    const discounted = discountType === 'percent'
      ? base - (base * Math.min(value, 100)) / 100
      : base - value;
    return Math.max(0, Math.round(discounted * 100) / 100);
  }

  // A validUntil in the past is never useful: the expiry scheduler
  // (DocumentExpiryScheduler) would flip a sent/viewed document straight to
  // 'expired' on its next pass, so a document sent with an already-past date
  // could never actually be reviewed. Frontend already blocks this in the UI;
  // this is defense-in-depth for direct API calls.
  _validateValidUntil(validUntil) {
    if (!validUntil) return;
    const today = new Date().toISOString().split('T')[0];
    if (validUntil < today) {
      const err = new Error('Valid Until cannot be in the past.');
      err.status = 422;
      throw err;
    }
  }

  /**
   * The contact whose details prefill a document (and later the review form):
   * the billing contact if one is flagged, else the first active contact.
   */
  async _prefillContactForClient(clientId, orgId) {
    if (!clientId) return null;
    const client = await db.Client.findOne({
      where: { id: clientId, orgId },
      include: [{ model: db.Contact, as: 'contacts', required: false }],
    });
    if (!client) return null;
    const contacts = (client.contacts || []).filter((c) => c.isActive !== false);
    const contact = contacts.find((c) => c.useForInvoice) || contacts[0] || null;
    return { client, contact };
  }

  async create(orgId, userId, data) {
    // Multi-service documents send a `services` array; the first entry doubles
    // as the document's primary serviceTypeKey for filtering/back-compat.
    const services = this._normalizeServices(data.services);
    const serviceTypeKey = data.serviceTypeKey || services?.[0]?.serviceTypeKey;

    // Documents are quoted to a client that already exists. Whatever the admin
    // typed wins over the stored record (they may be correcting it), but any
    // field they left blank falls back to what the client already told us —
    // that's the autofill, and it's why nothing here is re-keyed by hand.
    let client = null;
    if (data.clientId) {
      const prefill = await this._prefillContactForClient(data.clientId, orgId);
      if (!prefill) {
        const err = new Error('Client not found.');
        err.status = 404;
        throw err;
      }
      client = prefill.client;
      const c = prefill.contact;
      data = {
        ...data,
        prospectName: data.prospectName || c?.name || '',
        businessName: data.businessName || c?.businessName || client.name || '',
        email: data.email || c?.email || '',
        phone: data.phone || c?.phone || '',
        currency: data.currency || client.defaultCurrency || 'USD',
      };
    }

    if (!data.prospectName || !data.email || !data.type || !serviceTypeKey) {
      const err = new Error('type, serviceTypeKey (or services), prospectName, and email are required.');
      err.status = 422;
      throw err;
    }
    // Quotations default to today + 7 days when the client omits validUntil.
    let validUntil = data.validUntil || null;
    if (!validUntil && data.type === 'quotation') {
      const d = new Date();
      d.setHours(12, 0, 0, 0);
      d.setDate(d.getDate() + 7);
      const pad = (n) => String(n).padStart(2, '0');
      validUntil = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }
    this._validateValidUntil(validUntil);

    const template = await this._resolveTemplate(orgId, { ...data, serviceTypeKey });
    const packageOptions = this._normalizePackageOptions(data.packageOptions);
    const packageMenu = this._normalizePackageMenu(data.packageMenu);
    const isCompare = Array.isArray(packageOptions) && packageOptions.length > 1;
    const isMenu = Array.isArray(packageMenu) && packageMenu.length > 0;
    // In compare/menu mode packages are the price — clear competing service amounts.
    const normalizedServices = (isCompare || isMenu) && services
      ? services.map((s) => ({ ...s, packageId: null, price: null }))
      : services;
    const packageId = (isCompare || isMenu) ? null : (data.packageId || normalizedServices?.[0]?.packageId);
    const pkg = packageId ? await db.Package.findOne({ where: { id: packageId, orgId } }) : null;
    const number = await this._nextNumber(orgId, data.type, {
      isStripe: client ? client.billingMode === 'stripe' : null,
    });
    const baseAmount = (isCompare || isMenu) ? 0 : this._computeBaseAmount({ ...data, services: normalizedServices }, pkg);
    const discountType = ['percent', 'fixed'].includes(data.discountType) ? data.discountType : null;
    const discountValue = discountType ? (parseFloat(data.discountValue) || 0) : null;
    const discountCycles = discountType ? (parseInt(data.discountCycles, 10) || null) : null;

    const document = await db.CustomerDocument.create({
      id: uuidv4(),
      orgId,
      clientId: client ? client.id : null,
      type: data.type,
      templateId: template.id,
      serviceTypeKey,
      services: normalizedServices,
      packageOptions,
      packageMenu,
      number,
      prospectName: data.prospectName,
      businessName: data.businessName || null,
      email: data.email,
      phone: data.phone || null,
      packageId: pkg ? pkg.id : null,
      currency: data.currency || pkg?.currency || 'USD',
      basePrice: baseAmount,
      discountType,
      discountValue,
      discountCycles,
      amount: this._applyDiscount(baseAmount, discountType, discountValue),
      lineItems: (isCompare || isMenu) ? null : (Array.isArray(data.lineItems) && data.lineItems.length ? data.lineItems : null),
      validUntil,
      scopeTerms: data.scopeTerms ? sanitizeDocumentHtml(data.scopeTerms) : null,
      status: 'draft',
      createdBy: userId,
    });

    await db.DocumentEvent.create({
      documentId: document.id, event: 'created', actor: 'admin', actorUserId: userId,
    });

    return document;
  }

  async update(id, orgId, data) {
    const document = await this.findById(id, orgId);
    if (!EDITABLE_STATUSES.includes(document.status)) {
      const err = new Error(`Cannot edit a document with status "${document.status}".`);
      err.status = 409;
      throw err;
    }
    if (data.validUntil !== undefined) this._validateValidUntil(data.validUntil);

    let services = data.services !== undefined ? this._normalizeServices(data.services) : undefined;
    const packageOptions = data.packageOptions !== undefined
      ? this._normalizePackageOptions(data.packageOptions)
      : document.packageOptions;
    const packageMenu = data.packageMenu !== undefined
      ? this._normalizePackageMenu(data.packageMenu)
      : document.packageMenu;
    const isCompare = Array.isArray(packageOptions) && packageOptions.length > 1;
    const isMenu = Array.isArray(packageMenu) && packageMenu.length > 0;
    if ((isCompare || isMenu) && services) {
      services = services.map((s) => ({ ...s, packageId: null, price: null }));
    }
    const serviceTypeKey = data.serviceTypeKey || (services ? services[0]?.serviceTypeKey : undefined);

    const pkg = (!isCompare && !isMenu && data.packageId)
      ? await db.Package.findOne({ where: { id: data.packageId, orgId } })
      : null;
    const template = (data.templateId || data.type || serviceTypeKey)
      ? await this._resolveTemplate(orgId, {
          templateId: data.templateId,
          type: data.type || document.type,
          serviceTypeKey: serviceTypeKey || document.serviceTypeKey,
        })
      : null;

    // Recompute the base only when its inputs actually changed — otherwise
    // reuse the stored basePrice. Documents saved before this field existed
    // fall back to their current `amount` (correct: no discount could have
    // been applied to them yet, so amount *is* their base).
    const amountInputsChanged = data.amount !== undefined || data.lineItems !== undefined
      || data.packageId !== undefined || data.services !== undefined || data.packageOptions !== undefined
      || data.packageMenu !== undefined;
    let baseAmount;
    if (isCompare || isMenu) {
      baseAmount = 0;
    } else if (amountInputsChanged) {
      baseAmount = this._computeBaseAmount({ ...data, services: services ?? document.services }, pkg);
    } else {
      baseAmount = document.basePrice != null ? Number(document.basePrice) : Number(document.amount) || 0;
    }
    const discountType = data.discountType !== undefined
      ? (['percent', 'fixed'].includes(data.discountType) ? data.discountType : null)
      : document.discountType;
    const discountValue = data.discountType !== undefined
      ? (data.discountType ? (parseFloat(data.discountValue) || 0) : null)
      : (data.discountValue !== undefined ? (parseFloat(data.discountValue) || 0) : document.discountValue);
    const discountCycles = data.discountType !== undefined
      ? (data.discountType ? (parseInt(data.discountCycles, 10) || null) : null)
      : (data.discountCycles !== undefined ? (parseInt(data.discountCycles, 10) || null) : document.discountCycles);

    await document.update({
      type: data.type ?? document.type,
      clientId: data.clientId !== undefined ? (data.clientId || null) : document.clientId,
      templateId: template ? template.id : document.templateId,
      serviceTypeKey: serviceTypeKey ?? document.serviceTypeKey,
      services: data.services !== undefined ? services : ((isCompare || isMenu) && Array.isArray(document.services)
        ? document.services.map((s) => ({ ...s, packageId: null, price: null }))
        : document.services),
      packageOptions: data.packageOptions !== undefined ? packageOptions : document.packageOptions,
      packageMenu: data.packageMenu !== undefined ? packageMenu : document.packageMenu,
      prospectName: data.prospectName ?? document.prospectName,
      businessName: data.businessName ?? document.businessName,
      email: data.email ?? document.email,
      phone: data.phone ?? document.phone,
      packageId: (isCompare || isMenu) ? null : (data.packageId !== undefined ? (pkg ? pkg.id : null) : document.packageId),
      currency: data.currency ?? document.currency,
      basePrice: baseAmount,
      discountType,
      discountValue,
      discountCycles,
      amount: this._applyDiscount(baseAmount, discountType, discountValue),
      lineItems: (isCompare || isMenu)
        ? null
        : (data.lineItems !== undefined ? (data.lineItems.length ? data.lineItems : null) : document.lineItems),
      validUntil: data.validUntil !== undefined ? data.validUntil : document.validUntil,
      scopeTerms: data.scopeTerms !== undefined
        ? (data.scopeTerms ? sanitizeDocumentHtml(data.scopeTerms) : null)
        : document.scopeTerms,
    });

    return document;
  }

  // Deactivates rather than destroys — see services/SoftDeleteService.js. Sent /
  // approved documents stay untouchable, as before: a live quotation the prospect
  // can still open must not vanish from the pipeline.
  // document_events is append-only (see spec Addendum 4 §9) and is unaffected either way.
  async remove(id, orgId, active = false) {
    const document = await this.findById(id, orgId);
    if (!active && document.status !== 'draft') {
      const err = new Error('Only draft documents can be set to Inactive.');
      err.status = 409;
      throw err;
    }
    await document.update({ isActive: active });
    return document;
  }

  /**
   * Which of our legal entities is quoting this client.
   *
   * Same hard rule the invoice uses, driven by the client's "Pay via CRM" flag:
   * Stripe clients are quoted (and later billed) by the LLC, everyone else by
   * the LLP. Keeping the quotation and its invoice on one entity matters — a
   * client should not receive a quote from one company and an invoice from
   * another for the same work.
   *
   * A document with no linked client (legacy, or a cold prospect) falls back to
   * the org's configured billing letterhead as before.
   */
  async _letterheadForDocument(orgId, document) {
    const clientId = document?.clientId;
    if (!clientId) return letterheadForOrg(orgId, 'billing');
    const client = await db.Client.findOne({
      where: { id: clientId, orgId },
      attributes: ['id', 'billingMode'],
    }).catch(() => null);
    if (!client) return letterheadForOrg(orgId, 'billing');
    return letterheadForClient(orgId, client.billingMode === 'stripe');
  }

  async _renderBody(orgId, document, template) {
    const [brand, letterhead] = await Promise.all([
      db.WhiteLabelConfig.findOne({ where: { orgId } }),
      this._letterheadForDocument(orgId, document),
    ]);
    const agencyEmail = letterhead?.contactEmail
      || letterhead?.entities?.find((e) => e.email)?.email
      || brand?.contactEmail
      || brand?.emailFrom
      || 'info@mohsindesigns.com';
    const agencyPhone = letterhead?.businessPhone
      || letterhead?.entities?.find((e) => e.phone)?.phone
      || brand?.businessPhone
      || '';

    // Every document renders through the same multi-service path — a legacy
    // single-service document just becomes a one-entry services list.
    const rawServices = (Array.isArray(document.services) && document.services.length)
      ? document.services
      : [{
          serviceTypeKey: document.serviceTypeKey,
          packageId: document.packageId || null,
          price: document.basePrice != null ? Number(document.basePrice) : (document.amount != null ? Number(document.amount) : null),
          scope: document.scopeTerms || '',
        }];

    const packageOptionIds = Array.isArray(document.packageOptions) ? document.packageOptions : [];
    const menu = Array.isArray(document.packageMenu) ? document.packageMenu : [];
    // Compare/menu docs park each service with packageId=null until the client
    // actually picks — while pending, printing those as bare "Service Name" rows
    // with no price right above the alternatives list below just duplicates the
    // same information twice. Skip the bare rows and let the appended
    // alternatives/menu text (further down) be the only listing until resolved.
    const hasAnyResolvedPackage = rawServices.some((s) => s.packageId);
    const isComparePending = packageOptionIds.length > 1 && !hasAnyResolvedPackage;
    const isMenuPending = menu.length > 0 && !hasAnyResolvedPackage;
    const isPricingPending = isComparePending || isMenuPending;

    const serviceKeys = isMenuPending
      ? [...new Set(menu.map((e) => e.serviceTypeKey).filter(Boolean))]
      : [...new Set(rawServices.map((s) => s.serviceTypeKey).filter(Boolean))];
    const services = isPricingPending ? [] : rawServices;
    const packageIds = [...new Set([...rawServices.map((s) => s.packageId).filter(Boolean), ...packageOptionIds])];

    const [serviceTypes, packages, fragments] = await Promise.all([
      db.ServiceType.findAll({ where: { orgId, key: serviceKeys }, attributes: ['key', 'name'] }),
      packageIds.length ? db.Package.findAll({ where: { id: packageIds, orgId }, attributes: ['id', 'name', 'tier', 'price', 'currency', 'features'] }) : [],
      db.DocumentTemplate.findAll({
        where: { orgId, type: 'service_fragment', isActive: true },
        order: [['createdAt', 'DESC']],
      }),
    ]);
    const serviceNameByKey = Object.fromEntries(serviceTypes.map((s) => [s.key, s.name]));
    const packageById = Object.fromEntries(packages.map((p) => [p.id, p]));

    const subtotal = services.reduce((sum, s) => sum + (Number(s.price) || 0), 0);
    const firstPkg = packageById[services[0]?.packageId];

    const tokens = buildMergeTokens(document, {
      agencyName: brand?.brandName || letterhead?.legalName || 'Mohsin Designs Project Management',
      agencyEmail,
      agencyPhone,
      serviceName: serviceKeys.map((k) => serviceNameByKey[k] || k).join(', '),
      packageName: firstPkg ? (firstPkg.tier || firstPkg.name) : null,
      packageFeatures: firstPkg?.features,
      subtotal,
    });
    if (!document.scopeTerms && template.defaultTerms) tokens.terms = ensureHtml(template.defaultTerms);

    // Whatever represents "the services" goes into {{services_block}} itself —
    // never appended after the whole rendered body — so it lands exactly where
    // the template places that token, not tacked on past the signature.
    if (isComparePending) {
      // Compare mode: services no longer carry a packageId (client picks later),
      // so list each offered package as the alternatives to choose from.
      const packageOptions = packageOptionIds.map((pid) => packageById[pid]).filter(Boolean);
      const currency = document.currency || packageOptions[0]?.currency || 'USD';
      const optionBlocks = packageOptions.map((pkg) => {
        const feats = formatFeatures(pkg.features);
        const lines = [
          `▸ ${pkg.tier || pkg.name}`,
          `  Investment: ${currency} ${Number(pkg.price || 0).toLocaleString()}`,
        ];
        if (feats) lines.push('', "  What's included:", feats);
        else lines.push('', "  What's included: (no features listed on this package yet)");
        return lines.join('\n');
      });
      tokens.services_block = `Choose one package:\n\n${optionBlocks.join('\n\n')}\n\nPick a package and approve on the quotation link you're sent — the total is set once you approve.`;
    } else if (isMenuPending) {
      const menuDetails = await this._resolvePackageMenuDetails(menu, orgId);
      const menuBlocks = menuDetails.map((entry) => {
        const currency = document.currency || entry.packages[0]?.currency || 'USD';
        const pkgLines = entry.packages.map((pkg) => {
          const feats = formatFeatures(pkg.features);
          const lines = [`  ▸ ${pkg.tier || pkg.name} — ${currency} ${Number(pkg.price || 0).toLocaleString()}`];
          if (feats) lines.push(`    ${feats.split('\n').join('\n    ')}`);
          return lines.join('\n');
        });
        return `${entry.serviceName}:\n${pkgLines.join('\n')}`;
      });
      tokens.services_block = `Pick any package for any service below — or none at all:\n\n${menuBlocks.join('\n\n')}\n\nApprove on the quotation link you're sent once you've chosen — the total is set then.`;
    } else {
      // Render one fragment per service: an exact service_fragment template wins,
      // then a 'standard' fragment, then the built-in default block.
      tokens.services_block = services.map((svc) => {
        const pkg = packageById[svc.packageId];
        const svcTokens = {
          ...tokens,
          service: serviceNameByKey[svc.serviceTypeKey] || svc.serviceTypeKey || '',
          package: pkg ? (pkg.tier || pkg.name) : '',
          price: svc.price != null ? Number(svc.price).toFixed(2) : '',
          scope: svc.scope || '',
          package_features: formatFeatures(pkg?.features),
        };
        const fragment = fragments.find((f) => f.serviceTypeKey === svc.serviceTypeKey)
          || fragments.find((f) => f.serviceTypeKey === STANDARD_SERVICE_KEY);
        return fragment ? renderTemplate(fragment.body, svcTokens) : defaultServiceFragment(svcTokens);
      }).join('\n\n');
    }

    // template.body is authored HTML (the rich-text editor) — `terms`/`scope`
    // are inserted raw since they're sanitized HTML in their own right (see
    // htmlSanitizer.js); every other token is plain text/auto-generated, so it
    // gets HTML-escaped + newline-to-<br> by renderHtmlTemplate. ensureHtml()
    // upgrades a template body saved before the rich-text editor existed
    // (plain text, no tags) the same way, so old templates keep their line
    // breaks instead of collapsing into one paragraph.
    const rendered = renderHtmlTemplate(ensureHtml(template.body), tokens, ['terms', 'scope']);
    return { rendered, brand };
  }

  // Renders the current (unsaved) draft state for the live preview panel — takes
  // the same shape of fields the create/edit form sends, without persisting anything.
  async preview(orgId, data) {
    const services = this._normalizeServices(data.services);
    const serviceTypeKey = data.serviceTypeKey || services?.[0]?.serviceTypeKey;
    const template = await this._resolveTemplate(orgId, { ...data, serviceTypeKey });
    const fakeDocument = {
      // Carried through so the live preview shows the same legal entity the
      // saved document will — the client's rail decides LLC vs LLP.
      clientId: data.clientId || null,
      prospectName: data.prospectName || '',
      businessName: data.businessName || '',
      email: data.email || '',
      phone: data.phone || '',
      serviceTypeKey,
      services,
      packageOptions: this._normalizePackageOptions(data.packageOptions),
      packageMenu: this._normalizePackageMenu(data.packageMenu),
      packageId: data.packageId || services?.[0]?.packageId || null,
      currency: data.currency || 'USD',
      basePrice: this._computeBaseAmount(data, null),
      amount: this._computeAmount(data, null),
      discountType: data.discountType || null,
      discountValue: data.discountValue || null,
      discountCycles: data.discountCycles || null,
      scopeTerms: data.scopeTerms ? sanitizeDocumentHtml(data.scopeTerms) : '',
      validUntil: data.validUntil || '',
    };
    const { rendered } = await this._renderBody(orgId, fakeDocument, template);
    return { rendered };
  }

  async send(id, orgId, userId) {
    const document = await this.findById(id, orgId);
    if (!EDITABLE_STATUSES.includes(document.status)) {
      const err = new Error(`Cannot send a document with status "${document.status}".`);
      err.status = 409;
      throw err;
    }

    const { rendered, brand } = await this._renderBody(orgId, document, document.template);
    const publicToken = crypto.randomBytes(32).toString('hex');

    await document.update({
      bodySnapshot: rendered,
      publicToken,
      status: 'sent',
      sentAt: new Date(),
      responseNote: null,
      respondedAt: null,
      viewedAt: null,
    });

    await db.DocumentEvent.create({ documentId: document.id, event: 'sent', actor: 'admin', actorUserId: userId });

    const reviewUrl = `${(process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '')}/review/${publicToken}`;
    EmailService.sendDocumentReviewLink(
      document.email, document.prospectName, brand?.brandName || 'Mohsin Designs Project Management',
      document.type, document.number, reviewUrl
    ).catch(() => {});

    return document;
  }

  async remind(id, orgId, userId) {
    const document = await this.findById(id, orgId);
    if (!['sent', 'viewed'].includes(document.status)) {
      const err = new Error(`Cannot send a reminder for a document with status "${document.status}".`);
      err.status = 409;
      throw err;
    }
    const brand = await db.WhiteLabelConfig.findOne({ where: { orgId } });
    await db.DocumentEvent.create({ documentId: document.id, event: 'reminder', actor: 'admin', actorUserId: userId });

    const reviewUrl = `${(process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '')}/review/${document.publicToken}`;
    EmailService.sendDocumentRemind(
      document.email, document.prospectName, brand?.brandName || 'Mohsin Designs Project Management',
      document.type, document.number, reviewUrl
    ).catch(() => {});

    return document;
  }

  async convert(id, orgId, userId, data = {}) {
    const document = await this.findById(id, orgId);
    if (document.status !== 'approved') {
      const err = new Error('Only approved documents can be converted.');
      err.status = 409;
      throw err;
    }
    if (document.convertedProjectId) {
      const err = new Error('This document has already been converted.');
      err.status = 409;
      throw err;
    }
    if (Array.isArray(document.packageMenu) && document.packageMenu.length && !(document.services || []).length) {
      const err = new Error('The client approved this without selecting any service — nothing to convert.');
      err.status = 409;
      throw err;
    }

    let client;
    // The document was raised against a real client, so that's who it converts
    // for — no guessing, and no duplicate client created from the prospect
    // fields. An explicit clientId in the request still wins (admin override).
    const linkedClientId = data.clientId || document.clientId;
    if (linkedClientId) {
      client = await ClientService.findById(linkedClientId, orgId);
    } else {
      client = await ClientService.create(orgId, {
        name: document.businessName || document.prospectName,
        defaultCurrency: document.currency,
      });
      await db.Contact.create({
        id: uuidv4(),
        clientId: client.id,
        name: document.prospectName,
        email: document.email,
        phone: document.phone,
        role: 'Primary',
      });
    }

    // One project per service on the document. A legacy single-service document
    // converts exactly as before (its one serviceTypeKey → one project).
    const chosenPackageId = document.selectedPackageId || document.packageId;
    const serviceEntries = (Array.isArray(document.services) && document.services.length)
      ? document.services
      : [{ serviceTypeKey: document.serviceTypeKey, packageId: chosenPackageId }];
    const serviceKeys = [...new Set(serviceEntries.map((s) => s.serviceTypeKey).filter(Boolean))];

    // Everything needed to spawn one project for a single service. Shared by the
    // document's own service rows and by any extra services a package bundles in.
    const resolveWorkflow = async (serviceTypeKey, pinnedTemplateId) => {
      const wfTemplate = pinnedTemplateId
        ? await db.WorkflowTemplate.findOne({ where: { id: pinnedTemplateId, orgId } })
        : await db.WorkflowTemplate.findOne({
          where: { orgId, serviceTypeKey, isActive: true },
          order: [['version', 'DESC']],
        });
      if (!wfTemplate) {
        const err = new Error(`No published workflow template for service "${serviceTypeKey}". Configure one in Admin → Workflows.`);
        err.status = 400;
        throw err;
      }
      const firstStage = await db.Stage.findOne({ where: { templateId: wfTemplate.id }, order: [['orderIndex', 'ASC']] });
      if (!firstStage) {
        const err = new Error(`The workflow template for service "${serviceTypeKey}" has no stages configured.`);
        err.status = 400;
        throw err;
      }
      const serviceType = await db.ServiceType.findOne({ where: { orgId, key: serviceTypeKey }, attributes: ['name'] });
      return { key: serviceTypeKey, wfTemplate, firstStage, serviceName: serviceType?.name || serviceTypeKey };
    };

    // Resolve everything (workflow templates, first stages, names, packages)
    // before the transaction, so a missing workflow for *any* service aborts
    // cleanly rather than half-creating.
    const resolved = [];
    // One project per service, even if two document rows lead to the same one.
    const claimedServiceKeys = new Set();
    for (const key of serviceKeys) {
      const entry = serviceEntries.find((s) => s.serviceTypeKey === key);
      const pkgId = entry?.packageId || chosenPackageId;
      // Full row, not just id/name/tier: the billing pass below needs
      // isRecurring / billingCycle / price, and the bundle needs `services`.
      const pkg = pkgId
        ? await db.Package.findOne({ where: { id: pkgId, orgId } })
        : (key === document.serviceTypeKey ? document.package : null);

      // A package can bundle several services (Package.services), and selling one
      // is defined as spawning a project per bundled service — that's what
      // ClientService.sellPackage does. Converting a quotation only ever looked at
      // the document's own service row, so a package covering SEO + Web created a
      // single project and the second service silently never got a workflow.
      const bundle = (Array.isArray(pkg?.services) && pkg.services.length)
        ? pkg.services
        : [{ serviceTypeKey: key, workflowTemplateId: null }];
      const bundleKeys = [...new Set(bundle.map((s) => s.serviceTypeKey).filter(Boolean))];

      // Retainer-only packages (hosting) bill normally but spawn no workflow —
      // same carve-out sellPackage honours.
      const projectServices = [];
      if (!pkg?.skipProjectCreation) {
        for (const svc of bundle) {
          if (!svc.serviceTypeKey || claimedServiceKeys.has(svc.serviceTypeKey)) continue;
          claimedServiceKeys.add(svc.serviceTypeKey);
          projectServices.push(await resolveWorkflow(svc.serviceTypeKey, svc.workflowTemplateId));
        }
      }

      const serviceType = await db.ServiceType.findOne({ where: { orgId, key }, attributes: ['name'] });
      resolved.push({
        key,
        serviceName: serviceType?.name || key,
        pkg,
        // What the client actually agreed to pay for this service, pre-discount.
        price: entry?.price != null ? Number(entry.price) || 0 : null,
        // The projects this one line item spawns — 2 for a 2-service package.
        projectServices,
        // Every service this item covers, so its ClientPackage links to them all.
        serviceKeys: bundleKeys.length ? bundleKeys : [key],
        // Named on the invoice line: "SEO + Web Development — Growth".
        coveredNames: projectServices.length
          ? projectServices.map((ps) => ps.serviceName)
          : [serviceType?.name || key],
      });
    }

    const items = this._buildBillingItems(document, resolved);
    const today = new Date().toISOString().split('T')[0];

    const { projects, clientPackages } = await db.sequelize.transaction(async (t) => {
      // A sold package on the document has to become a real ClientPackage row —
      // that's what the client's Packages tab lists, what retainers/invoices hang
      // off, and what "which packages does this client have?" is answered from.
      // Skipping it (as convert used to) left the package visible only indirectly,
      // via the project it spawned.
      const soldPackages = [];
      for (const item of items) {
        if (!item.pkg) { soldPackages.push(null); continue; }
        const billingCycle = ['monthly', 'quarterly', 'annual'].includes(item.pkg.billingCycle)
          ? item.pkg.billingCycle
          : 'monthly';
        // The discount timeline promised on the proposal still carries through
        // even though the discount markdown itself is already folded into
        // chargedPrice below — only meaningful for a service that actually
        // recurs, same as ClientService.sellPackage.
        const discountEndsAt = item.isRecurring
          ? ClientService._computeDiscountEndsAt(today, billingCycle, document.discountCycles)
          : null;
        const clientPackage = await db.ClientPackage.create({
          orgId,
          clientId: client.id,
          packageId: item.pkg.id,
          basePrice: item.pkg.price != null ? Number(item.pkg.price) : item.price,
          // The document's discount is already folded into `chargedPrice`, so the
          // sale is recorded as a straight agreed price rather than re-deriving a
          // markdown that may not even map to this one package.
          discountType: null,
          discountValue: null,
          discountCycles: discountEndsAt ? document.discountCycles : null,
          discountEndsAt,
          soldPrice: item.chargedPrice,
          currency: document.currency || 'USD',
          billingCycle,
          status: 'active',
          startDate: today,
          createdBy: userId,
        }, { transaction: t });
        soldPackages.push(clientPackage);
      }
      // Which sold package each service belongs to, so its project links back.
      const packageByServiceKey = {};
      items.forEach((item, i) => {
        for (const key of item.serviceKeys) packageByServiceKey[key] = soldPackages[i];
      });

      // One project per service the item covers — a package bundling SEO + Web
      // produces two, each on its own workflow.
      const created = [];
      for (const r of resolved) {
        for (const ps of r.projectServices) {
          const clientPackage = packageByServiceKey[ps.key] || null;
          const project = await db.Project.create({
            id: uuidv4(),
            orgId,
            clientId: client.id,
            name: buildProjectName(client.name, ps.serviceName, r.pkg?.tier || r.pkg?.name),
            serviceTypeKey: ps.key,
            workflowTemplateId: ps.wfTemplate.id,
            packageId: r.pkg?.id || null,
            clientPackageId: clientPackage?.id || null,
            currentStageKey: ps.firstStage.key,
            status: 'active',
            startDate: today,
            isRecurring: !!ps.wfTemplate.isRecurring,
            createdBy: userId,
          }, { transaction: t });

          await db.ProjectEvent.create({
            projectId: project.id, fromStageKey: null, toStageKey: ps.firstStage.key,
            action: 'created', actorUserId: userId, note: `Created from converted document: ${document.number}`,
          }, { transaction: t });

          created.push(project);
        }
      }

      await document.update({
        convertedClientId: client.id,
        // Null when every package was retainer-only (skipProjectCreation) — the
        // document still converted, it just has no workflow to point at.
        convertedProjectId: created[0]?.id || null,
      }, { transaction: t });

      await db.DocumentEvent.create({
        // No userId means this ran off the client submitting their details, not
        // an admin pressing Convert.
        documentId: document.id, event: 'converted', actor: userId ? 'admin' : 'system', actorUserId: userId || null,
      }, { transaction: t });

      return { projects: created, clientPackages: soldPackages };
    });

    const project = projects[0];
    const projectsByServiceKey = Object.fromEntries(projects.map((p) => [p.serviceTypeKey, p]));

    // Billing runs after the transaction commits — InvoiceService/RetainerService
    // manage their own transactions and must not be nested inside the one above
    // (same rule as ClientService.sellPackage).
    //
    // Every item is billed on its own line, and `mergeWithOpenInvoice` folds them
    // all onto ONE invoice (same client / currency / due date). Recurring items
    // additionally get their own retainer, so a quotation mixing a one-off build
    // with a monthly retainer produces exactly that — not a single opaque line.
    //
    // Whether the invoice goes out on its own is the client's payment rail:
    //
    //   Pay via CRM  → Stripe can collect unattended, so it is issued straight
    //                  away with a live payment link.
    //   Manual       → someone has to chase a bank transfer, so it waits as a
    //                  draft until an admin sends it.
    //
    // Either way every line is billed as a DRAFT first and the invoice is issued
    // once, after the loop. Billing them as 'sent' meant each of the three
    // services merging onto the one invoice re-triggered the send — the client
    // got three emails quoting the running subtotal (1200, then 2150, then
    // 3350) instead of one email for the real total.
    const payViaCrm = client.billingMode === 'stripe';

    const billingErrors = [];
    let retainersCreated = 0;
    let firstBillingLine = true;
    const invoiceNote = `Converted from ${document.type} ${document.number}`;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const clientPackage = clientPackages[i];
      if (!(item.chargedPrice > 0)) continue;
      try {
        if (item.isRecurring) {
          await RetainerService.autoCreate({
            orgId,
            clientId: client.id,
            // Retainer-only packages spawn no project at all, so this can be null.
            projectId: item.serviceKeys.map((k) => projectsByServiceKey[k]?.id).find(Boolean) || project?.id || null,
            clientPackageId: clientPackage?.id || null,
            packageId: item.pkg?.id || null,
            amount: item.chargedPrice,
            currency: document.currency || 'USD',
            cycle: item.billingCycle,
            startDate: today,
            lineDescription: item.lineDescription,
            invoiceNotes: firstBillingLine ? invoiceNote : null,
            invoiceStatus: 'draft',
            mergeWithOpenInvoice: true,
          });
          retainersCreated += 1;
        } else {
          await InvoiceService.create(orgId, {
            clientId: client.id,
            clientPackageId: clientPackage?.id || null,
            currency: document.currency || 'USD',
            status: 'draft',
            issuedAt: today,
            dueAt: today,
            notes: firstBillingLine ? invoiceNote : null,
            lines: [{ description: item.lineDescription, qty: 1, unitPrice: item.chargedPrice }],
            skipIfZero: true,
            mergeWithOpenInvoice: true,
          });
        }
        firstBillingLine = false;
      } catch (err) {
        console.error(`[CustomerDocumentService] Failed to bill "${item.label}" for converted document:`, err.stack || err.message);
        billingErrors.push(`${item.label}: ${err.message}`);
      }
    }

    // Every line merged onto one invoice, so this is normally a single row.
    // Looked up rather than returned from the billing calls because
    // RetainerService.autoCreate's return value is the retainer, and callers
    // elsewhere rely on that.
    const raisedInvoices = firstBillingLine
      ? []
      : await db.Invoice.findAll({
          where: { orgId, clientId: client.id, status: 'draft', issuedAt: today },
          attributes: ['id', 'number', 'total', 'currency'],
          order: [['createdAt', 'DESC']],
        }).catch(() => []);

    // Now — and only now, with every line on it and the total final — issue the
    // invoice for a Pay via CRM client. One transition, so exactly one email.
    if (payViaCrm) {
      for (const inv of raisedInvoices) {
        try {
          await InvoiceService.updateStatus(inv.id, orgId, 'sent');
        } catch (err) {
          console.error(`[CustomerDocumentService] Could not issue invoice ${inv.number}:`, err.message);
          billingErrors.push(`invoice ${inv.number} could not be sent: ${err.message}`);
        }
      }
    }

    return {
      document,
      client,
      project,
      projects,
      clientPackages: clientPackages.filter(Boolean),
      retainerCreated: retainersCreated > 0,
      retainersCreated,
      invoices: raisedInvoices,
      invoiceStatus: payViaCrm ? 'sent' : 'draft',
      payViaCrm,
      billingError: billingErrors.length
        ? `The document was converted, but some billing could not be created — ${billingErrors.join(' · ')}. Add it manually from Invoices/Retainers.`
        : null,
    };
  }

  /**
   * Turns the resolved services of an approved document into the list of things
   * to actually sell and bill — one entry per package the client agreed to, each
   * with its own charged price, recurring flag and invoice line label.
   *
   * The one non-obvious case is "pick one package for the whole deal" (compare)
   * mode: there, every service on the document points at the SAME package and
   * carries the SAME full price, so they collapse into a single item. Billing
   * them per service would charge that one package once per service.
   */
  _buildBillingItems(document, resolved) {
    const packageOptions = Array.isArray(document.packageOptions) ? document.packageOptions : [];
    const chosenPackageId = document.selectedPackageId || document.packageId;
    const isCompare = packageOptions.length > 1 && !!chosenPackageId;
    const baseTotal = document.basePrice != null ? Number(document.basePrice) : Number(document.amount) || 0;

    const describe = (pkg, serviceNames) => {
      const services = serviceNames.join(' + ');
      const tier = pkg ? (pkg.tier || pkg.name) : null;
      return tier ? `${services} — ${tier}` : services;
    };

    // A bundled package is still ONE billing line at ONE price, however many
    // projects it spawns — `serviceKeys` and the label widen to cover them all,
    // but the price does not get charged per service.
    const recurs = (r) => !!r.pkg?.isRecurring || r.projectServices.some((ps) => ps.wfTemplate.isRecurring);

    let items;
    if (isCompare) {
      const pkg = resolved.find((r) => r.pkg?.id === chosenPackageId)?.pkg || document.package || null;
      items = [{
        pkg,
        serviceKeys: [...new Set(resolved.flatMap((r) => r.serviceKeys))],
        label: describe(pkg, [...new Set(resolved.flatMap((r) => r.coveredNames))]),
        price: baseTotal,
        isRecurring: !!pkg?.isRecurring || resolved.some(recurs),
        billingCycle: pkg?.billingCycle,
      }];
    } else {
      items = resolved.map((r) => ({
        pkg: r.pkg,
        serviceKeys: r.serviceKeys,
        label: describe(r.pkg, r.coveredNames),
        price: r.price != null ? r.price : (r.pkg?.price != null ? Number(r.pkg.price) : 0),
        isRecurring: recurs(r),
        billingCycle: r.pkg?.billingCycle,
      }));
    }

    // Documents priced as a lump sum (manual amount / line items, no per-service
    // prices) leave every item at zero — put the whole base on the first one so
    // the client is still billed rather than silently getting a free project.
    const itemised = items.reduce((sum, i) => sum + (Number(i.price) || 0), 0);
    if (!(itemised > 0) && baseTotal > 0 && items.length) items[0].price = baseTotal;

    const charged = this._distributeDiscount(
      items.map((i) => Number(i.price) || 0),
      document.discountType,
      document.discountValue,
    );

    return items.map((item, i) => {
      const cycle = ['monthly', 'quarterly', 'annual'].includes(item.billingCycle) ? item.billingCycle : 'monthly';
      return {
        ...item,
        billingCycle: cycle,
        chargedPrice: charged[i],
        // Spelled out on the invoice line itself — an invoice that lists three
        // packages has to say which of them renews and which was a one-off, or
        // the client can't tell what next month's bill looks like.
        lineDescription: `${item.label} (${item.isRecurring ? `Recurring · ${cycle}` : 'One-time'})`,
      };
    });
  }

  /**
   * Spreads a document-level discount across its individual charged amounts, so
   * the per-package prices still add up to exactly `document.amount`. The last
   * entry absorbs the rounding remainder — otherwise three 33.33% shares of a
   * discounted total would quietly lose a cent off the invoice.
   */
  _distributeDiscount(prices, discountType, discountValue) {
    const base = prices.reduce((sum, p) => sum + (Number(p) || 0), 0);
    const round = (n) => Math.round(n * 100) / 100;
    const value = parseFloat(discountValue) || 0;
    if (!['percent', 'fixed'].includes(discountType) || value <= 0 || base <= 0) {
      return prices.map((p) => round(Number(p) || 0));
    }
    const target = this._applyDiscount(base, discountType, discountValue);
    const factor = target / base;
    const out = prices.map((p) => round((Number(p) || 0) * factor));
    const drift = round(target - out.reduce((sum, n) => sum + n, 0));
    if (drift !== 0 && out.length) {
      out[out.length - 1] = Math.max(0, round(out[out.length - 1] + drift));
    }
    return out;
  }

  async generatePdfBuffer(id, orgId) {
    const document = await this.findById(id, orgId);

    // Pre-approval, compare/menu docs park each selected service with
    // packageId=null (the client hasn't picked yet) — those entries exist, just
    // with nothing resolved, so checking services.length alone isn't enough to
    // tell "pending" apart from "resolved"; check for an actual packageId instead.
    const rawServicesForMenuCheck = Array.isArray(document.services) ? document.services : [];
    const hasAnyResolvedPackage = rawServicesForMenuCheck.some((s) => s.packageId);
    const isMenuPending = Array.isArray(document.packageMenu) && document.packageMenu.length > 0 && !hasAnyResolvedPackage;

    const servicesRaw = isMenuPending
      ? []
      : (Array.isArray(document.services) && document.services.length)
        ? document.services
        : [{
            serviceTypeKey: document.serviceTypeKey,
            packageId: document.packageId || null,
            price: document.basePrice != null ? Number(document.basePrice) : (document.amount != null ? Number(document.amount) : null),
            scope: '',
          }];

    const serviceKeys = [...new Set(servicesRaw.map((s) => s.serviceTypeKey).filter(Boolean))];
    const packageOptionIds = Array.isArray(document.packageOptions) ? document.packageOptions : [];
    const packageIds = [...new Set([
      ...servicesRaw.map((s) => s.packageId).filter(Boolean),
      ...packageOptionIds,
      document.packageId,
      document.selectedPackageId,
    ].filter(Boolean))];

    const [serviceTypes, packages, branding] = await Promise.all([
      serviceKeys.length
        ? db.ServiceType.findAll({ where: { orgId, key: serviceKeys }, attributes: ['key', 'name'] })
        : [],
      packageIds.length
        ? db.Package.findAll({ where: { id: packageIds, orgId }, attributes: ['id', 'name', 'tier', 'price', 'currency', 'features'] })
        : [],
      db.WhiteLabelConfig.findOne({ where: { orgId } }),
    ]);
    const serviceNameByKey = Object.fromEntries(serviceTypes.map((s) => [s.key, s.name]));
    const packageById = Object.fromEntries(packages.map((p) => [p.id, p]));

    const isCompare = packageOptionIds.length > 1;
    const selectedPackageId = document.selectedPackageId || null;
    const selectedPkg = selectedPackageId ? packageById[selectedPackageId] : null;
    const docPkg = document.packageId ? packageById[document.packageId] : null;

    const services = servicesRaw.map((s) => {
      // Prefer the service's linked package; fall back to chosen compare package
      // or the document-level package so "What's included" still appears on PDFs.
      const pkg = packageById[s.packageId] || selectedPkg || docPkg || null;
      return {
        serviceTypeKey: s.serviceTypeKey,
        name: serviceNameByKey[s.serviceTypeKey] || s.serviceTypeKey,
        packageLabel: pkg ? (pkg.tier || pkg.name) : '',
        // In compare mode before selection, services are inclusions — not priced rows.
        price: (isCompare && !selectedPkg) ? null : (s.price != null ? Number(s.price) : null),
        scope: s.scope || '',
        featuresText: formatFeatures(pkg?.features) || '',
      };
    });

    const servicesTotal = services.reduce((sum, s) => sum + (Number(s.price) || 0), 0);
    const lineItems = (!isCompare || selectedPkg) && Array.isArray(document.lineItems) ? document.lineItems : [];
    const lineTotal = lineItems.reduce((sum, l) => sum + (Number(l.qty) || 0) * (Number(l.unitPrice) || 0), 0);

    const packageOptions = packageOptionIds.map((pid) => {
      const pkg = packageById[pid];
      if (!pkg) return null;
      return {
        id: pkg.id,
        name: pkg.name,
        tier: pkg.tier,
        price: pkg.price,
        currency: pkg.currency,
        featuresText: formatFeatures(pkg.features) || '',
      };
    }).filter(Boolean);

    const optionPrices = packageOptions.map((p) => Number(p.price) || 0);
    const optionMin = optionPrices.length ? Math.min(...optionPrices) : null;
    const optionMax = optionPrices.length ? Math.max(...optionPrices) : null;

    let discountLabel = null;
    if (document.discountType && Number(document.discountValue) > 0) {
      discountLabel = document.discountType === 'percent'
        ? `${Number(document.discountValue)}%`
        : `${document.currency || 'USD'} ${Number(document.discountValue).toFixed(2)}`;
      // A discount on a recurring package only lasts so many billing cycles —
      // say so on the document itself, not just internally, so the client isn't
      // surprised when the price goes back up.
      const cycles = parseInt(document.discountCycles, 10);
      if (cycles > 0) {
        discountLabel += ` (first ${cycles} billing cycle${cycles === 1 ? '' : 's'} only)`;
      }
    }

    const packageMenuForPdf = isMenuPending
      ? (await this._resolvePackageMenuDetails(document.packageMenu, orgId)).map((entry) => ({
          serviceName: entry.serviceName,
          packages: entry.packages.map((pkg) => ({
            name: pkg.name,
            tier: pkg.tier,
            price: pkg.price,
            currency: pkg.currency,
            featuresText: formatFeatures(pkg.features) || '',
          })),
        }))
      : [];

    const applyDisc = (base) => this._applyDiscount(base, document.discountType, document.discountValue);
    let subtotal;
    let amount;
    let summaryMode = 'fixed';
    if (isMenuPending) {
      summaryMode = 'menu_pending';
      subtotal = null;
      amount = null;
    } else if (isCompare && !selectedPkg) {
      summaryMode = 'compare_range';
      subtotal = null;
      amount = null;
    } else if (isCompare && selectedPkg) {
      summaryMode = 'compare_selected';
      subtotal = Number(selectedPkg.price) || 0;
      amount = Number(document.amount) || applyDisc(subtotal);
    } else {
      subtotal = lineItems.length ? lineTotal : (servicesTotal || Number(document.basePrice) || Number(document.amount) || 0);
      amount = document.amount;
    }

    // The issuing entity follows the client's payment rail — LLC for Pay via
    // CRM, LLP otherwise — so the quotation matches the invoice it becomes.
    const letterhead = await this._letterheadForDocument(orgId, document);

    // The template's authored narrative (rich HTML — see htmlSanitizer.js /
    // renderHtmlTemplate) — this is the actual "This Agreement is entered into
    // between…" content the admin wrote, not just the structured pricing
    // tables below. Agreements/proposals lead the PDF with this; quotations
    // keep the pricing-first layout (see DocumentLetterheadPdf.js).
    const { rendered: narrativeHtml } = await this._renderBody(orgId, document, document.template);

    // Structured letterhead layout — no free-text template dump (that looked odd).
    const buffer = await buildDocumentPdfOnLetterhead({
      // Drives the coded letterhead header — see services/letterhead.js.
      branding: branding ? branding.toJSON() : null,
      letterhead,
      type: document.type,
      number: document.number,
      createdAt: document.createdAt,
      issuedAt: document.sentAt || document.createdAt,
      prospectName: document.prospectName,
      businessName: document.businessName,
      email: document.email,
      phone: document.phone,
      currency: document.currency || 'USD',
      amount,
      subtotal,
      discountLabel,
      validUntil: document.validUntil,
      services,
      lineItems,
      packageOptions,
      packageMenu: packageMenuForPdf,
      selectedPackageId,
      selectedPackageLabel: selectedPkg ? (selectedPkg.tier || selectedPkg.name) : null,
      summaryMode,
      optionMinAmount: optionMin != null ? applyDisc(optionMin) : null,
      optionMaxAmount: optionMax != null ? applyDisc(optionMax) : null,
      hideServiceAmounts: isCompare && !selectedPkg,
      // Org invoice T&Cs (Admin → Branding), same text invoices use.
      terms: (letterhead.invoiceTerms && String(letterhead.invoiceTerms).trim())
        || (branding?.invoiceTerms && String(branding.invoiceTerms).trim())
        || DEFAULT_DOCUMENT_TERMS,
      narrativeHtml,
    });

    return { buffer, document };
  }
}

module.exports = new CustomerDocumentService();
