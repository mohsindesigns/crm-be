const express = require('express');

const router = express.Router();
const ApprovalController = require('../controllers/ApprovalController');
const auth = require('../middleware/auth');
const tenancy = require('../middleware/tenancy');

router.use(auth, tenancy);

// Mounted at /api/approvals.
//
// No `rbac(...)` gate on this router, on purpose. The approval inbox is a
// cross-cutting queue: which of the nine sources a caller sees is decided
// per-source by `canView` inside ApprovalService (projects.read for task/SEO
// queues, hr.read — or simply owning a Worker row — for HR ones, and so on).
// A single router-level permission would either lock out the employee whose own
// leave request is the only thing they can see here, or hand a permission key
// more reach than it has anywhere else in the app.
router.get('/', (req, res, next) => ApprovalController.list(req, res, next));
router.get('/summary', (req, res, next) => ApprovalController.summary(req, res, next));
router.post('/:type/:id/decide', (req, res, next) => ApprovalController.decide(req, res, next));

module.exports = router;
