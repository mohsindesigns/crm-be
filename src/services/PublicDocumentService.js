// Token-scoped only — every method here is reachable with zero authentication,
// so none of them ever take an orgId param; the publicToken itself is the scope.
// See middleware note: this module is called directly from routes/publicDocuments.js
// with no auth/tenancy/rbac in front of it.
const { v4: uuidv4 } = require('uuid');
const db = require('../models');
const { DEFAULT_BRAND_COLOR } = require('../config/constants');
const NotificationService = require('./NotificationService');

const RESPONDABLE_STATUSES = ['sent', 'viewed'];

class PublicDocumentService {
  async _findByToken(token) {
    if (!token) {
      const err = new Error('Invalid link.');
      err.status = 404;
      throw err;
    }
    const document = await db.CustomerDocument.findOne({
      where: { publicToken: token },
      include: [{ model: db.DocumentTemplate, as: 'template', attributes: ['id', 'type'] }],
    });
    if (!document) {
      const err = new Error('This link is invalid or has expired.');
      err.status = 404;
      throw err;
    }

    // Lazy-expire: the scheduler sweeps this too, but a customer opening the
    // link right at the boundary should never be able to approve a technically
    // expired document just because the sweep hasn't ticked yet.
    if (
      RESPONDABLE_STATUSES.includes(document.status) &&
      document.validUntil &&
      new Date(document.validUntil) < new Date(new Date().toISOString().split('T')[0])
    ) {
      await document.update({ status: 'expired' });
    }

    return document;
  }

  async getByToken(token, ip, { markAsViewed = true } = {}) {
    const document = await this._findByToken(token);

    // Only real client opens should flip sent → viewed. Staff previewing the
    // public review link (logged-in org member, or ?preview=1) must not.
    if (markAsViewed && document.status === 'sent') {
      await document.update({ status: 'viewed', viewedAt: new Date() });
      await db.DocumentEvent.create({ documentId: document.id, event: 'viewed', actor: 'customer', ip });
    }

    // Resolve packageOptions (ids only, on the model) into the actual name/price/
    // features the client needs to compare — kept as a plain side-loaded field
    // rather than a Sequelize include since packageOptions isn't a real FK column.
    const optionIds = Array.isArray(document.packageOptions) ? document.packageOptions : [];
    const packageOptionDetails = optionIds.length
      ? await db.Package.findAll({
          where: { id: optionIds, orgId: document.orgId },
          attributes: ['id', 'name', 'tier', 'price', 'currency', 'features', 'isRecurring', 'billingCycle'],
          // Cheapest first — see CustomerDocumentService#_resolvePackageMenuDetails.
          order: [['price', 'ASC']],
        })
      : [];

    const prices = packageOptionDetails.map((p) => Number(p.price) || 0);
    const optionMinPrice = prices.length ? Math.min(...prices) : null;
    const optionMaxPrice = prices.length ? Math.max(...prices) : null;

    // "Build your own" mode — per-service candidate packages the client can
    // freely pick 0/1 of, independently per service (see CustomerDocumentService).
    const CustomerDocumentService = require('./CustomerDocumentService');
    const menu = Array.isArray(document.packageMenu) ? document.packageMenu : [];
    const packageMenuDetails = menu.length
      ? await CustomerDocumentService._resolvePackageMenuDetails(menu, document.orgId)
      : [];

    // Plain list-view data (no PDF rendering needed to see what's being quoted):
    // resolve `services` (serviceTypeKey/packageId only, on the model) into
    // readable service/package names. Populated for fixed-price docs, and for
    // compare/menu docs once approved (their pre-approval state has no services
    // yet — the interactive picker above already shows what's on offer then).
    const rawServices = Array.isArray(document.services) ? document.services : [];
    const serviceKeys = [...new Set(rawServices.map((s) => s.serviceTypeKey).filter(Boolean))];
    const servicePackageIds = [...new Set(rawServices.map((s) => s.packageId).filter(Boolean))];
    const [serviceTypes, servicePackages] = await Promise.all([
      serviceKeys.length
        ? db.ServiceType.findAll({ where: { orgId: document.orgId, key: serviceKeys }, attributes: ['key', 'name'] })
        : [],
      servicePackageIds.length
        ? db.Package.findAll({ where: { id: servicePackageIds, orgId: document.orgId }, attributes: ['id', 'name', 'tier', 'features'] })
        : [],
    ]);
    const serviceNameByKey = Object.fromEntries(serviceTypes.map((s) => [s.key, s.name]));
    const servicePackageById = Object.fromEntries(servicePackages.map((p) => [p.id, p]));
    const resolvedServices = rawServices.map((s) => {
      const pkg = servicePackageById[s.packageId];
      return {
        serviceTypeKey: s.serviceTypeKey,
        serviceName: serviceNameByKey[s.serviceTypeKey] || s.serviceTypeKey,
        packageLabel: pkg ? (pkg.tier || pkg.name) : null,
        price: s.price != null ? Number(s.price) : null,
        scope: s.scope || '',
        features: pkg?.features || null,
      };
    });

    const branding = await db.WhiteLabelConfig.findOne({ where: { orgId: document.orgId } });

    // Which of our legal entities is quoting this client — same rule as the PDF
    // and the eventual invoice (see letterhead.billingCompanyFor).
    let issuer = null;
    if (document.clientId) {
      const client = await db.Client.findOne({
        where: { id: document.clientId, orgId: document.orgId },
        attributes: ['id', 'billingMode'],
      }).catch(() => null);
      if (client) {
        const { billingCompanyFor } = require('./letterhead');
        issuer = await billingCompanyFor(document.orgId, client.billingMode === 'stripe').catch(() => null);
      }
    }

    // Step two of the review flow: once approved, the client owes us the billing
    // details an invoice can't be raised without.
    const requiresDetails = document.status === 'approved' && !document.detailsSubmittedAt;
    const detailPrefill = (requiresDetails || document.detailsSubmittedAt)
      ? await this._detailPrefill(document)
      : null;

    // Drives the "Pay Now" button — see StripeService.startDocumentPayment.
    // Not yet converted (nothing to pay if it already has a real invoice —
    // that invoice's own /invoice/[token] page is what pays it from here) and
    // the org actually accepts cards.
    const alreadyConverted = !!(document.convertedClientId || document.convertedProjectId);
    const canPayByCard = document.status === 'approved'
      && !!document.detailsSubmittedAt
      && !alreadyConverted
      && Number(document.amount) > 0
      && !!(await db.PaymentMethod.findOne({ where: { orgId: document.orgId, kind: 'stripe', isActive: true } }).catch(() => null));

    return {
      document: {
        ...document.toJSON(),
        packageOptionDetails,
        packageMenuDetails,
        resolvedServices,
        pricingMode: packageMenuDetails.length ? 'menu' : (optionIds.length > 1 ? 'compare' : 'fixed'),
        optionMinPrice,
        optionMaxPrice,
        requiresDetails,
        detailPrefill,
        canPayByCard,
      },
      branding: {
        brandName: branding?.brandName || 'Mohsin Designs Project Management',
        primaryColor: branding?.primaryColor || DEFAULT_BRAND_COLOR,
        logoUrl: branding?.logoUrl || null,
        // The ISSUING ENTITY's own details, not the org-wide ones. Which company
        // is quoting follows the client's payment rail (LLC for Pay via CRM, LLP
        // otherwise), so the page a client reads names the same company that
        // will invoice them. Falls back to the org branding when no company row
        // supplies a value.
        legalName: issuer?.legalName || branding?.brandName || null,
        businessAddress: issuer?.address || branding?.businessAddress || null,
        businessPhone: issuer?.phone || branding?.businessPhone || null,
        website: issuer?.website || branding?.website || null,
        taxNumber: issuer?.taxNumber || branding?.taxNumber || null,
        taxLabel: issuer?.taxLabel || null,
        email: issuer?.email || branding?.emailFrom || null,
      },
    };
  }

  async _notifyAdmins(document, title, body) {
    try {
      const allOrgUsers = await db.User.findAll({
        where: { orgId: document.orgId },
        include: [{ model: db.Role, as: 'role' }],
      });
      const recipients = allOrgUsers.filter((u) =>
        ['super_admin', 'admin'].includes(u.role?.key) || u.role?.permissions?.['admin.access']
      );
      await Promise.all(recipients.map((u) => NotificationService.notify(u.id, document.orgId, {
        type: 'document_response',
        title,
        body,
        refTable: 'customer_documents',
        refId: document.id,
      })));
    } catch (err) {
      console.error('[PublicDocumentService] Failed to notify admins:', err.message);
    }
  }

  async approve(token, { signerName, ip, selectedPackageId, selectionReason, menuSelections } = {}) {
    const document = await this._findByToken(token);
    if (!RESPONDABLE_STATUSES.includes(document.status)) {
      const err = new Error('This document is no longer available for review.');
      err.status = 409;
      throw err;
    }

    // Treated as a real digital signature, not a formality — the frontend
    // already disables the button until this matches, but this is the public,
    // unauthenticated endpoint, so re-check server-side too.
    const normalize = (v) => String(v || '').trim().replace(/\s+/g, ' ').toLowerCase();
    if (!normalize(signerName) || normalize(signerName) !== normalize(document.prospectName)) {
      const err = new Error(`Please type "${document.prospectName}" exactly to sign.`);
      err.status = 400;
      throw err;
    }

    const menu = Array.isArray(document.packageMenu) ? document.packageMenu : [];
    const isMenu = menu.length > 0;

    let basePrice = document.basePrice != null ? Number(document.basePrice) : Number(document.amount) || 0;
    let amount = Number(document.amount) || 0;
    let services = Array.isArray(document.services) ? document.services.map((s) => ({ ...s })) : document.services;
    let chosenId = null;
    let cleanMenuSelections = null;

    if (isMenu) {
      // "Build your own" — client freely picks at most one package per service,
      // or none at all; total is simply the sum of whatever they picked.
      const requested = menuSelections && typeof menuSelections === 'object' ? menuSelections : {};
      const CustomerDocumentService = require('./CustomerDocumentService');
      const menuDetails = await CustomerDocumentService._resolvePackageMenuDetails(menu, document.orgId);

      cleanMenuSelections = {};
      const selectedServices = [];
      for (const entry of menuDetails) {
        const pickedId = requested[entry.serviceTypeKey];
        if (!pickedId) continue;
        const pkg = entry.packages.find((p) => p.id === pickedId);
        if (!pkg) continue;
        cleanMenuSelections[entry.serviceTypeKey] = pkg.id;
        selectedServices.push({
          serviceTypeKey: entry.serviceTypeKey,
          packageId: pkg.id,
          price: Number(pkg.price) || 0,
          name: entry.serviceName,
          packageLabel: pkg.tier || pkg.name,
          featuresText: Array.isArray(pkg.features) ? pkg.features.join(', ') : (pkg.features || ''),
        });
      }

      services = selectedServices;
      basePrice = selectedServices.reduce((sum, s) => sum + (s.price || 0), 0);
      const discValue = parseFloat(document.discountValue) || 0;
      if (document.discountType === 'percent' && discValue > 0) {
        amount = Math.max(0, Math.round((basePrice - (basePrice * Math.min(discValue, 100)) / 100) * 100) / 100);
      } else if (document.discountType === 'fixed' && discValue > 0) {
        amount = Math.max(0, Math.round((basePrice - discValue) * 100) / 100);
      } else {
        amount = Math.round(basePrice * 100) / 100;
      }
    } else {
      // 2+ package options on offer means the client must actually pick one —
      // a single (or no) option needs no choice, so nothing is required there.
      const options = Array.isArray(document.packageOptions) ? document.packageOptions : [];
      const isCompare = options.length > 1;
      if (isCompare) {
        if (!selectedPackageId || !options.includes(selectedPackageId)) {
          const err = new Error('Please select one of the package options before approving.');
          err.status = 400;
          throw err;
        }
      }

      chosenId = isCompare ? selectedPackageId : (options[0] || document.packageId || null);

      if (chosenId) {
        const pkg = await db.Package.findOne({
          where: { id: chosenId, orgId: document.orgId },
          attributes: ['id', 'price'],
        });
        if (pkg) {
          basePrice = Number(pkg.price) || 0;
          const discValue = parseFloat(document.discountValue) || 0;
          if (document.discountType === 'percent' && discValue > 0) {
            amount = Math.max(0, Math.round((basePrice - (basePrice * Math.min(discValue, 100)) / 100) * 100) / 100);
          } else if (document.discountType === 'fixed' && discValue > 0) {
            amount = Math.max(0, Math.round((basePrice - discValue) * 100) / 100);
          } else {
            amount = Math.round(basePrice * 100) / 100;
          }
          if (Array.isArray(services) && services.length) {
            services = services.map((s) => ({
              ...s,
              packageId: chosenId,
              price: basePrice,
            }));
          }
        }
      }
    }

    await document.update({
      status: 'approved',
      selectedPackageId: chosenId,
      packageId: chosenId || document.packageId,
      menuSelections: cleanMenuSelections,
      basePrice,
      amount,
      services,
      selectionReason: selectionReason?.trim() || null,
      signerName: signerName || document.prospectName,
      signedAt: new Date(),
      signatureMethod: 'typed',
      signatureIp: ip || null,
      respondedAt: new Date(),
    });
    await db.DocumentEvent.create({ documentId: document.id, event: 'approved', actor: 'customer', ip });

    await this._notifyAdmins(document, `Approved: ${document.number}`, `${document.prospectName} approved ${document.type} ${document.number}. It's ready to convert.`);

    // Same enriched payload as GET (resolvedServices, package details, branding)
    // so the review page can show the client's picks immediately without a refresh.
    return this.getByToken(token, ip);
  }

  /**
   * The billing details every approved document needs before it can be invoiced.
   *
   * Deliberately asymmetric with the admin's client form, where all of this is
   * optional: an admin jotting down a lead should not have to know the client's
   * registered address, but an invoice legally does. So the client confirms it
   * themselves, once, at the point where they have committed.
   */
  static get REQUIRED_DETAIL_FIELDS() {
    return [
      ['businessName', 'Business name'],
      ['contactPerson', 'Contact person'],
      ['designation', 'Designation'],
      ['email', 'Email'],
      ['phone', 'Phone'],
      ['address', 'Address'],
      ['state', 'State'],
    ];
  }

  /**
   * What the review page should prefill the detail form with — whatever the
   * admin already recorded against the client, so the client only fills the
   * gaps. Every field stays editable: they are the authority on their own
   * legal details, not us.
   */
  async _detailPrefill(document) {
    const blank = {
      businessName: document.businessName || '',
      contactPerson: document.prospectName || '',
      designation: '',
      email: document.email || '',
      phone: document.phone || '',
      address: '',
      state: '',
    };
    if (!document.clientId) return blank;

    const client = await db.Client.findOne({
      where: { id: document.clientId, orgId: document.orgId },
      include: [{ model: db.Contact, as: 'contacts', required: false }],
    });
    if (!client) return blank;

    const contacts = (client.contacts || []).filter((c) => c.isActive !== false);
    const c = contacts.find((x) => x.useForInvoice) || contacts[0] || null;
    return {
      businessName: c?.businessName || client.name || blank.businessName,
      contactPerson: c?.name || blank.contactPerson,
      designation: c?.role || '',
      email: c?.email || blank.email,
      phone: c?.phone || blank.phone,
      address: c?.billingAddress || '',
      state: c?.state || '',
    };
  }

  /**
   * Step two of approval: the client confirms who is being billed.
   *
   * Runs after approval rather than before it because the commitment is the
   * approval — making someone fill in seven fields before they can say yes adds
   * friction exactly where you least want it. Billing is what waits, and it is
   * kicked off from here (see CustomerDocumentService.convert) because the
   * invoice needs the address this form collects.
   */
  async submitDetails(token, { details = {}, ip } = {}) {
    const document = await this._findByToken(token);
    if (document.status !== 'approved') {
      const err = new Error('This document has not been approved yet.');
      err.status = 409;
      throw err;
    }

    const clean = {};
    const missing = [];
    for (const [field, label] of PublicDocumentService.REQUIRED_DETAIL_FIELDS) {
      const value = String(details[field] ?? '').trim();
      if (!value) missing.push(label);
      clean[field] = value;
    }
    if (missing.length) {
      const err = new Error(`Please fill in: ${missing.join(', ')}.`);
      err.status = 400;
      throw err;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean.email)) {
      const err = new Error('Please enter a valid email address.');
      err.status = 400;
      throw err;
    }

    const alreadySubmitted = !!document.detailsSubmittedAt;

    // Write through to the real client record — this is the client correcting
    // and completing what the admin sketched, so it becomes the truth used by
    // every future invoice, not a copy frozen on the document.
    let clientId = document.clientId;
    if (clientId) {
      const client = await db.Client.findOne({
        where: { id: clientId, orgId: document.orgId },
        include: [{ model: db.Contact, as: 'contacts', required: false }],
      });
      if (client) {
        const contacts = (client.contacts || []).filter((c) => c.isActive !== false);
        const billing = contacts.find((c) => c.useForInvoice) || contacts[0] || null;
        const contactFields = {
          name: clean.contactPerson,
          role: clean.designation,
          email: clean.email,
          phone: clean.phone,
          businessName: clean.businessName,
          billingAddress: clean.address,
          state: clean.state,
          useForInvoice: true,
        };
        if (billing) await billing.update(contactFields);
        else await db.Contact.create({ id: uuidv4(), clientId: client.id, ...contactFields });
      }
    }

    await document.update({
      businessName: clean.businessName,
      prospectName: clean.contactPerson,
      email: clean.email,
      phone: clean.phone,
      detailsSubmittedAt: new Date(),
    });

    // Audit trail and admin notifications are bookkeeping. They must never be
    // able to abort the billing below — an event row failing to write once left
    // a document marked submitted but never converted, with no way to retry.
    if (!alreadySubmitted) {
      try {
        await db.DocumentEvent.create({ documentId: document.id, event: 'details_submitted', actor: 'customer', ip });
      } catch (err) {
        console.error('[PublicDocumentService] Could not log details_submitted event:', err.message);
      }
      await this._notifyAdmins(
        document,
        `Billing details received: ${document.number}`,
        `${clean.contactPerson} (${clean.businessName}) completed billing details for ${document.type} ${document.number}.`,
      );
    }

    // Conversion is deliberately NOT triggered here. It creates projects, sells
    // packages and raises an invoice — and for a document with no clientId it
    // creates a client too, which off an unauthenticated public endpoint is how
    // duplicate client records get made with nobody watching unless something
    // concrete happened first. That something is either an admin pressing
    // "Convert to Project" after checking these details, or the client paying
    // by card via startPayment below (conversion runs from the Stripe webhook,
    // once the money has actually cleared).
    return this.getByToken(token, ip, { markAsViewed: false });
  }

  /**
   * "Pay Now" on the review page — sends the client straight to Stripe for the
   * document's own total. See StripeService.startDocumentPayment for why this
   * exists instead of converting first and asking for payment after: nothing
   * (client, project, invoice) gets created until the payment actually clears.
   */
  async startPayment(token) {
    const document = await this._findByToken(token);
    const StripeService = require('./StripeService');
    return StripeService.startDocumentPayment(document.id, document.orgId);
  }

  async reject(token, { note, ip } = {}) {
    if (!note || !note.trim()) {
      const err = new Error('Please describe the changes you would like.');
      err.status = 400;
      throw err;
    }
    const document = await this._findByToken(token);
    if (!RESPONDABLE_STATUSES.includes(document.status)) {
      const err = new Error('This document is no longer available for review.');
      err.status = 409;
      throw err;
    }

    await document.update({
      status: 'rejected',
      responseNote: note.trim(),
      respondedAt: new Date(),
    });
    await db.DocumentEvent.create({ documentId: document.id, event: 'rejected', actor: 'customer', ip, note: note.trim() });

    await this._notifyAdmins(document, `Changes requested: ${document.number}`, `${document.prospectName} requested changes on ${document.type} ${document.number}: "${note.trim()}"`);

    return this.getByToken(token, ip);
  }

  async getPdfBuffer(token) {
    const document = await this._findByToken(token);
    // Delegates to the admin-side renderer — same PDF, no logic duplicated.
    const CustomerDocumentService = require('./CustomerDocumentService');
    return CustomerDocumentService.generatePdfBuffer(document.id, document.orgId);
  }
}

module.exports = new PublicDocumentService();
