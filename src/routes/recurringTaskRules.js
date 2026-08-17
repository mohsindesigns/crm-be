const express = require('express');
const router = express.Router({ mergeParams: true });
const RecurringTaskRuleController = require('../controllers/RecurringTaskRuleController');
const auth = require('../middleware/auth');
const tenancy = require('../middleware/tenancy');
const adminOnly = require('../middleware/adminOnly');
const rbac = require('../middleware/rbac');

router.use(auth, tenancy);

// Mounted at /projects/:projectId/recurring-task-rules
router.get('/', (req, res, next) => RecurringTaskRuleController.list(req, res, next));
router.post('/', rbac('projects.act'), (req, res, next) => RecurringTaskRuleController.create(req, res, next));
router.patch('/:ruleId', rbac('projects.act'), (req, res, next) => RecurringTaskRuleController.update(req, res, next));
router.delete('/:ruleId', adminOnly, rbac('projects.act'), (req, res, next) => RecurringTaskRuleController.remove(req, res, next));

module.exports = router;
