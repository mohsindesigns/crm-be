const express = require('express');
const router = express.Router();
const RoleController = require('../controllers/RoleController');
const auth = require('../middleware/auth');
const tenancy = require('../middleware/tenancy');
const adminOnly = require('../middleware/adminOnly');
const rbac = require('../middleware/rbac');
const validate = require('../middleware/validate');

router.use(auth, tenancy);

router.get('/', rbac('roles.read'), (req, res, next) => RoleController.list(req, res, next));
router.get('/:id', rbac('roles.read'), (req, res, next) => RoleController.getOne(req, res, next));
router.post('/', rbac('roles.create'), RoleController.createValidators(), validate, (req, res, next) => RoleController.create(req, res, next));
router.patch('/:id', rbac('roles.update'), (req, res, next) => RoleController.update(req, res, next));
// DELETE deactivates, never destroys — see services/SoftDeleteService.js.
router.delete('/:id', adminOnly, rbac('roles.delete'), (req, res, next) => RoleController.destroy(req, res, next));
router.post('/:id/activate', adminOnly, rbac('roles.delete'), (req, res, next) => RoleController.activate(req, res, next));

module.exports = router;
