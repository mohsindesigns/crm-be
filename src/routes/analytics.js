const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const tenancy = require('../middleware/tenancy');
const adminOnly = require('../middleware/adminOnly');
const { isTruthy } = require('../services/SoftDeleteService');
const rbac = require('../middleware/rbac');
const AnalyticsService = require('../services/AnalyticsService');
const SlaService = require('../services/SlaService');
const OverviewService = require('../services/OverviewService');

router.use(auth, tenancy);

// ─── Dashboard (no admin guard — used by all roles) ───────────────────────────

router.get('/dashboard', async (req, res, next) => {
  try { res.json(await AnalyticsService.getDashboardMetrics(req.orgId, req.user)); } catch (e) { next(e); }
});

router.get('/projects-by-stage', async (req, res, next) => {
  try { res.json(await AnalyticsService.getProjectsByStage(req.orgId, req.user)); } catch (e) { next(e); }
});

router.get('/waiting-on-me', async (req, res, next) => {
  try { res.json(await AnalyticsService.getWaitingOnMe(req.orgId, req.user)); } catch (e) { next(e); }
});

router.get('/business-overview', rbac('admin.access'), async (req, res, next) => {
  try { res.json(await AnalyticsService.getBusinessOverview(req.orgId)); } catch (e) { next(e); }
});

// ─── Overview page (admin command centre) ─────────────────────────────────────

// One payload for the whole Overview page — money, delivery, people, pipeline,
// SEO, the approval queue and the recent audit trail. Deliberately a single
// endpoint rather than a dozen: the page is a snapshot of one moment, and
// stitching twelve independently-cached responses together would show sections
// that disagree with each other. See services/OverviewService.js.
router.get('/overview', rbac('admin.access'), async (req, res, next) => {
  try { res.json(await OverviewService.getOverview(req.orgId, req.user)); } catch (e) { next(e); }
});

// Split out because it does network I/O (a ping to the media service) and
// information_schema reads that have nothing to do with the org's data — a slow
// or unreachable media host must not delay the business numbers above.
router.get('/overview/system', rbac('admin.access'), async (req, res, next) => {
  try { res.json(await OverviewService.getSystemHealth(req.orgId)); } catch (e) { next(e); }
});

// ─── Analytics (admin only) ───────────────────────────────────────────────────

router.get('/cycle-time', rbac('admin.access'), async (req, res, next) => {
  try {
    res.json(await AnalyticsService.getCycleTimeByStage(req.orgId, { templateId: req.query.templateId }));
  } catch (e) { next(e); }
});

router.get('/rejection-rate', rbac('admin.access'), async (req, res, next) => {
  try { res.json(await AnalyticsService.getRejectionRateByStage(req.orgId)); } catch (e) { next(e); }
});

router.get('/on-time-delivery', rbac('admin.access'), async (req, res, next) => {
  try { res.json(await AnalyticsService.getOnTimeDelivery(req.orgId)); } catch (e) { next(e); }
});

router.get('/team-utilization', rbac('admin.access'), async (req, res, next) => {
  try { res.json(await AnalyticsService.getTeamUtilization(req.orgId)); } catch (e) { next(e); }
});

router.get('/cycle-time-by-service', rbac('admin.access'), async (req, res, next) => {
  try { res.json(await AnalyticsService.getCycleTimeByService(req.orgId)); } catch (e) { next(e); }
});

// ─── SLA status (admin only) ──────────────────────────────────────────────────

router.get('/sla-status', rbac('admin.access'), async (req, res, next) => {
  try { res.json(await SlaService.getSlaStatus(req.orgId)); } catch (e) { next(e); }
});

// ─── SLA policy CRUD (admin only) ────────────────────────────────────────────

router.get('/sla-policies', rbac('admin.access'), async (req, res, next) => {
  try {
    res.json(await SlaService.getSlaPolicies(req.orgId, { includeInactive: isTruthy(req.query.includeInactive) }));
  } catch (e) { next(e); }
});

router.post('/sla-policies', rbac('admin.access'), async (req, res, next) => {
  try { res.status(201).json(await SlaService.upsertSlaPolicy(req.orgId, req.body)); } catch (e) { next(e); }
});

// Deactivates, never destroys — see services/SoftDeleteService.js.
router.delete('/sla-policies/:id', adminOnly, rbac('admin.access'), async (req, res, next) => {
  try {
    res.json({ message: 'SLA policy set to Inactive.', policy: await SlaService.deleteSlaPolicy(req.params.id, req.orgId, false) });
  } catch (e) { next(e); }
});

router.post('/sla-policies/:id/activate', adminOnly, rbac('admin.access'), async (req, res, next) => {
  try {
    res.json({ message: 'SLA policy set to Active.', policy: await SlaService.deleteSlaPolicy(req.params.id, req.orgId, true) });
  } catch (e) { next(e); }
});

module.exports = router;
