const WorkflowAdminService = require('../services/WorkflowAdminService');
const { isTruthy } = require('../services/SoftDeleteService');
const DocumentTemplateService = require('../services/DocumentTemplateService');
const CompanyService = require('../services/CompanyService');
const BillingSettingsService = require('../services/BillingSettingsService');

class AdminController {
  async listTemplates(req, res, next) {
    try { res.json(await WorkflowAdminService.listTemplates(req.orgId, { includeInactive: isTruthy(req.query.includeInactive) })); }
    catch (err) { next(err); }
  }

  async getTemplate(req, res, next) {
    try { res.json(await WorkflowAdminService.getTemplate(req.params.id, req.orgId)); }
    catch (err) { next(err); }
  }

  async createTemplate(req, res, next) {
    try {
      const t = await WorkflowAdminService.createTemplate(req.orgId, req.body);
      res.status(201).json(t);
    } catch (err) { next(err); }
  }

  async updateTemplate(req, res, next) {
    try { res.json(await WorkflowAdminService.updateTemplate(req.params.id, req.orgId, req.body)); }
    catch (err) { next(err); }
  }

  // Deactivates, never destroys — see services/SoftDeleteService.js.
  async deleteTemplate(req, res, next) {
    try {
      const template = await WorkflowAdminService.deleteTemplate(req.params.id, req.orgId, false);
      res.json({ message: 'Workflow template set to Inactive.', template });
    } catch (err) { next(err); }
  }

  async activateTemplate(req, res, next) {
    try {
      const template = await WorkflowAdminService.deleteTemplate(req.params.id, req.orgId, true);
      res.json({ message: 'Workflow template set to Active.', template });
    } catch (err) { next(err); }
  }

  async upsertStages(req, res, next) {
    try { res.json(await WorkflowAdminService.upsertStages(req.params.id, req.orgId, req.body.stages)); }
    catch (err) { next(err); }
  }

  async upsertTransitions(req, res, next) {
    try { res.json(await WorkflowAdminService.upsertTransitions(req.params.id, req.orgId, req.body.transitions)); }
    catch (err) { next(err); }
  }

  async listServiceTypes(req, res, next) {
    try { res.json(await WorkflowAdminService.listServiceTypes(req.orgId, { includeInactive: isTruthy(req.query.includeInactive) })); }
    catch (err) { next(err); }
  }

  async createServiceType(req, res, next) {
    try {
      const svc = await WorkflowAdminService.createServiceType(req.orgId, req.body);
      res.status(201).json(svc);
    } catch (err) { next(err); }
  }

  async updateServiceType(req, res, next) {
    try { res.json(await WorkflowAdminService.updateServiceType(req.params.id, req.orgId, req.body)); }
    catch (err) { next(err); }
  }

  async deleteServiceType(req, res, next) {
    try {
      const serviceType = await WorkflowAdminService.deleteServiceType(req.params.id, req.orgId, false);
      res.json({ message: 'Service type set to Inactive.', serviceType });
    } catch (err) { next(err); }
  }

  async activateServiceType(req, res, next) {
    try {
      const serviceType = await WorkflowAdminService.deleteServiceType(req.params.id, req.orgId, true);
      res.json({ message: 'Service type set to Active.', serviceType });
    } catch (err) { next(err); }
  }

  async listPackages(req, res, next) {
    try {
      const { Package } = require('../models');
      // `services` (which service types + workflow templates this package bundles)
      // is a plain JSON column on Package itself — see WorkflowAdminService#
      // updatePackageServices — so no include/join is needed to get it back.
      const packages = await Package.findAll({
        where: {
          orgId: req.orgId,
          // Deactivated packages are hidden unless explicitly asked for.
          ...(isTruthy(req.query.includeInactive) ? {} : { isActive: true }),
        },
        order: [['name', 'ASC']],
      });
      res.json(packages);
    } catch (err) { next(err); }
  }

  async createPackage(req, res, next) {
    try {
      const { Package } = require('../models');
      const pkg = await Package.create({ ...req.body, orgId: req.orgId });
      res.status(201).json(pkg);
    } catch (err) { next(err); }
  }

  async updatePackage(req, res, next) {
    try {
      const { Package } = require('../models');
      const pkg = await Package.findOne({ where: { id: req.params.id, orgId: req.orgId } });
      if (!pkg) return res.status(404).json({ message: 'Package not found' });
      await pkg.update(req.body);
      res.json(pkg);
    } catch (err) { next(err); }
  }

  async updatePackageServices(req, res, next) {
    try { res.json(await WorkflowAdminService.updatePackageServices(req.params.id, req.orgId, req.body.services)); }
    catch (err) { next(err); }
  }

  async deletePackage(req, res, next) {
    try {
      const pkg = await WorkflowAdminService.deletePackage(req.params.id, req.orgId, false);
      res.json({ message: 'Package set to Inactive.', package: pkg });
    } catch (err) { next(err); }
  }

  async activatePackage(req, res, next) {
    try {
      const pkg = await WorkflowAdminService.deletePackage(req.params.id, req.orgId, true);
      res.json({ message: 'Package set to Active.', package: pkg });
    } catch (err) { next(err); }
  }

  async getBranding(req, res, next) {
    try { res.json(await WorkflowAdminService.getBranding(req.orgId)); }
    catch (err) { next(err); }
  }

  async updateBranding(req, res, next) {
    try { res.json(await WorkflowAdminService.updateBranding(req.orgId, req.body)); }
    catch (err) { next(err); }
  }

  // Document templates (Quotes & Agreements module)
  async listDocumentTemplates(req, res, next) {
    try { res.json(await DocumentTemplateService.list(req.orgId, req.query)); }
    catch (err) { next(err); }
  }

  async createDocumentTemplate(req, res, next) {
    try {
      const template = await DocumentTemplateService.create(req.orgId, req.body);
      res.status(201).json(template);
    } catch (err) { next(err); }
  }

  async updateDocumentTemplate(req, res, next) {
    try { res.json(await DocumentTemplateService.update(req.params.id, req.orgId, req.body)); }
    catch (err) { next(err); }
  }

  async deleteDocumentTemplate(req, res, next) {
    try {
      const template = await DocumentTemplateService.remove(req.params.id, req.orgId, false);
      res.json({ message: 'Document template set to Inactive.', template });
    } catch (err) { next(err); }
  }

  async activateDocumentTemplate(req, res, next) {
    try {
      const template = await DocumentTemplateService.remove(req.params.id, req.orgId, true);
      res.json({ message: 'Document template set to Active.', template });
    } catch (err) { next(err); }
  }

  // ─── Companies (legal entities) ─────────────────────────────────────────────

  async listCompanies(req, res, next) {
    try {
      res.json(await CompanyService.list(req.orgId, {
        includeInactive: isTruthy(req.query.includeInactive),
      }));
    } catch (err) { next(err); }
  }

  async companyResolution(req, res, next) {
    try { res.json(await CompanyService.resolution(req.orgId)); }
    catch (err) { next(err); }
  }

  async createCompany(req, res, next) {
    try { res.status(201).json(await CompanyService.create(req.orgId, req.body)); }
    catch (err) { next(err); }
  }

  async updateCompany(req, res, next) {
    try { res.json(await CompanyService.update(req.params.id, req.orgId, req.body)); }
    catch (err) { next(err); }
  }

  async setCompanyCategories(req, res, next) {
    try { res.json(await CompanyService.setCategories(req.params.id, req.orgId, req.body)); }
    catch (err) { next(err); }
  }

  async setPrimaryCompany(req, res, next) {
    try { res.json(await CompanyService.setPrimary(req.params.id, req.orgId)); }
    catch (err) { next(err); }
  }

  async activateCompany(req, res, next) {
    try {
      const company = await CompanyService.activate(req.params.id, req.orgId);
      res.json({ message: 'Company set to Active.', company });
    } catch (err) { next(err); }
  }

  async deactivateCompany(req, res, next) {
    try {
      const company = await CompanyService.deactivate(req.params.id, req.orgId);
      res.json({ message: 'Company set to Inactive.', company });
    } catch (err) { next(err); }
  }

  // ─── Payment methods ────────────────────────────────────────────────────────

  async listPaymentMethods(req, res, next) {
    try { res.json(await BillingSettingsService.list(req.orgId)); }
    catch (err) { next(err); }
  }

  async stripeStatus(req, res, next) {
    try { res.json(await BillingSettingsService.stripeStatus(req.orgId)); }
    catch (err) { next(err); }
  }

  async saveStripeSettings(req, res, next) {
    try { res.json(await BillingSettingsService.saveStripeSettings(req.orgId, req.body)); }
    catch (err) { next(err); }
  }

  async applyPartialPaymentToOpenInvoices(req, res, next) {
    try {
      res.json(await BillingSettingsService.applyPartialPaymentToOpenInvoices(
        req.orgId,
        req.body?.allowPartialPayment,
      ));
    } catch (err) { next(err); }
  }

  async createFeeRule(req, res, next) {
    try { res.status(201).json(await BillingSettingsService.createFeeRule(req.orgId, req.body)); }
    catch (err) { next(err); }
  }

  async updateFeeRule(req, res, next) {
    try { res.json(await BillingSettingsService.updateFeeRule(req.params.id, req.orgId, req.body)); }
    catch (err) { next(err); }
  }

  async deleteFeeRule(req, res, next) {
    try { res.json(await BillingSettingsService.deleteFeeRule(req.params.id, req.orgId)); }
    catch (err) { next(err); }
  }

  async createPaymentMethod(req, res, next) {
    try { res.status(201).json(await BillingSettingsService.create(req.orgId, req.body)); }
    catch (err) { next(err); }
  }

  async updatePaymentMethod(req, res, next) {
    try { res.json(await BillingSettingsService.update(req.params.id, req.orgId, req.body)); }
    catch (err) { next(err); }
  }

  async reorderPaymentMethods(req, res, next) {
    try { res.json(await BillingSettingsService.reorder(req.orgId, req.body.ids)); }
    catch (err) { next(err); }
  }

  async deactivatePaymentMethod(req, res, next) {
    try {
      const method = await BillingSettingsService.deactivate(req.params.id, req.orgId);
      res.json({ message: 'Payment method set to Inactive.', method });
    } catch (err) { next(err); }
  }
}

module.exports = new AdminController();
