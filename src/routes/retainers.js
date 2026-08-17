const express = require('express');
const router = express.Router();
const { Retainer, Client, Package, Project, ClientPackage } = require('../models');
const auth = require('../middleware/auth');
const tenancy = require('../middleware/tenancy');
const adminOnly = require('../middleware/adminOnly');
const rbac = require('../middleware/rbac');
const RetainerService = require('../services/RetainerService');
const { isTruthy } = require('../services/SoftDeleteService');

router.use(auth, tenancy);

router.get('/', rbac('billing.read'), async (req, res, next) => {
  try {
    const retainers = await Retainer.findAll({
      where: { orgId: req.orgId, ...(isTruthy(req.query.includeInactive) ? {} : { isActive: true }) },
      include: [
        { model: Client, as: 'client', attributes: ['id', 'name'] },
        { model: Package, as: 'package', attributes: ['id', 'name'], required: false },
        {
          model: ClientPackage, as: 'clientPackage', required: false,
          include: [{ model: Package, as: 'package', attributes: ['id', 'name'], required: false }],
        },
      ],
      order: [['createdAt', 'DESC']],
    });
    res.json(retainers);
  } catch (e) { next(e); }
});

// Groups active retainer value by service + currency — never sums across
// currencies (this codebase has no conversion logic; currency is free-text
// copied per-row). Service is resolved: clientPackageId -> ClientPackage.packageId
// -> Package.services[*].serviceTypeKey (joined, e.g. "seo+gmb", when the package
// bundles more than one — most sold packages do, so dumping those into a single
// opaque "other" bucket hid where most of the revenue actually came from); else
// projectId -> Project.serviceTypeKey; else genuinely unattributable (no
// package/project link at all, e.g. a manually created retainer) -> 'other'.
router.get('/summary', rbac('billing.read'), async (req, res, next) => {
  try {
    const active = await Retainer.findAll({
      where: { orgId: req.orgId, status: 'active', isActive: true },
      include: [
        { model: Package, as: 'package', attributes: ['serviceTypeKey', 'services'], required: false },
        {
          model: ClientPackage, as: 'clientPackage', required: false,
          include: [{ model: Package, as: 'package', attributes: ['serviceTypeKey', 'services'], required: false }],
        },
        { model: Project, as: 'project', attributes: ['serviceTypeKey'], required: false },
      ],
    });

    const buckets = new Map(); // `${serviceTypeKey}|${currency}` -> total
    const grand = new Map();   // currency -> total

    for (const r of active) {
      let serviceTypeKey = 'other';
      // Prefer the direct packageId association; fall back to clientPackage->package
      // for legacy rows created before Retainer.packageId was populated on sale.
      const pkg = r.package || r.clientPackage?.package;
      if (pkg) {
        const bundled = Array.isArray(pkg.services) ? pkg.services : [];
        const keys = [...new Set(bundled.map((s) => s.serviceTypeKey).filter(Boolean))];
        if (keys.length === 1) serviceTypeKey = keys[0];
        else if (keys.length > 1) serviceTypeKey = keys.sort().join('+');
        else if (pkg.serviceTypeKey) serviceTypeKey = pkg.serviceTypeKey;
      } else if (r.project?.serviceTypeKey) {
        serviceTypeKey = r.project.serviceTypeKey;
      }
      const currency = r.currency || 'USD';
      const amount = parseFloat(r.amount) || 0;

      const key = `${serviceTypeKey}|${currency}`;
      buckets.set(key, (buckets.get(key) || 0) + amount);
      grand.set(currency, (grand.get(currency) || 0) + amount);
    }

    const byService = Array.from(buckets.entries()).map(([key, total]) => {
      const [serviceTypeKey, currency] = key.split('|');
      return { serviceTypeKey, currency, total: Math.round(total * 100) / 100 };
    });
    const grandTotal = Array.from(grand.entries()).map(([currency, total]) => ({ currency, total: Math.round(total * 100) / 100 }));

    res.json({ byService, grandTotal });
  } catch (e) { next(e); }
});

// Auto-creates a retainer for a recurring project and immediately invoices the
// first cycle — used by the project creation form so recurring engagements don't
// need a separate manual "create a retainer" step.
router.post('/auto-create', rbac('projects.create'), async (req, res, next) => {
  try {
    const { projectId, amount, cycle, currency, startDate } = req.body;
    if (!projectId) return res.status(400).json({ message: 'projectId is required.' });
    const project = await Project.findOne({
      where: { id: projectId, orgId: req.orgId },
      include: [
        {
          model: ClientPackage, as: 'clientPackage', required: false,
          attributes: ['id', 'packageId', 'soldPrice', 'currency', 'billingCycle'],
        },
      ],
    });
    if (!project) return res.status(404).json({ message: 'Project not found.' });

    const clientPackage = project.clientPackage || null;
    const packageId = project.packageId || clientPackage?.packageId || null;
    const clientPackageId = project.clientPackageId || clientPackage?.id || null;
    const resolvedAmount = amount != null && amount !== ''
      ? Number(amount)
      : (clientPackage ? Number(clientPackage.soldPrice) : NaN);
    if (!Number.isFinite(resolvedAmount) || resolvedAmount < 0) {
      return res.status(400).json({ message: 'amount is required (or the project must be linked to a sold package with a price).' });
    }

    const retainer = await RetainerService.autoCreate({
      orgId: req.orgId,
      clientId: project.clientId,
      projectId: project.id,
      clientPackageId,
      packageId,
      amount: resolvedAmount,
      currency: currency || clientPackage?.currency || undefined,
      cycle: cycle || clientPackage?.billingCycle || undefined,
      startDate: startDate || project.startDate,
      note: `Retainer for project: ${project.name}`,
    });
    res.status(201).json(retainer);
  } catch (e) { next(e); }
});

router.post('/', rbac('billing.manage'), async (req, res, next) => {
  try {
    const retainer = await Retainer.create({ ...req.body, orgId: req.orgId });
    res.status(201).json(retainer);
  } catch (e) { next(e); }
});

router.get('/:id', rbac('billing.read'), async (req, res, next) => {
  try {
    const retainer = await Retainer.findOne({
      where: { id: req.params.id, orgId: req.orgId },
      include: [
        { model: Client, as: 'client', attributes: ['id', 'name'] },
        { model: Package, as: 'package', attributes: ['id', 'name'] },
      ],
    });
    if (!retainer) return res.status(404).json({ message: 'Retainer not found.' });
    res.json(retainer);
  } catch (e) { next(e); }
});

router.patch('/:id', rbac('billing.manage'), async (req, res, next) => {
  try {
    const retainer = await Retainer.findOne({ where: { id: req.params.id, orgId: req.orgId } });
    if (!retainer) return res.status(404).json({ message: 'Retainer not found.' });
    await retainer.update(req.body);
    res.json(retainer);
  } catch (e) { next(e); }
});

// Deactivates, never destroys — see services/SoftDeleteService.js. The retainer's
// past invoices keep resolving against it; the scheduler skips inactive rows.
router.delete('/:id', adminOnly, rbac('billing.manage'), async (req, res, next) => {
  try {
    const retainer = await Retainer.findOne({ where: { id: req.params.id, orgId: req.orgId } });
    if (!retainer) return res.status(404).json({ message: 'Retainer not found.' });
    await retainer.update({ isActive: false });
    res.json({ message: 'Retainer set to Inactive.', retainer });
  } catch (e) { next(e); }
});

router.post('/:id/activate', adminOnly, rbac('billing.manage'), async (req, res, next) => {
  try {
    const retainer = await Retainer.findOne({ where: { id: req.params.id, orgId: req.orgId } });
    if (!retainer) return res.status(404).json({ message: 'Retainer not found.' });
    await retainer.update({ isActive: true });
    res.json({ message: 'Retainer set to Active.', retainer });
  } catch (e) { next(e); }
});

module.exports = router;
