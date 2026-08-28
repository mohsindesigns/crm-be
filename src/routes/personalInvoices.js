const express = require('express');
const router = express.Router();
const PersonalInvoiceController = require('../controllers/PersonalInvoiceController');
const auth = require('../middleware/auth');
const tenancy = require('../middleware/tenancy');
const rbac = require('../middleware/rbac');

router.use(auth, tenancy);

// Same payment-method list the official invoice form uses — same Stripe
// account, so no separate configuration exists to read this from.
router.get('/payment-methods', rbac('personalInvoices.read'), async (req, res, next) => {
  try {
    const db = require('../models');
    const methods = await db.PaymentMethod.findAll({
      where: { orgId: req.orgId, isActive: true },
      attributes: ['id', 'kind', 'provider', 'label'],
      order: [['sortOrder', 'ASC'], ['createdAt', 'ASC']],
    });
    res.json(methods);
  } catch (e) { next(e); }
});

// Legal entities available for the "which letterhead prints on this" dropdown
// — every active Company, not just the ones ticked for official billing, since
// a personal invoice's issuer is always a manual choice, never auto-detected.
router.get('/companies', rbac('personalInvoices.read'), async (req, res, next) => {
  try {
    const db = require('../models');
    const companies = await db.Company.findAll({
      where: { orgId: req.orgId, isActive: true },
      attributes: ['id', 'legalName', 'code'],
      order: [['isPrimary', 'DESC'], ['sortOrder', 'ASC'], ['createdAt', 'ASC']],
    });
    res.json(companies);
  } catch (e) { next(e); }
});

router.get('/', rbac('personalInvoices.read'), (req, res, next) => PersonalInvoiceController.list(req, res, next));
router.post('/', rbac('personalInvoices.create'), (req, res, next) => PersonalInvoiceController.create(req, res, next));
router.post('/bulk-void', rbac('personalInvoices.update'), (req, res, next) => PersonalInvoiceController.bulkVoid(req, res, next));
router.get('/:id', rbac('personalInvoices.read'), (req, res, next) => PersonalInvoiceController.getOne(req, res, next));
router.patch('/:id/status', rbac('personalInvoices.update'), (req, res, next) => PersonalInvoiceController.updateStatus(req, res, next));
router.patch('/:id/payment-config', rbac('personalInvoices.update'), (req, res, next) => PersonalInvoiceController.configurePayment(req, res, next));
router.post('/:id/payments', rbac('personalInvoices.update'), (req, res, next) => PersonalInvoiceController.recordPayment(req, res, next));
router.get('/:id/pdf', rbac('personalInvoices.read'), (req, res, next) => PersonalInvoiceController.pdf(req, res, next));
router.post('/:id/sync-stripe', rbac('personalInvoices.update'), (req, res, next) => PersonalInvoiceController.syncStripe(req, res, next));

module.exports = router;
