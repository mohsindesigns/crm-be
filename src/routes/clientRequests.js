const express = require('express');
const router = express.Router({ mergeParams: true });
const ClientRequestController = require('../controllers/ClientRequestController');
const auth = require('../middleware/auth');
const tenancy = require('../middleware/tenancy');
const rbac = require('../middleware/rbac');
const adminOnly = require('../middleware/adminOnly');

router.use(auth, tenancy);

// Mounted at /api/projects/:projectId/client-requests.
// Sending a requirements form is an action taken on a project, so it gates on
// projects.act — the same permission project stage actions use, which the
// Project Manager and specialist roles already hold.
router.get('/', rbac('projects.read'), (req, res, next) => ClientRequestController.list(req, res, next));
router.get('/recipients', rbac('projects.read'), (req, res, next) => ClientRequestController.recipients(req, res, next));
router.get('/:requestId', rbac('projects.read'), (req, res, next) => ClientRequestController.get(req, res, next));
router.post('/', rbac('projects.act'), (req, res, next) => ClientRequestController.send(req, res, next));
// Approve/reject are the admin approval gate: a form composed by non-admin
// staff sits at `pending_approval` until one of these runs, and approve is the
// only thing that emails the client. adminOnly (not a permission key) because
// "admin approval" must not be grantable through a custom role's permission
// map — same reasoning as the destructive actions it normally guards. rbac is
// chained purely for consistency with the rest of this router; super_admin and
// admin bypass it anyway, so adminOnly is what actually decides here.
const approvalGate = adminOnly.withMessage(
  'Only an administrator can approve or reject a client requirements form. Yours has been queued for one of them to review.',
);
router.post('/:requestId/approve', approvalGate, rbac('projects.read'), (req, res, next) => ClientRequestController.approve(req, res, next));
router.post('/:requestId/reject', approvalGate, rbac('projects.read'), (req, res, next) => ClientRequestController.reject(req, res, next));
router.post('/:requestId/remind', rbac('projects.act'), (req, res, next) => ClientRequestController.remind(req, res, next));
router.post('/:requestId/cancel', rbac('projects.act'), (req, res, next) => ClientRequestController.cancel(req, res, next));

module.exports = router;
