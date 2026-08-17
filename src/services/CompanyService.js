const { v4: uuidv4 } = require('uuid');
const { Op } = require('sequelize');
const db = require('../models');

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function notFound() {
  const err = new Error('Company not found.');
  err.status = 404;
  return err;
}

/** 'Mohsin Designs LLC' → 'MDL'. Initials first, padded from the name if short. */
function suggestCode(legalName) {
  const words = String(legalName || '').toUpperCase().replace(/[^A-Z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const initials = words.map((w) => w[0]).join('');
  if (initials.length >= 2) return initials.slice(0, 6);
  const flat = String(legalName || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return (flat.slice(0, 3) || 'CO');
}

class CompanyService {
  async list(orgId, { includeInactive = false } = {}) {
    const where = { orgId };
    if (!includeInactive) where.isActive = true;
    return db.Company.findAll({
      where,
      order: [['isPrimary', 'DESC'], ['sortOrder', 'ASC'], ['createdAt', 'ASC']],
    });
  }

  async findById(id, orgId) {
    const company = await db.Company.findOne({ where: { id, orgId } });
    if (!company) throw notFound();
    return company;
  }

  async _sanitize(orgId, data, { existingId = null } = {}) {
    const out = {};
    const str = (v, max) => (v == null ? null : String(v).trim().slice(0, max) || null);

    if (data.legalName !== undefined) {
      const name = String(data.legalName || '').trim();
      if (!name) throw badRequest('Legal name is required.');
      out.legalName = name.slice(0, 150);
    }

    if (data.code !== undefined || (data.legalName !== undefined && !existingId)) {
      const raw = data.code != null && String(data.code).trim()
        ? String(data.code)
        : suggestCode(data.legalName || out.legalName);
      const code = raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
      if (!code) throw badRequest('Company code must contain at least one letter or digit.');

      // Codes are baked into issued document numbers, so two companies sharing
      // one would make MDL-INV-26-0007 ambiguous about who issued it.
      const clash = await db.Company.findOne({
        where: { orgId, code, ...(existingId ? { id: { [Op.ne]: existingId } } : {}) },
        attributes: ['id'],
      });
      if (clash) throw badRequest(`Company code "${code}" is already used by another company.`);
      out.code = code;
    }

    if (data.officeLabel !== undefined) out.officeLabel = str(data.officeLabel, 60) || 'Office';
    if (data.address !== undefined) out.address = data.address || null;
    if (data.taxLabel !== undefined) out.taxLabel = str(data.taxLabel, 30) || 'EIN';
    if (data.taxNumber !== undefined) out.taxNumber = str(data.taxNumber, 60);
    if (data.email !== undefined) out.email = str(data.email, 255);
    if (data.phone !== undefined) out.phone = str(data.phone, 50);
    if (data.website !== undefined) out.website = str(data.website, 255);
    if (data.logoUrl !== undefined) out.logoUrl = data.logoUrl || null;
    if (data.signatureUrl !== undefined) out.signatureUrl = data.signatureUrl || null;
    if (data.stampUrl !== undefined) out.stampUrl = data.stampUrl || null;
    if (data.letterheadNote !== undefined) out.letterheadNote = data.letterheadNote || null;
    if (data.invoiceNotes !== undefined) out.invoiceNotes = data.invoiceNotes || null;
    if (data.invoiceTerms !== undefined) out.invoiceTerms = data.invoiceTerms || null;
    if (data.defaultCurrency !== undefined) {
      out.defaultCurrency = (str(data.defaultCurrency, 10) || 'USD').toUpperCase();
    }
    if (data.useForHrDocuments !== undefined) out.useForHrDocuments = !!data.useForHrDocuments;
    if (data.useForBilling !== undefined) out.useForBilling = !!data.useForBilling;
    if (data.sortOrder !== undefined) out.sortOrder = parseInt(data.sortOrder, 10) || 0;
    if (data.isActive !== undefined) out.isActive = !!data.isActive;

    return out;
  }

  async create(orgId, data) {
    const payload = await this._sanitize(orgId, data);
    if (!payload.legalName) throw badRequest('Legal name is required.');

    const count = await db.Company.count({ where: { orgId } });
    const company = await db.Company.create({
      id: uuidv4(),
      orgId,
      ...payload,
      // The first company an org creates is automatically primary — otherwise
      // document numbering would have no prefix to draw on.
      isPrimary: count === 0 ? true : !!data.isPrimary,
      sortOrder: payload.sortOrder ?? count,
    });

    if (data.isPrimary && count > 0) await this.setPrimary(company.id, orgId);
    return company;
  }

  async update(id, orgId, data) {
    const company = await this.findById(id, orgId);
    const payload = await this._sanitize(orgId, data, { existingId: id });
    await company.update(payload);
    if (data.isPrimary) await this.setPrimary(id, orgId);
    await this._ensurePrimaryExists(orgId);
    return this.findById(id, orgId);
  }

  /** Exactly one primary per org — set here, cleared everywhere else. */
  async setPrimary(id, orgId) {
    await this.findById(id, orgId);
    await db.Company.update({ isPrimary: false }, { where: { orgId } });
    await db.Company.update({ isPrimary: true }, { where: { id, orgId } });
    return this.findById(id, orgId);
  }

  /**
   * Deactivating (or unticking) the primary would leave numbering with no
   * prefix, so promote the next usable company rather than allowing that state.
   */
  async _ensurePrimaryExists(orgId) {
    const primary = await db.Company.findOne({ where: { orgId, isPrimary: true, isActive: true } });
    if (primary) return;
    const fallback = await db.Company.findOne({
      where: { orgId, isActive: true },
      order: [['sortOrder', 'ASC'], ['createdAt', 'ASC']],
    });
    if (fallback) {
      await db.Company.update({ isPrimary: false }, { where: { orgId } });
      await fallback.update({ isPrimary: true });
    }
  }

  /**
   * Deactivate, never delete. Documents already issued reference this entity by
   * their number prefix and printed letterhead; removing the row would orphan
   * that history.
   */
  async deactivate(id, orgId) {
    const company = await this.findById(id, orgId);
    const activeCount = await db.Company.count({ where: { orgId, isActive: true } });
    if (activeCount <= 1) {
      throw badRequest('At least one active company is required — documents need a letterhead.');
    }
    await company.update({ isActive: false, isPrimary: false });
    await this._ensurePrimaryExists(orgId);
    return company;
  }

  async activate(id, orgId) {
    const company = await this.findById(id, orgId);
    await company.update({ isActive: true });
    await this._ensurePrimaryExists(orgId);
    return company;
  }

  /**
   * Toggle a document-category checkbox.
   *
   * Unticking the last company for a category is allowed on purpose — that state
   * falls back to the legacy WhiteLabelConfig letterhead rather than producing a
   * document with no company details at all. The admin UI warns when it happens.
   */
  async setCategories(id, orgId, { useForBilling, useForHrDocuments }) {
    const company = await this.findById(id, orgId);
    const patch = {};
    if (useForBilling !== undefined) patch.useForBilling = !!useForBilling;
    if (useForHrDocuments !== undefined) patch.useForHrDocuments = !!useForHrDocuments;
    await company.update(patch);
    return company;
  }

  /**
   * What will actually print, per category — powers the "Preview" summary in
   * Admin → Companies so an admin can see the effect of the checkboxes without
   * generating a document.
   */
  async resolution(orgId) {
    const [billing, hr] = await Promise.all([
      db.Company.forCategory(orgId, 'billing'),
      db.Company.forCategory(orgId, 'hr'),
    ]);
    const shape = (rows) => rows.map((c) => ({
      id: c.id, legalName: c.legalName, code: c.code, officeLabel: c.officeLabel, isPrimary: c.isPrimary,
    }));
    return {
      billing: shape(billing),
      hr: shape(hr),
      billingFallsBackToBranding: billing.length === 0,
      hrFallsBackToBranding: hr.length === 0,
      numberingCompany: billing[0]
        ? { code: billing[0].code, legalName: billing[0].legalName }
        : null,
    };
  }
}

module.exports = new CompanyService();
module.exports.suggestCode = suggestCode;
