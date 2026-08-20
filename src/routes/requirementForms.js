const express = require('express');
const router = express.Router();
const RequirementFormController = require('../controllers/RequirementFormController');
const auth = require('../middleware/auth');
const tenancy = require('../middleware/tenancy');
const rbac = require('../middleware/rbac');
const adminOnly = require('../middleware/adminOnly');

router.use(auth, tenancy);

// Reusable requirement-form templates (models/RequirementFormTemplate.js).
// Reads ride on projects.read because the compose screen on a project needs the
// picker; authoring is projects.manage, i.e. the same bar as other org-level
// project configuration. No new permission key — existing roles keep working.
router.get('/', rbac('projects.read'), (req, res, next) => RequirementFormController.list(req, res, next));
router.get('/:id', rbac('projects.read'), (req, res, next) => RequirementFormController.get(req, res, next));
router.post('/', rbac('projects.manage'), (req, res, next) => RequirementFormController.create(req, res, next));
router.put('/:id', rbac('projects.manage'), (req, res, next) => RequirementFormController.update(req, res, next));
// Deactivates, never destroys — see services/SoftDeleteService.js.
router.delete('/:id', adminOnly, (req, res, next) => RequirementFormController.remove(req, res, next));
router.post('/:id/activate', adminOnly, (req, res, next) => RequirementFormController.activate(req, res, next));

module.exports = router;
