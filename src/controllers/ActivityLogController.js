const ActivityLogService = require('../services/ActivityLogService');

class ActivityLogController {
  async list(req, res, next) {
    try {
      const { page, limit, actorUserId, resource, action, search, from, to } = req.query;
      res.json(await ActivityLogService.list(req.orgId, { page, limit, actorUserId, resource, action, search, from, to }));
    } catch (err) {
      next(err);
    }
  }

  async resources(req, res, next) {
    try {
      res.json(await ActivityLogService.listResources(req.orgId));
    } catch (err) {
      next(err);
    }
  }
}

module.exports = new ActivityLogController();
