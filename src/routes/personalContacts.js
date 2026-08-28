const express = require('express');
const router = express.Router();
const PersonalContactController = require('../controllers/PersonalContactController');
const auth = require('../middleware/auth');
const tenancy = require('../middleware/tenancy');
const rbac = require('../middleware/rbac');

router.use(auth, tenancy);

router.get('/', rbac('personalInvoices.read'), (req, res, next) => PersonalContactController.list(req, res, next));
router.post('/', rbac('personalInvoices.create'), (req, res, next) => PersonalContactController.create(req, res, next));
router.patch('/:id', rbac('personalInvoices.update'), (req, res, next) => PersonalContactController.update(req, res, next));
router.post('/:id/deactivate', rbac('personalInvoices.update'), (req, res, next) => PersonalContactController.deactivate(req, res, next));
router.post('/:id/reactivate', rbac('personalInvoices.update'), (req, res, next) => PersonalContactController.reactivate(req, res, next));

module.exports = router;
