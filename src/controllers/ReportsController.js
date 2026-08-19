const ReportsService = require('../services/ReportsService');

class ReportsController {
  async members(req, res, next) {
    try {
      const { from, to, search, roleId } = req.query;
      res.json(await ReportsService.getMembersOverview(req.orgId, { from, to, search, roleId }));
    } catch (err) {
      next(err);
    }
  }

  async memberDetail(req, res, next) {
    try {
      const { from, to } = req.query;
      const detail = await ReportsService.getMemberDetail(req.orgId, req.params.id, { from, to });
      if (!detail) return res.status(404).json({ message: 'Member not found.' });
      res.json(detail);
    } catch (err) {
      next(err);
    }
  }
}

module.exports = new ReportsController();
