const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const tenancy = require('../middleware/tenancy');
const rbac = require('../middleware/rbac');
const ActivityLogController = require('../controllers/ActivityLogController');

// Audit trail — admin-only, mirroring /analytics and /documents.
router.use(auth, tenancy, rbac('admin.access'));

router.get('/', (req, res, next) => ActivityLogController.list(req, res, next));
router.get('/resources', (req, res, next) => ActivityLogController.resources(req, res, next));

module.exports = router;
