const express = require('express');
const router = express.Router({ mergeParams: true });
const ClientRequestController = require('../controllers/ClientRequestController');
const auth = require('../middleware/auth');
const tenancy = require('../middleware/tenancy');
const rbac = require('../middleware/rbac');

router.use(auth, tenancy);

// Mounted at /api/projects/:projectId/client-requests.
// Sending a requirements form is an action taken on a project, so it gates on
// projects.act — the same permission project stage actions use, which the
// Project Manager and specialist roles already hold.
router.get('/', rbac('projects.read'), (req, res, next) => ClientRequestController.list(req, res, next));
router.get('/recipients', rbac('projects.read'), (req, res, next) => ClientRequestController.recipients(req, res, next));
router.get('/:requestId', rbac('projects.read'), (req, res, next) => ClientRequestController.get(req, res, next));
router.post('/', rbac('projects.act'), (req, res, next) => ClientRequestController.send(req, res, next));
router.post('/:requestId/remind', rbac('projects.act'), (req, res, next) => ClientRequestController.remind(req, res, next));
router.post('/:requestId/cancel', rbac('projects.act'), (req, res, next) => ClientRequestController.cancel(req, res, next));

module.exports = router;
