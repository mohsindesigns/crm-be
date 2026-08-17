const RecurringTaskRuleService = require('../services/RecurringTaskRuleService');

class RecurringTaskRuleController {
  async list(req, res, next) {
    try {
      res.json(await RecurringTaskRuleService.list(req.params.projectId, req.orgId));
    } catch (err) { next(err); }
  }

  async create(req, res, next) {
    try {
      const rule = await RecurringTaskRuleService.create(req.params.projectId, req.orgId, req.body, req.user);
      res.status(201).json(rule);
    } catch (err) { next(err); }
  }

  async update(req, res, next) {
    try {
      res.json(await RecurringTaskRuleService.update(req.params.ruleId, req.params.projectId, req.orgId, req.body, req.user));
    } catch (err) { next(err); }
  }

  // Deactivates, never destroys — see services/SoftDeleteService.js.
  async remove(req, res, next) {
    try {
      const rule = await RecurringTaskRuleService.remove(req.params.ruleId, req.params.projectId, req.orgId, req.user);
      res.json({ message: 'Schedule set to Inactive.', rule });
    } catch (err) { next(err); }
  }
}

module.exports = new RecurringTaskRuleController();
