const ApprovalService = require('../services/ApprovalService');

/**
 * Thin as every controller here: parse the query, call the service, shape the
 * response. All authorization lives in ApprovalService (per-source `canView`)
 * and, for decisions, in the owning service it delegates to.
 */
class ApprovalController {
  /** GET /api/approvals?status=pending|approved|rejected&type=&q= */
  async list(req, res, next) {
    try {
      const items = await ApprovalService.list(req.orgId, req.user, {
        status: String(req.query.status || 'pending'),
        type: req.query.type ? String(req.query.type) : null,
        q: req.query.q ? String(req.query.q) : '',
      });
      res.json(items);
    } catch (err) { next(err); }
  }

  /**
   * GET /api/approvals/summary — tab totals, per-type totals and the type
   * registry in one call, so the page (and the sidebar badge) needs a single
   * lightweight poll rather than three list requests.
   */
  async summary(req, res, next) {
    try {
      const ctx = await ApprovalService.buildContext(req.orgId, req.user);
      const { totals, byType } = await ApprovalService.counts(req.orgId, req.user);
      res.json({ totals, byType, types: ApprovalService.types(ctx) });
    } catch (err) { next(err); }
  }

  /** POST /api/approvals/:type/:id/decide  { decision: 'approve'|'reject', reason } */
  async decide(req, res, next) {
    try {
      const result = await ApprovalService.decide(
        req.orgId, req.user, req.params.type, req.params.id,
        { decision: req.body?.decision, reason: req.body?.reason },
      );
      res.json(result);
    } catch (err) { next(err); }
  }
}

module.exports = new ApprovalController();
