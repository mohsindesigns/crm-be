const express = require('express');
const router = express.Router();
const ClientController = require('../controllers/ClientController');
const auth = require('../middleware/auth');
const tenancy = require('../middleware/tenancy');
const adminOnly = require('../middleware/adminOnly');
const rbac = require('../middleware/rbac');
const validate = require('../middleware/validate');

router.use(auth, tenancy);

router.get('/', rbac('clients.read'), (req, res, next) => ClientController.list(req, res, next));
router.get('/:id', rbac('clients.read'), (req, res, next) => ClientController.getOne(req, res, next));
router.post('/', rbac('clients.create'), ClientController.createValidators(), validate, (req, res, next) => ClientController.create(req, res, next));
router.patch('/:id', rbac('clients.update'), (req, res, next) => ClientController.update(req, res, next));
// DELETE deactivates, never destroys — see services/SoftDeleteService.js.
router.delete('/:id', adminOnly, rbac('clients.update'), (req, res, next) => ClientController.remove(req, res, next));
router.post('/:id/activate', adminOnly, rbac('clients.update'), (req, res, next) => ClientController.activate(req, res, next));

router.post('/:id/contacts', rbac('clients.update'), (req, res, next) => ClientController.addContact(req, res, next));
router.patch('/:id/contacts/:contactId', rbac('clients.update'), (req, res, next) => ClientController.updateContact(req, res, next));
router.delete('/:id/contacts/:contactId', adminOnly, rbac('clients.update'), (req, res, next) => ClientController.removeContact(req, res, next));
router.post('/:id/contacts/:contactId/activate', adminOnly, rbac('clients.update'), (req, res, next) => ClientController.activateContact(req, res, next));

// How this client settles invoices (Stripe card rail vs the manual flow).
// adminOnly on purpose: it changes how money is collected from a real client,
// which isn't something a project-level role should be able to flip.
router.patch('/:id/billing-mode', adminOnly, rbac('clients.update'), (req, res, next) => ClientController.setBillingMode(req, res, next));
// Whether the org's card processing fee (Admin → Payments) is passed on to this
// client's Stripe charges, or absorbed by the agency instead. Same adminOnly
// rule as billing-mode — it's a money decision, not a project-level one.
router.patch('/:id/card-fee', adminOnly, rbac('clients.update'), (req, res, next) => ClientController.setChargeCardFee(req, res, next));

router.get('/:id/packages', rbac('clients.read'), (req, res, next) => ClientController.listSoldPackages(req, res, next));
router.get('/:id/sellable-packages', rbac('projects.create'), (req, res, next) => ClientController.listSellablePackages(req, res, next));
router.post('/:id/sell-package', rbac('projects.create'), (req, res, next) => ClientController.sellPackage(req, res, next));
router.post('/:id/sell-packages', rbac('projects.create'), (req, res, next) => ClientController.sellPackages(req, res, next));
router.post('/:id/packages/:clientPackageId/cancel', rbac('projects.manage'), (req, res, next) => ClientController.cancelClientPackage(req, res, next));
router.patch('/:id/packages/:clientPackageId/price', rbac('projects.manage'), (req, res, next) => ClientController.updateClientPackagePrice(req, res, next));

module.exports = router;
