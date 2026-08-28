const express = require('express');
const router = express.Router();
const ProjectController = require('../controllers/ProjectController');
const auth = require('../middleware/auth');
const tenancy = require('../middleware/tenancy');
const rbac = require('../middleware/rbac');
const validate = require('../middleware/validate');

router.use(auth, tenancy);

// Admins see all; non-admins scoped to assigned projects in service layer
router.get('/', (req, res, next) => ProjectController.list(req, res, next));
// Service layer enforces assignment-based access for non-admins
router.get('/:id', (req, res, next) => ProjectController.getOne(req, res, next));
router.post('/', rbac('projects.create'), ProjectController.createValidators(), validate, (req, res, next) => ProjectController.create(req, res, next));
router.patch('/:id', rbac('projects.update'), (req, res, next) => ProjectController.update(req, res, next));
router.get('/:id/timeline', (req, res, next) => ProjectController.getTimeline(req, res, next));
// projects.act is enough to hit the handler; ProjectController#setAssignment
// still requires projects.manage for most slots, and allows blog_writer for
// admins / PMs / SEO strategists (same people who can schedule blog rules).
router.post('/:id/assign', rbac('projects.act'), (req, res, next) => ProjectController.setAssignment(req, res, next));
// canActOnProject in the workflow engine enforces that only the stage owner can act
router.post('/:id/action', (req, res, next) => ProjectController.action(req, res, next));
router.post('/:id/rewind', rbac('projects.rewind'), (req, res, next) => ProjectController.rewind(req, res, next));
router.post('/:id/cancel', rbac('projects.manage'), (req, res, next) => ProjectController.cancel(req, res, next));
router.patch('/:id/status', rbac('projects.manage'), (req, res, next) => ProjectController.setStatus(req, res, next));

module.exports = router;
