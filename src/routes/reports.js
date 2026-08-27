const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const tenancy = require('../middleware/tenancy');
const rbac = require('../middleware/rbac');
const ReportsController = require('../controllers/ReportsController');

router.use(auth, tenancy, rbac('reports.read'));

router.get('/members', (req, res, next) => ReportsController.members(req, res, next));
router.get('/members/:id', (req, res, next) => ReportsController.memberDetail(req, res, next));
router.get('/keywords', (req, res, next) => ReportsController.keywords(req, res, next));
router.get('/keyword-summary', (req, res, next) => ReportsController.keywordSummary(req, res, next));
router.post('/keywords/export', (req, res, next) => ReportsController.exportKeywords(req, res, next));
router.post('/keyword-summary/export', (req, res, next) => ReportsController.exportKeywordSummary(req, res, next));
router.get('/backlink-summary', (req, res, next) => ReportsController.backlinkSummary(req, res, next));
router.post('/backlink-summary/export', (req, res, next) => ReportsController.exportBacklinkSummary(req, res, next));

module.exports = router;
