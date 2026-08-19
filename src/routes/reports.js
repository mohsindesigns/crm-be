const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const tenancy = require('../middleware/tenancy');
const rbac = require('../middleware/rbac');
const ReportsController = require('../controllers/ReportsController');

router.use(auth, tenancy, rbac('reports.read'));

router.get('/members', (req, res, next) => ReportsController.members(req, res, next));
router.get('/members/:id', (req, res, next) => ReportsController.memberDetail(req, res, next));

module.exports = router;
