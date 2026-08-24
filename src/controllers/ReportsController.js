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

  async keywords(req, res, next) {
    try {
      const {
        projectId, strategistId, volumeMin, volumeMax, difficultyMin, difficultyMax,
        status, search, sortBy, sortDir, page, limit,
      } = req.query;
      res.json(await ReportsService.getKeywordReport(req.orgId, {
        projectId, strategistId, volumeMin, volumeMax, difficultyMin, difficultyMax,
        status, search, sortBy, sortDir, page, limit,
      }));
    } catch (err) {
      next(err);
    }
  }

  async keywordSummary(req, res, next) {
    try {
      const { projectId, strategistId, page, limit } = req.query;
      res.json(await ReportsService.getKeywordSummary(req.orgId, {
        projectId, strategistId, page, limit,
      }));
    } catch (err) {
      next(err);
    }
  }

  async exportKeywords(req, res, next) {
    try {
      const format = req.query.format || 'csv';
      const { ids, filters, fields } = req.body;
      const { buffer, ext, mime } = await ReportsService.exportKeywords(req.orgId, format, ids, filters, fields);
      res.setHeader('Content-Type', mime);
      res.setHeader('Content-Disposition', `attachment; filename="keyword-report.${ext}"`);
      res.send(buffer);
    } catch (err) {
      next(err);
    }
  }

  async exportKeywordSummary(req, res, next) {
    try {
      const format = req.query.format || 'csv';
      const { ids, filters, fields } = req.body;
      const { buffer, ext, mime } = await ReportsService.exportKeywordSummary(req.orgId, format, ids, filters, fields);
      res.setHeader('Content-Type', mime);
      res.setHeader('Content-Disposition', `attachment; filename="keyword-summary.${ext}"`);
      res.send(buffer);
    } catch (err) {
      next(err);
    }
  }
}

module.exports = new ReportsController();
