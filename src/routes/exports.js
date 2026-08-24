const express = require('express');
const router = express.Router();
const ExportController = require('../controllers/ExportController');
const auth = require('../middleware/auth');
const tenancy = require('../middleware/tenancy');
const rbac = require('../middleware/rbac');
const adminOnly = require('../middleware/adminOnly');

// Admin → Export Data. `admin.access` gates the whole module because it lives
// inside the admin panel; the employee routes additionally require `hr.read`
// because the columns on offer include salary, CNIC and bank accounts — a
// custom role needs BOTH keys to pull that sheet. super_admin/admin bypass
// rbac entirely, same as everywhere else (see middleware/rbac.js).
router.use(auth, tenancy, rbac('admin.access'));

// ─── Employees dataset ────────────────────────────────────────────────────────
router.get('/employees/schema', rbac('hr.read'), (req, res, next) => ExportController.employeeSchema(req, res, next));
router.get('/employees/filters', rbac('hr.read'), (req, res, next) => ExportController.employeeFilters(req, res, next));
router.get('/employees', rbac('hr.read'), (req, res, next) => ExportController.listEmployees(req, res, next));
// POST so the run is recorded by middleware/activityLogger — an export of
// everyone's bank details should be visible in the Activity Log.
router.post('/employees/csv', rbac('hr.read'), (req, res, next) => ExportController.exportEmployees(req, res, next));

// ─── Saved column templates ───────────────────────────────────────────────────
router.get('/templates', (req, res, next) => ExportController.listTemplates(req, res, next));
router.post('/templates', (req, res, next) => ExportController.createTemplate(req, res, next));
router.patch('/templates/:id', (req, res, next) => ExportController.updateTemplate(req, res, next));
// Deactivates, never destroys — see services/SoftDeleteService.js.
router.delete('/templates/:id', adminOnly, (req, res, next) => ExportController.removeTemplate(req, res, next));
router.post('/templates/:id/activate', adminOnly, (req, res, next) => ExportController.activateTemplate(req, res, next));

module.exports = router;
