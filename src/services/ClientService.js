const db = require('../models');
const { Client, Contact } = db;
const { Op } = require('sequelize');
const { v4: uuidv4 } = require('uuid');
const { buildProjectName } = require('../utils/projectName');
const RetainerService = require('./RetainerService');
const InvoiceService = require('./InvoiceService');
const { billingCompanyFor } = require('./letterhead');
const { isTruthy } = require('./SoftDeleteService');

class ClientService {
  async list(orgId, query = {}) {
    const page  = Math.max(1, parseInt(query.page)  || 1);
    const limit = Math.min(100, parseInt(query.limit) || 25);
    const offset = (page - 1) * limit;

    const where = { orgId };
    // Deactivated clients are hidden unless explicitly asked for.
    if (!isTruthy(query.includeInactive)) where.isActive = true;
    if (query.status) where.status = query.status;
    if (query.search) where.name = { [Op.like]: `%${query.search}%` };

    // `balance=overdue|outstanding` narrows the list to clients who owe money.
    // Resolved to a set of client IDs and folded into the WHERE clause BEFORE
    // pagination — filtering the page after it was fetched would give wrong
    // totals and half-empty pages.
    if (query.balance === 'overdue' || query.balance === 'outstanding') {
      const statuses = query.balance === 'overdue'
        ? ['overdue']
        : ['sent', 'overdue', 'payment_review'];
      try {
        const owing = await db.Invoice.findAll({
          where: { orgId, status: { [Op.in]: statuses } },
          attributes: ['clientId'],
          group: ['clientId'],
          having: db.sequelize.where(db.sequelize.fn('SUM', db.sequelize.col('total')), Op.gt, 0),
          raw: true,
        });
        const ids = owing.map((r) => r.clientId).filter(Boolean);
        // No matches must yield an empty list, not an unfiltered one.
        where.id = { [Op.in]: ids.length ? ids : ['__none__'] };
      } catch (err) {
        console.error('[ClientService.list] balance filter skipped:', err.message);
      }
    }

    const { count, rows } = await Client.findAndCountAll({
      where,
      include: [{ model: Contact, as: 'contacts', attributes: ['id'], where: { isActive: true }, required: false }],
      order: [['name', 'ASC']],
      limit,
      offset,
      distinct: true,
    });

    // Client-wise unpaid totals for the Clients list "Outstanding" column.
    // Matches dashboard/analytics: sent + overdue + payment_review.
    // Never fail the whole Clients page if invoices schema is mid-migration
    // (e.g. missing `total` column) — return clients with empty outstanding.
    //
    // What's OWED is the invoice total minus what's been paid against it. Summing
    // `total` alone counted a part-paid invoice at its full face value, so a
    // client who had already paid $3,550 of $5,550 still showed $5,550 owing.
    // Correlated subquery rather than a JOIN: joining payments fans out one row
    // per payment and multiplies the totals. GREATEST(...,0) keeps an
    // overpayment from showing as negative debt.
    const UNPAID_SUM = db.sequelize.literal(
      'SUM(GREATEST(`Invoice`.`total` - COALESCE('
      + '(SELECT SUM(`p`.`amount`) FROM `payments` `p` WHERE `p`.`invoiceId` = `Invoice`.`id`), 0), 0))',
    );
    const clientIds = rows.map((r) => r.id);
    const outstandingByClient = new Map();
    if (clientIds.length && db.Invoice) {
      try {
        const aggregates = await db.Invoice.findAll({
          where: {
            orgId,
            clientId: { [Op.in]: clientIds },
            status: { [Op.in]: ['sent', 'overdue', 'payment_review'] },
          },
          attributes: [
            'clientId',
            'currency',
            [UNPAID_SUM, 'amount'],
          ],
          group: ['clientId', 'currency'],
          raw: true,
        });
        for (const row of aggregates) {
          const id = row.clientId;
          if (!outstandingByClient.has(id)) outstandingByClient.set(id, []);
          outstandingByClient.get(id).push({
            currency: row.currency || 'USD',
            amount: Math.round((parseFloat(row.amount) || 0) * 100) / 100,
          });
        }
      } catch (err) {
        console.error('[ClientService.list] outstanding aggregate skipped:', err.message);
      }
    }

    // Overdue is tracked separately from outstanding: "owes money" and "is late
    // paying" are different questions, and only the second one needs chasing.
    const overdueByClient = new Map();
    if (clientIds.length && db.Invoice) {
      try {
        const overdue = await db.Invoice.findAll({
          where: { orgId, clientId: { [Op.in]: clientIds }, status: 'overdue' },
          attributes: [
            'clientId',
            [UNPAID_SUM, 'amount'],
            [db.sequelize.fn('COUNT', db.sequelize.col('Invoice.id')), 'count'],
          ],
          group: ['clientId'],
          raw: true,
        });
        for (const row of overdue) {
          overdueByClient.set(row.clientId, {
            amount: Math.round((parseFloat(row.amount) || 0) * 100) / 100,
            count: parseInt(row.count, 10) || 0,
          });
        }
      } catch (err) {
        console.error('[ClientService.list] overdue aggregate skipped:', err.message);
      }
    }

    const data = rows.map((client) => {
      const json = typeof client.toJSON === 'function' ? client.toJSON() : client;
      const outstanding = outstandingByClient.get(client.id) || [];
      const outstandingTotal = outstanding.reduce((sum, o) => sum + (o.amount || 0), 0);
      const overdue = overdueByClient.get(client.id) || { amount: 0, count: 0 };
      return {
        ...json,
        outstanding,
        outstandingTotal,
        overdueTotal: overdue.amount,
        overdueCount: overdue.count,
      };
    });

    return { data, total: count, page, totalPages: Math.ceil(count / limit) || 1, limit };
  }

  async findById(id, orgId, { includeInactiveContacts = false } = {}) {
    const client = await Client.findOne({
      where: { id, orgId },
      include: [{
        model: Contact,
        as: 'contacts',
        ...(includeInactiveContacts ? {} : { where: { isActive: true }, required: false }),
      }],
    });
    if (!client) {
      const err = new Error('Client not found.');
      err.status = 404;
      throw err;
    }
    return client;
  }

  /**
   * The legal entity (LLC or LLP) that will issue this client's invoices and
   * quotations, per their "Pay via CRM" billing mode — surfaced read-only on
   * the client page so staff can see which company applies without opening a
   * document. Same hard rule InvoiceService/CustomerDocumentService use — see
   * letterhead.billingCompanyFor. Null when the org has no companies configured
   * (documents fall back to the legacy branding letterhead in that case).
   */
  async resolveBillingCompany(client, orgId) {
    const company = await billingCompanyFor(orgId, client.billingMode === 'stripe').catch(() => null);
    if (!company) return null;
    return {
      id: company.id,
      legalName: company.legalName,
      code: company.code,
      officeLabel: company.officeLabel,
    };
  }

  async create(orgId, data, actorUserId = null) {
    const client = await Client.create({
      id: uuidv4(),
      orgId,
      name: data.name,
      status: data.status || 'active',
      defaultCurrency: data.defaultCurrency || 'USD',
      notes: data.notes,
    });
    // Client-scoped Messages room — employees join later via project assignment.
    try {
      const ChatService = require('./ChatService');
      await ChatService.ensureClientRoom(orgId, client.id, actorUserId);
    } catch (err) {
      console.error('[ClientService] Failed to ensure Messages room:', err.message);
    }
    return client;
  }

  async update(id, orgId, data) {
    const client = await this.findById(id, orgId);
    await client.update({
      name: data.name ?? client.name,
      status: data.status ?? client.status,
      defaultCurrency: data.defaultCurrency ?? client.defaultCurrency,
      notes: data.notes ?? client.notes,
    });
    return client;
  }

  /**
   * Switch how a client pays: 'stripe' puts them on the card rail (Stripe number
   * series, live pay link on the PDF, card option pre-selected in the portal),
   * 'manual' keeps the existing bank-transfer / receipt-upload flow.
   *
   * Applies to invoices already raised as well as future ones — the whole point
   * is "this client pays by card", not "this client pays by card from now on".
   * Invoices with payments recorded against them are never touched, and already
   * sent invoices keep their number (see InvoiceService.applyClientBillingMode).
   */
  async setBillingMode(id, orgId, billingMode) {
    if (!['manual', 'stripe'].includes(billingMode)) {
      const err = new Error("billingMode must be either 'manual' or 'stripe'.");
      err.status = 400;
      throw err;
    }
    const client = await this.findById(id, orgId);
    if (client.billingMode === billingMode) {
      return { client, updatedInvoices: 0, unchanged: true };
    }
    // Applied to the invoices first: if no Stripe method is configured this
    // throws, and the client is left on the mode that actually works rather than
    // flagged for a rail that isn't set up.
    const { updated } = await InvoiceService.applyClientBillingMode(orgId, id, billingMode);
    await client.update({ billingMode });
    return { client, updatedInvoices: updated };
  }

  /**
   * Whether the org's card processing fee rate is added on top for this
   * client's Stripe payments, or absorbed by the agency instead. Read at
   * charge time (StripeService.processingFeeFor) for every invoice AND
   * quotation/agreement/proposal payment — nothing to backfill here, it just
   * takes effect on the next payment attempt.
   */
  async setChargeCardFee(id, orgId, chargeCardFee) {
    if (typeof chargeCardFee !== 'boolean') {
      const err = new Error('chargeCardFee must be true or false.');
      err.status = 400;
      throw err;
    }
    const client = await this.findById(id, orgId);
    await client.update({ chargeCardFee });
    return { client };
  }

  // Blocks deletion if the client has any projects, invoices, retainers, or sold
  // packages on record — deleting those out from under their history would be
  // destructive and irreversible. Change the client's status instead if it's just
  // no longer active. Contacts have no such history and are removed along with it.
  // Deactivates rather than destroys — see services/SoftDeleteService.js. Because
  // nothing is actually removed, the old "still has projects/invoices" blockers no
  // longer apply: those records keep resolving against the (now inactive) client.
  async remove(id, orgId, active = false) {
    const client = await this.findById(id, orgId, { includeInactiveContacts: true });
    await client.update({ isActive: active });
    // Contacts follow their client — a deactivated client's contacts should not
    // keep showing up in pickers or hold portal access.
    await Contact.update({ isActive: active }, { where: { clientId: id } });
    return client;
  }

  /**
   * A contact without an email is unreachable, and three separate things depend
   * on being able to reach them: the quotation/agreement review link, invoice
   * emails, and the portal login code. Left optional, the first quotation for
   * that client dead-ends at "who do we send this to?".
   *
   * Name stays the only other requirement — everything else (address, state,
   * designation) is asked of the client themselves after they approve.
   */
  _validateContact(data, { partial = false } = {}) {
    if (!partial || data.name !== undefined) {
      if (!String(data.name || '').trim()) {
        const err = new Error('Contact person name is required.');
        err.status = 422;
        throw err;
      }
    }
    if (!partial || data.email !== undefined) {
      const email = String(data.email || '').trim();
      if (!email) {
        const err = new Error('Contact email is required — quotations, invoices and portal logins are all sent there.');
        err.status = 422;
        throw err;
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        const err = new Error('Please enter a valid contact email address.');
        err.status = 422;
        throw err;
      }
    }
  }

  async addContact(clientId, orgId, data) {
    const client = await this.findById(clientId, orgId);
    this._validateContact(data);
    const useForInvoice = !!data.useForInvoice;
    const contact = await Contact.create({
      id: uuidv4(),
      clientId: client.id,
      name: data.name,
      email: data.email,
      phone: data.phone,
      role: data.role,
      businessName: data.businessName || null,
      state: data.state || null,
      billingAddress: data.billingAddress || null,
      useForInvoice,
      portalAccess: data.portalAccess || false,
    });
    if (useForInvoice) await this._clearOtherInvoiceContacts(client.id, contact.id);
    return contact;
  }

  // Exactly one contact per client can be the billing contact — the invoice PDF
  // prints a single "Bill To" block, so flagging a new one has to unflag the old.
  async _clearOtherInvoiceContacts(clientId, keepContactId) {
    await Contact.update(
      { useForInvoice: false },
      { where: { clientId, id: { [Op.ne]: keepContactId } } },
    );
  }

  async getContact(contactId, clientId, orgId) {
    const client = await this.findById(clientId, orgId);
    const contact = await Contact.findOne({ where: { id: contactId, clientId: client.id } });
    if (!contact) {
      const err = new Error('Contact not found.');
      err.status = 404;
      throw err;
    }
    return contact;
  }

  async updateContact(contactId, clientId, orgId, data) {
    const contact = await this.getContact(contactId, clientId, orgId);
    // Partial: only vet the fields actually being changed, so a caller toggling
    // portalAccess alone isn't rejected for not resending name/email.
    this._validateContact(data, { partial: true });
    await contact.update(data);
    if (data.useForInvoice) await this._clearOtherInvoiceContacts(contact.clientId, contact.id);
    return contact;
  }

  // Deactivates rather than destroys — see services/SoftDeleteService.js.
  async removeContact(contactId, clientId, orgId, active = false) {
    const client = await this.findById(clientId, orgId, { includeInactiveContacts: true });
    const contact = await Contact.findOne({ where: { id: contactId, clientId: client.id } });
    if (!contact) {
      const err = new Error('Contact not found.');
      err.status = 404;
      throw err;
    }
    await contact.update({ isActive: active });
    return contact;
  }

  // ─── Packages ───────────────────────────────────────────────────────────────

  async listSoldPackages(clientId, orgId) {
    await this.findById(clientId, orgId);
    return db.ClientPackage.findAll({
      where: { clientId, orgId },
      include: [
        // skipProjectCreation so the UI can explain an empty workflow list.
        // Billing-only packages (add-ons, hosting) legitimately spawn none, and
        // "No workflows." on its own reads as something having gone wrong.
        { model: db.Package, as: 'package', attributes: ['id', 'name', 'tier', 'skipProjectCreation'] },
        { model: db.Project, as: 'workflowProjects', attributes: ['id', 'name', 'status', 'currentStageKey'] },
      ],
      order: [['createdAt', 'DESC']],
    });
  }

  async listSellablePackages(orgId) {
    return db.Package.findAll({ where: { orgId, isActive: true }, order: [['name', 'ASC']] });
  }

  _computeSoldPrice(basePrice, discountType, discountValue) {
    let soldPrice = basePrice;
    const value = parseFloat(discountValue) || 0;
    if (value > 0) {
      if (discountType === 'percent') soldPrice = basePrice - (basePrice * Math.min(value, 100)) / 100;
      else if (discountType === 'fixed') soldPrice = basePrice - value;
    }
    return Math.max(0, Math.round(soldPrice * 100) / 100);
  }

  // Sells a package to a client: records the sale (with optional discount) and
  // spawns one project per bundled service, each with its own workflow. If the
  // package is recurring, a single retainer covering the whole package is also
  // created and the first cycle is invoiced immediately.
  async sellPackage(clientId, orgId, data, userId) {
    const client = await this.findById(clientId, orgId);
    const pkg = await db.Package.findOne({ where: { id: data.packageId, orgId, isActive: true } });
    if (!pkg) {
      const err = new Error('Package not found or inactive.');
      err.status = 404;
      throw err;
    }

    const basePrice = parseFloat(pkg.price || 0);
    // An explicit sell-price override takes priority over the discount fields — it's
    // a direct "sell it for this much" rather than a percent/fixed markdown off list.
    const hasCustomPrice = data.customPrice !== undefined && data.customPrice !== null && data.customPrice !== '';
    const discountType = !hasCustomPrice && ['percent', 'fixed'].includes(data.discountType) ? data.discountType : null;
    const discountValue = discountType ? parseFloat(data.discountValue) || 0 : null;
    const soldPrice = hasCustomPrice
      ? Math.max(0, Math.round(parseFloat(data.customPrice) * 100) / 100)
      : this._computeSoldPrice(basePrice, discountType, discountValue);
    const currency = pkg.currency || client.defaultCurrency;
    // An installment plan set on this specific sale overrides whatever plan is
    // baked into the package template — different clients buying the same
    // package can still agree to different payment schedules.
    const installmentPlan = Array.isArray(data.installmentPlan) && data.installmentPlan.length
      ? data.installmentPlan
      : pkg.installmentPlan;
    // Prefer an explicit start date; otherwise use the server's local calendar day
    // (not UTC) so early-morning PKT sales don't land on "yesterday".
    const startDate = (data.startDate && String(data.startDate).slice(0, 10)) || (() => {
      const d = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    })();

    const services = Array.isArray(pkg.services) && pkg.services.length
      ? pkg.services
      : [{ serviceTypeKey: pkg.serviceTypeKey, workflowTemplateId: null }];

    const { clientPackage, projects } = await db.sequelize.transaction(async (t) => {
      const clientPackage = await db.ClientPackage.create({
        orgId, clientId, packageId: pkg.id,
        basePrice, discountType, discountValue, soldPrice, currency,
        billingCycle: pkg.billingCycle || 'monthly',
        status: 'active',
        startDate,
        createdBy: userId,
      }, { transaction: t });

      const projects = [];
      // Hosting-style packages: skip the workflow/project spawn entirely, still
      // bill normally below (see the isRecurring/installment blocks after commit).
      for (const svc of pkg.skipProjectCreation ? [] : services) {
        if (!svc.serviceTypeKey) continue;

        let templateId = svc.workflowTemplateId || null;
        if (!templateId) {
          const tmpl = await db.WorkflowTemplate.findOne({
            where: { orgId, serviceTypeKey: svc.serviceTypeKey, isActive: true },
            order: [['version', 'DESC']],
            transaction: t,
          });
          if (!tmpl) continue; // no active workflow published for this service yet — skip gracefully
          templateId = tmpl.id;
        }
        const template = await db.WorkflowTemplate.findByPk(templateId, { transaction: t });
        const firstStage = await db.Stage.findOne({
          where: { templateId }, order: [['orderIndex', 'ASC']], transaction: t,
        });
        if (!template || !firstStage) continue;

        const serviceType = await db.ServiceType.findOne({
          where: { orgId, key: svc.serviceTypeKey }, attributes: ['name'], transaction: t,
        });

        const project = await db.Project.create({
          id: uuidv4(),
          orgId, clientId,
          name: buildProjectName(client.name, serviceType?.name || svc.serviceTypeKey, pkg.tier || pkg.name),
          serviceTypeKey: svc.serviceTypeKey,
          workflowTemplateId: templateId,
          packageId: pkg.id,
          clientPackageId: clientPackage.id,
          currentStageKey: firstStage.key,
          status: 'active',
          startDate,
          isRecurring: !!template.isRecurring,
          createdBy: userId,
        }, { transaction: t });

        await db.ProjectEvent.create({
          projectId: project.id, fromStageKey: null, toStageKey: firstStage.key,
          action: 'created', actorUserId: userId, note: `Created from package sale: ${pkg.name}`,
        }, { transaction: t });

        projects.push(project);
      }

      if (projects.length === 0 && !pkg.skipProjectCreation) {
        const err = new Error('This package has no services with a published workflow template. Configure at least one in Admin → Packages.');
        err.status = 400;
        throw err;
      }

      return { clientPackage, projects };
    });

    // Billing happens after the transaction commits — InvoiceService manages its
    // own transaction and shouldn't be nested inside the one above.
    //
    // Recurring package (or spawned recurring workflow) → retainer + first invoice now;
    // later cycles via RetainerScheduler on nextInvoiceDate.
    // One-time + installmentPlan → one invoice per installment (due today = sent;
    // future due dates = draft until the scheduler issues them on the due date).
    // One-time with no plan → single invoice for the full sold price (due on start).
    const isRecurring = !!(pkg.isRecurring || projects.some((p) => p.isRecurring));
    let retainerCreated = false;
    let installmentInvoices = [];
    let billingError = null;
    const today = (() => {
      const d = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    })();

    if (isRecurring) {
      try {
        const cycle = ['monthly', 'quarterly', 'annual'].includes(pkg.billingCycle)
          ? pkg.billingCycle
          : 'monthly';
        await RetainerService.autoCreate({
          orgId, clientId,
          clientPackageId: clientPackage.id,
          packageId: pkg.id,
          projectId: projects[0]?.id || null,
          amount: soldPrice,
          currency,
          cycle,
          startDate,
          note: `Retainer for package: ${pkg.name}`,
          // Multiple packages sold to one client share a single first-cycle invoice.
          mergeWithOpenInvoice: true,
        });
        retainerCreated = true;
      } catch (err) {
        console.error('[ClientService] Failed to auto-create retainer for package sale:', err.stack || err.message);
        billingError = `The package was sold, but the retainer/invoice could not be created: ${err.message}`;
      }
    } else if (Array.isArray(installmentPlan) && installmentPlan.length > 0) {
      try {
        // Prefer an explicit dueAt (calendar date from the sell form). Fall back to
        // offsetDays for package-template plans that still store relative days.
        const startMs = new Date(`${startDate}T12:00:00`).getTime();
        const plan = installmentPlan;
        for (let i = 0; i < plan.length; i++) {
          const installment = plan[i];
          const percent = Number(installment.percent) || 0;
          if (percent <= 0) continue;
          let dueAt = null;
          if (installment.dueAt && /^\d{4}-\d{2}-\d{2}/.test(String(installment.dueAt))) {
            dueAt = String(installment.dueAt).slice(0, 10);
          } else {
            const offsetDays = Number(installment.offsetDays) || 0;
            const d = new Date(startMs);
            d.setDate(d.getDate() + offsetDays);
            const pad = (n) => String(n).padStart(2, '0');
            dueAt = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
          }
          const amount = Math.round(soldPrice * (percent / 100) * 100) / 100;
          // A free package produces zero-value installments — nothing to bill, so
          // skip them rather than issuing $0.00 invoices the client can't pay.
          if (!(amount > 0)) continue;
          // Issue immediately when the installment is already due; otherwise keep as
          // draft until RetainerScheduler promotes it on the due date.
          const status = dueAt <= today ? 'sent' : 'draft';
          const inv = await InvoiceService.create(orgId, {
            clientId,
            clientPackageId: clientPackage.id,
            currency,
            status,
            issuedAt: status === 'sent' ? today : dueAt,
            dueAt,
            notes: `Installment ${i + 1} of ${plan.length} — package: ${pkg.name}`,
            lines: [{
              description: installment.label || `Installment ${i + 1} of ${plan.length} — ${pkg.name}`,
              qty: 1,
              unitPrice: amount,
            }],
            // Same due date + client → one invoice with a line per package installment.
            mergeWithOpenInvoice: true,
          });
          if (inv) installmentInvoices.push(inv);
        }
        // Silence on a free package is correct, not an error — only flag a plan
        // that was actually worth something but produced nothing.
        if (installmentInvoices.length === 0 && soldPrice > 0) {
          billingError = 'Installment plan had no valid percentages — no invoices were created.';
        }
      } catch (err) {
        console.error('[ClientService] Failed to generate installment invoices for package sale:', err.stack || err.message);
        billingError = `The package was sold, but installment invoices could not be generated: ${err.message}`;
      }
    } else if (soldPrice > 0) {
      // Plain one-time sale: always create the invoice so billing isn't left manual.
      try {
        const inv = await InvoiceService.create(orgId, {
          clientId,
          clientPackageId: clientPackage.id,
          currency,
          status: 'sent',
          issuedAt: startDate,
          dueAt: startDate,
          notes: `Package sale: ${pkg.name}`,
          lines: [{ description: pkg.name, qty: 1, unitPrice: soldPrice }],
          // Same client buying several packages → one invoice, multiple line items.
          mergeWithOpenInvoice: true,
        });
        installmentInvoices.push(inv);
      } catch (err) {
        console.error('[ClientService] Failed to create invoice for one-time package sale:', err.stack || err.message);
        billingError = `The package was sold, but the invoice could not be created: ${err.message}`;
      }
    }

    // Ensure client Messages room + sync any assignees already on sibling projects.
    try {
      const ChatService = require('./ChatService');
      await ChatService.ensureClientRoom(orgId, clientId, userId);
      await ChatService.syncProjectAssignees(orgId, clientId);
    } catch (err) {
      console.error('[ClientService] Failed to sync Messages room after package sale:', err.message);
    }

    return {
      clientPackage,
      projects,
      isRecurring,
      retainerCreated,
      installmentInvoices,
      invoicesCreated: installmentInvoices.length,
      billingError,
    };
  }

  /**
   * Sell several packages to one client in a single action.
   *
   * Each package still goes through `sellPackage`, so every one gets its own
   * ClientPackage row, its own workflows and its own retainer where applicable —
   * nothing about a package sale changes just because it was bought alongside
   * others.
   *
   * The client gets ONE invoice, not one per package. That falls out of the
   * `mergeWithOpenInvoice` flag each sale already sets: the first sale raises the
   * invoice and the rest append their line items to it, since they share the
   * client, currency and due date. Sold sequentially rather than in parallel for
   * exactly that reason — concurrent sales would race to create the invoice and
   * could end up with two.
   *
   * A failure partway through does not roll back the packages already sold: they
   * are real sales with real workflows behind them. The failures are reported
   * back instead, naming the packages that need attention.
   */
  async sellPackages(clientId, orgId, data, userId) {
    const entries = Array.isArray(data.packages) ? data.packages.filter(Boolean) : [];
    if (!entries.length) {
      const err = new Error('Choose at least one package to sell.');
      err.status = 400;
      throw err;
    }

    const seen = new Set();
    for (const e of entries) {
      if (!e.packageId) {
        const err = new Error('Every selected row must name a package.');
        err.status = 400;
        throw err;
      }
      if (seen.has(e.packageId)) {
        const err = new Error('The same package was selected more than once.');
        err.status = 400;
        throw err;
      }
      seen.add(e.packageId);
    }

    const sold = [];
    const failed = [];

    for (const entry of entries) {
      try {
        const result = await this.sellPackage(clientId, orgId, {
          packageId: entry.packageId,
          // Per-package overrides, so two packages in one sale can carry
          // different discounts.
          customPrice: entry.customPrice,
          discountType: entry.discountType,
          discountValue: entry.discountValue,
          installmentPlan: entry.installmentPlan,
          // Shared across the sale — this is what makes the line items land on
          // one invoice rather than several.
          startDate: data.startDate,
        }, userId);
        sold.push(result);
      } catch (err) {
        const pkg = await db.Package.findOne({
          where: { id: entry.packageId, orgId }, attributes: ['name'],
        }).catch(() => null);
        failed.push({ packageId: entry.packageId, name: pkg?.name || 'Unknown package', message: err.message });
      }
    }

    if (!sold.length) {
      const err = new Error(`None of the packages could be sold. ${failed.map((f) => `${f.name}: ${f.message}`).join(' · ')}`);
      err.status = 400;
      throw err;
    }

    const billingErrors = sold.map((s) => s.billingError).filter(Boolean);

    return {
      soldCount: sold.length,
      projects: sold.flatMap((s) => s.projects || []),
      clientPackages: sold.map((s) => s.clientPackage),
      retainersCreated: sold.filter((s) => s.retainerCreated).length,
      installmentInvoices: sold.flatMap((s) => s.installmentInvoices || []),
      failed,
      billingError: billingErrors.length ? billingErrors.join(' · ') : null,
    };
  }

  async cancelClientPackage(clientPackageId, clientId, orgId) {
    await this.findById(clientId, orgId);
    const clientPackage = await db.ClientPackage.findOne({ where: { id: clientPackageId, clientId, orgId } });
    if (!clientPackage) {
      const err = new Error('Sold package not found.');
      err.status = 404;
      throw err;
    }
    const endDate = new Date().toISOString().split('T')[0];
    await db.sequelize.transaction(async (t) => {
      await clientPackage.update({ status: 'cancelled', endDate }, { transaction: t });
      await db.Project.update(
        { status: 'cancelled' },
        { where: { clientPackageId: clientPackage.id, status: { [Op.ne]: 'completed' } }, transaction: t }
      );
      await db.Retainer.update(
        { status: 'cancelled' },
        { where: { clientPackageId: clientPackage.id }, transaction: t }
      );
    });
    return clientPackage;
  }

  // Raises (or lowers) the price on an already-sold package — e.g. a premium client
  // adds keywords later and the retainer needs to go up. Clears the original
  // discount fields since soldPrice is no longer "list minus that discount" once it's
  // been manually overridden, and keeps the linked Retainer's amount in sync so the
  // next auto-invoice bills the new price.
  async updateClientPackagePrice(clientPackageId, clientId, orgId, newPrice) {
    await this.findById(clientId, orgId);
    const clientPackage = await db.ClientPackage.findOne({ where: { id: clientPackageId, clientId, orgId } });
    if (!clientPackage) {
      const err = new Error('Sold package not found.');
      err.status = 404;
      throw err;
    }
    const price = Math.round(parseFloat(newPrice) * 100) / 100;
    if (!Number.isFinite(price) || price < 0) {
      const err = new Error('A valid, non-negative price is required.');
      err.status = 400;
      throw err;
    }

    let retainerUpdated = false;
    await db.sequelize.transaction(async (t) => {
      await clientPackage.update({ soldPrice: price, discountType: null, discountValue: null }, { transaction: t });
      const [count] = await db.Retainer.update(
        { amount: price },
        { where: { clientPackageId: clientPackage.id, status: { [Op.ne]: 'cancelled' } }, transaction: t }
      );
      retainerUpdated = count > 0;
    });
    return { clientPackage, retainerUpdated };
  }
}

module.exports = new ClientService();
