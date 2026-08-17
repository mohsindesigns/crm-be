const express = require('express');
const router = express.Router();
const InvoiceController = require('../controllers/InvoiceController');
const auth = require('../middleware/auth');
const tenancy = require('../middleware/tenancy');
const rbac = require('../middleware/rbac');

router.use(auth, tenancy);

/**
 * The org's configured payment methods, for the "Record payment" form.
 *
 * Exists separately from the admin route because that one is behind
 * `admin.access`, which a billing-only user doesn't have — and the alternative
 * was the hardcoded list this replaces, which showed six options when the org
 * had configured four.
 *
 * Declared before `/:id` so "payment-methods" isn't captured as an invoice id.
 */
router.get('/payment-methods', rbac('billing.read'), async (req, res, next) => {
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

router.get('/', rbac('billing.read'), (req, res, next) => InvoiceController.list(req, res, next));
router.post('/', rbac('billing.create'), (req, res, next) => InvoiceController.create(req, res, next));
router.post('/bulk-void', rbac('billing.update'), (req, res, next) => InvoiceController.bulkVoid(req, res, next));
router.get('/:id', rbac('billing.read'), (req, res, next) => InvoiceController.getOne(req, res, next));
router.patch('/:id/status', rbac('billing.update'), (req, res, next) => InvoiceController.updateStatus(req, res, next));
router.patch('/:id/payment-config', rbac('billing.update'), (req, res, next) => InvoiceController.configurePayment(req, res, next));
router.post('/:id/payments', rbac('billing.update'), (req, res, next) => InvoiceController.recordPayment(req, res, next));
router.get('/:id/pdf', rbac('billing.read'), (req, res, next) => InvoiceController.pdf(req, res, next));
router.post('/:id/remind', rbac('billing.update'), (req, res, next) => InvoiceController.remind(req, res, next));
router.post('/:id/sync-stripe', rbac('billing.update'), (req, res, next) => InvoiceController.syncStripe(req, res, next));

module.exports = router;
