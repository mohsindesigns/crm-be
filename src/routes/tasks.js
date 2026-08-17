const express = require('express');
const router = express.Router({ mergeParams: true });
const TaskController = require('../controllers/TaskController');
const auth = require('../middleware/auth');
const tenancy = require('../middleware/tenancy');
const rbac = require('../middleware/rbac');

router.use(auth, tenancy);

// Mounted at /projects/:projectId/tasks
// listForProject calls ProjectService.findById which enforces assignment-based access
router.get('/', (req, res, next) => TaskController.listForProject(req, res, next));
router.post('/', rbac('projects.act'), (req, res, next) => TaskController.create(req, res, next));
// Task detail (with event/timestamp history) — for the Task Detail modal
router.get('/:taskId', (req, res, next) => TaskController.getById(req, res, next));
// Any project member can transition their assigned tasks
router.patch('/:taskId/status', (req, res, next) => TaskController.transition(req, res, next));

module.exports = router;
