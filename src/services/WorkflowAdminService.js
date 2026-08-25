const { v4: uuidv4 } = require('uuid');
const db = require('../models');
const { LETTERHEAD_DEFAULTS } = require('./letterhead');
const { DEFAULT_PAYMENT_THANKYOU_SUBJECT, DEFAULT_PAYMENT_THANKYOU_BODY } = require('./EmailService');

class WorkflowAdminService {
  async listTemplates(orgId, { includeInactive = false } = {}) {
    return db.WorkflowTemplate.findAll({
      where: { orgId, ...(includeInactive ? {} : { isActive: true }) },
      include: [
        { model: db.Stage, as: 'stages', separate: true, order: [['orderIndex', 'ASC']] },
        { model: db.Transition, as: 'transitions', separate: true },
      ],
      order: [['name', 'ASC']],
    });
  }

  async getTemplate(id, orgId) {
    const template = await db.WorkflowTemplate.findOne({
      where: { id, orgId },
      include: [
        { model: db.Stage, as: 'stages', separate: true, order: [['orderIndex', 'ASC']] },
        { model: db.Transition, as: 'transitions', separate: true },
        { model: db.SlaPolicy, as: 'slaPolicies', separate: true },
      ],
    });
    if (!template) {
      const err = new Error('Template not found.');
      err.status = 404;
      throw err;
    }
    return template;
  }

  async createTemplate(orgId, data) {
    return db.WorkflowTemplate.create({
      id: uuidv4(),
      orgId,
      serviceTypeKey: data.serviceTypeKey,
      name: data.name,
      version: data.version || 1,
      isActive: true,
      isRecurring: data.isRecurring || false,
    });
  }

  async updateTemplate(id, orgId, data) {
    const template = await db.WorkflowTemplate.findOne({ where: { id, orgId } });
    if (!template) {
      const err = new Error('Template not found.');
      err.status = 404;
      throw err;
    }
    await template.update({
      name: data.name ?? template.name,
      isActive: data.isActive ?? template.isActive,
      isRecurring: data.isRecurring ?? template.isRecurring,
    });
    return template;
  }

  // Deactivates rather than destroys — see services/SoftDeleteService.js. The
  // stages/transitions stay attached, so any project still running on this
  // template keeps working; it just can't be picked for new ones.
  async deleteTemplate(id, orgId, active = false) {
    const template = await db.WorkflowTemplate.findOne({ where: { id, orgId } });
    if (!template) {
      const err = new Error('Template not found.');
      err.status = 404;
      throw err;
    }
    await template.update({ isActive: active });
    return template;
  }

  async upsertStages(templateId, orgId, stages) {
    const template = await db.WorkflowTemplate.findOne({ where: { id: templateId, orgId } });
    if (!template) {
      const err = new Error('Template not found.');
      err.status = 404;
      throw err;
    }

    return db.sequelize.transaction(async (t) => {
      await db.Stage.destroy({ where: { templateId }, transaction: t });
      const rows = stages.map((s, i) => ({
        id: uuidv4(),
        templateId,
        key: s.key,
        name: s.name,
        orderIndex: i,
        ownerRoleSlot: s.ownerRoleSlot,
        stageType: s.stageType || 'work',
        requiresArtifact: s.requiresArtifact || false,
        isTerminal: s.isTerminal || false,
        advanceRule: s.advanceRule || 'manual',
        taskType: s.taskType,
        approvalGranularity: s.approvalGranularity,
        description: s.description,
      }));
      return db.Stage.bulkCreate(rows, { transaction: t });
    });
  }

  async upsertTransitions(templateId, orgId, transitions) {
    const template = await db.WorkflowTemplate.findOne({ where: { id: templateId, orgId } });
    if (!template) {
      const err = new Error('Template not found.');
      err.status = 404;
      throw err;
    }

    return db.sequelize.transaction(async (t) => {
      await db.Transition.destroy({ where: { templateId }, transaction: t });
      const rows = transitions.map((tr) => ({
        id: uuidv4(),
        templateId,
        fromStageKey: tr.fromStageKey,
        action: tr.action,
        reasonCategory: tr.reasonCategory || null,
        toStageKey: tr.toStageKey,
      }));
      return db.Transition.bulkCreate(rows, { transaction: t });
    });
  }

  async listServiceTypes(orgId, { includeInactive = false } = {}) {
    return db.ServiceType.findAll({
      where: { orgId, ...(includeInactive ? {} : { isActive: true }) },
      order: [['name', 'ASC']],
    });
  }

  async createServiceType(orgId, data) {
    return db.ServiceType.create({
      id: uuidv4(),
      orgId,
      key: data.key,
      name: data.name,
      icon: data.icon,
      isActive: true,
    });
  }

  async updateServiceType(id, orgId, data) {
    const svc = await db.ServiceType.findOne({ where: { id, orgId } });
    if (!svc) {
      const err = new Error('Service type not found.');
      err.status = 404;
      throw err;
    }
    await svc.update(data);
    return svc;
  }

  // Deactivates rather than destroys — see services/SoftDeleteService.js. Projects
  // reference the service by key, so the row has to stay resolvable; it just stops
  // being offered when creating new work.
  async deleteServiceType(id, orgId, active = false) {
    const svc = await db.ServiceType.findOne({ where: { id, orgId } });
    if (!svc) {
      const err = new Error('Service type not found.');
      err.status = 404;
      throw err;
    }
    await svc.update({ isActive: active });
    return svc;
  }

  async updatePackageServices(id, orgId, services) {
    const pkg = await db.Package.findOne({ where: { id, orgId } });
    if (!pkg) {
      const err = new Error('Package not found.');
      err.status = 404;
      throw err;
    }
    await pkg.update({ services: Array.isArray(services) ? services : [] });
    return pkg;
  }

  // Deactivates rather than destroys — see services/SoftDeleteService.js. Sold
  // packages, retainers and invoices all resolve their name/price through this
  // row, so it stays; it simply stops being sellable.
  async deletePackage(id, orgId, active = false) {
    const pkg = await db.Package.findOne({ where: { id, orgId } });
    if (!pkg) {
      const err = new Error('Package not found.');
      err.status = 404;
      throw err;
    }
    await pkg.update({ isActive: active });
    return pkg;
  }

  async getBranding(orgId) {
    const config = await db.WhiteLabelConfig.findOne({ where: { orgId } });
    // Surface the letterhead defaults the PDF renderers would use, so the
    // Branding form shows what documents will actually print rather than blank
    // fields that silently resolve to something else at render time.
    return {
      ...(config ? config.toJSON() : { orgId }),
      letterheadDefaults: LETTERHEAD_DEFAULTS,
      // Shown as placeholder text in the admin editor when the org hasn't
      // written its own subject/body yet, so the form displays exactly what
      // will actually be sent rather than a blank box.
      paymentThankYouDefaults: {
        subject: DEFAULT_PAYMENT_THANKYOU_SUBJECT,
        body: DEFAULT_PAYMENT_THANKYOU_BODY,
      },
    };
  }

  async updateBranding(orgId, data) {
    const [config] = await db.WhiteLabelConfig.upsert({
      orgId,
      brandName: data.brandName,
      logoUrl: data.logoUrl,
      primaryColor: data.primaryColor,
      customDomain: data.customDomain,
      emailFrom: data.emailFrom,
      businessAddress: data.businessAddress,
      businessPhone: data.businessPhone,
      website: data.website,
      taxNumber: data.taxNumber,
      invoiceNotes: data.invoiceNotes,
      invoiceTerms: data.invoiceTerms,
      // Letterhead block — printed at the top of every generated document.
      legalName: data.legalName,
      usOfficeAddress: data.usOfficeAddress,
      pkOfficeAddress: data.pkOfficeAddress,
      einNumber: data.einNumber,
      contactEmail: data.contactEmail,
      letterheadNote: data.letterheadNote,
      seoReportLetterheadFields: data.seoReportLetterheadFields,
      paymentThankYouSubject: data.paymentThankYouSubject,
      paymentThankYouBody: data.paymentThankYouBody,
    });
    return config;
  }
}

module.exports = new WorkflowAdminService();
