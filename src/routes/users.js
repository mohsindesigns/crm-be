const express = require('express');
const router = express.Router();
const UserController = require('../controllers/UserController');
const auth = require('../middleware/auth');
const tenancy = require('../middleware/tenancy');
const adminOnly = require('../middleware/adminOnly');
const rbac = require('../middleware/rbac');
const validate = require('../middleware/validate');

router.use(auth, tenancy);

router.get('/', rbac('users.read'), (req, res, next) => UserController.list(req, res, next));
// Any authenticated org member — no users.read gate — for assignee pickers (id/name/avatar only).
router.get('/assignable', (req, res, next) => UserController.listAssignable(req, res, next));
// Public directory card (Messages header, etc.) — no users.read; strips confidential HR fields.
router.get('/:id/public', (req, res, next) => UserController.getPublicProfile(req, res, next));
router.get('/:id', rbac('users.read'), (req, res, next) => UserController.getOne(req, res, next));
router.post('/', rbac('users.create'), UserController.createValidators(), validate, (req, res, next) => UserController.create(req, res, next));
router.patch('/:id', rbac('users.update'), UserController.updateValidators(), validate, (req, res, next) => UserController.update(req, res, next));
router.post('/:id/change-password', (req, res, next) => UserController.changePassword(req, res, next));
router.post('/:id/reset-password', rbac('users.update'), (req, res, next) => UserController.resetPassword(req, res, next));
// DELETE deactivates, never destroys — see services/SoftDeleteService.js.
router.delete('/:id', adminOnly, rbac('users.update'), (req, res, next) => UserController.remove(req, res, next));
router.post('/:id/activate', adminOnly, rbac('users.update'), (req, res, next) => UserController.activate(req, res, next));

module.exports = router;
