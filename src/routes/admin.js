const express = require('express');
const router = express.Router();
const AdminController = require('../controllers/AdminController');
const auth = require('../middleware/auth');
const tenancy = require('../middleware/tenancy');
const adminOnly = require('../middleware/adminOnly');
const rbac = require('../middleware/rbac');

router.use(auth, tenancy, rbac('admin.access'));

// Workflow templates
router.get('/templates', (req, res, next) => AdminController.listTemplates(req, res, next));
router.get('/templates/:id', (req, res, next) => AdminController.getTemplate(req, res, next));
router.post('/templates', (req, res, next) => AdminController.createTemplate(req, res, next));
router.patch('/templates/:id', (req, res, next) => AdminController.updateTemplate(req, res, next));
router.delete('/templates/:id', adminOnly, (req, res, next) => AdminController.deleteTemplate(req, res, next));
router.post('/templates/:id/activate', adminOnly, (req, res, next) => AdminController.activateTemplate(req, res, next));
router.put('/templates/:id/stages', (req, res, next) => AdminController.upsertStages(req, res, next));
router.put('/templates/:id/transitions', (req, res, next) => AdminController.upsertTransitions(req, res, next));

// Service types
router.get('/service-types', (req, res, next) => AdminController.listServiceTypes(req, res, next));
router.post('/service-types', (req, res, next) => AdminController.createServiceType(req, res, next));
router.patch('/service-types/:id', (req, res, next) => AdminController.updateServiceType(req, res, next));
router.delete('/service-types/:id', adminOnly, (req, res, next) => AdminController.deleteServiceType(req, res, next));
router.post('/service-types/:id/activate', adminOnly, (req, res, next) => AdminController.activateServiceType(req, res, next));

// Packages
router.get('/packages', (req, res, next) => AdminController.listPackages(req, res, next));
router.post('/packages', (req, res, next) => AdminController.createPackage(req, res, next));
router.patch('/packages/:id', (req, res, next) => AdminController.updatePackage(req, res, next));
router.put('/packages/:id/services', (req, res, next) => AdminController.updatePackageServices(req, res, next));
router.delete('/packages/:id', adminOnly, (req, res, next) => AdminController.deletePackage(req, res, next));
router.post('/packages/:id/activate', adminOnly, (req, res, next) => AdminController.activatePackage(req, res, next));

// Branding
router.get('/branding', (req, res, next) => AdminController.getBranding(req, res, next));
router.put('/branding', (req, res, next) => AdminController.updateBranding(req, res, next));

// Companies (legal entities behind the letterhead). Creating or retiring an
// entity, and deciding which documents carry which entity's details, is a
// super-admin decision — hence adminOnly on the mutating routes.
router.get('/companies', (req, res, next) => AdminController.listCompanies(req, res, next));
router.get('/companies/resolution', (req, res, next) => AdminController.companyResolution(req, res, next));
router.post('/companies', adminOnly, (req, res, next) => AdminController.createCompany(req, res, next));
router.patch('/companies/:id', adminOnly, (req, res, next) => AdminController.updateCompany(req, res, next));
router.patch('/companies/:id/categories', adminOnly, (req, res, next) => AdminController.setCompanyCategories(req, res, next));
router.post('/companies/:id/primary', adminOnly, (req, res, next) => AdminController.setPrimaryCompany(req, res, next));
router.post('/companies/:id/activate', adminOnly, (req, res, next) => AdminController.activateCompany(req, res, next));
router.delete('/companies/:id', adminOnly, (req, res, next) => AdminController.deactivateCompany(req, res, next));

// Payment methods offered to clients in the portal
router.get('/payment-methods', (req, res, next) => AdminController.listPaymentMethods(req, res, next));
router.get('/payment-methods/stripe-status', (req, res, next) => AdminController.stripeStatus(req, res, next));
router.put('/payment-settings', adminOnly, (req, res, next) => AdminController.saveStripeSettings(req, res, next));
// One-shot catch-up that rewrites every open invoice, so it's adminOnly like the
// setting it backfills — a custom role with billing rights shouldn't be able to
// change the payment terms on invoices clients are already holding links to.
router.post('/payment-settings/apply-partial-payment', adminOnly, (req, res, next) => AdminController.applyPartialPaymentToOpenInvoices(req, res, next));

// Per-currency card processing fees, charged to the client
router.post('/payment-fees', adminOnly, (req, res, next) => AdminController.createFeeRule(req, res, next));
router.patch('/payment-fees/:id', adminOnly, (req, res, next) => AdminController.updateFeeRule(req, res, next));
router.delete('/payment-fees/:id', adminOnly, (req, res, next) => AdminController.deleteFeeRule(req, res, next));
router.post('/payment-methods', adminOnly, (req, res, next) => AdminController.createPaymentMethod(req, res, next));
router.patch('/payment-methods/:id', adminOnly, (req, res, next) => AdminController.updatePaymentMethod(req, res, next));
router.put('/payment-methods/reorder', adminOnly, (req, res, next) => AdminController.reorderPaymentMethods(req, res, next));
router.delete('/payment-methods/:id', adminOnly, (req, res, next) => AdminController.deactivatePaymentMethod(req, res, next));

// Document templates (Quotes & Agreements module)
router.get('/document-templates', (req, res, next) => AdminController.listDocumentTemplates(req, res, next));
router.post('/document-templates', (req, res, next) => AdminController.createDocumentTemplate(req, res, next));
router.patch('/document-templates/:id', (req, res, next) => AdminController.updateDocumentTemplate(req, res, next));
router.delete('/document-templates/:id', adminOnly, (req, res, next) => AdminController.deleteDocumentTemplate(req, res, next));
router.post('/document-templates/:id/activate', adminOnly, (req, res, next) => AdminController.activateDocumentTemplate(req, res, next));

module.exports = router;
