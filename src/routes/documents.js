const express = require('express');
const router = express.Router();
const DocumentController = require('../controllers/DocumentController');
const auth = require('../middleware/auth');
const tenancy = require('../middleware/tenancy');
const adminOnly = require('../middleware/adminOnly');
const rbac = require('../middleware/rbac');

// Quotes & Agreements module — admin and super_admin only, per spec.
router.use(auth, tenancy, rbac('admin.access'));

router.get('/', (req, res, next) => DocumentController.list(req, res, next));
router.post('/preview', (req, res, next) => DocumentController.preview(req, res, next));
router.get('/:id', (req, res, next) => DocumentController.getById(req, res, next));
router.post('/', (req, res, next) => DocumentController.create(req, res, next));
router.patch('/:id', (req, res, next) => DocumentController.update(req, res, next));
// Deactivates, never destroys — see services/SoftDeleteService.js.
router.delete('/:id', adminOnly, (req, res, next) => DocumentController.remove(req, res, next));
router.post('/:id/activate', adminOnly, (req, res, next) => DocumentController.activate(req, res, next));
router.post('/:id/send', (req, res, next) => DocumentController.send(req, res, next));
router.post('/:id/remind', (req, res, next) => DocumentController.remind(req, res, next));
router.post('/:id/convert', (req, res, next) => DocumentController.convert(req, res, next));
router.get('/:id/pdf', (req, res, next) => DocumentController.pdf(req, res, next));

module.exports = router;
