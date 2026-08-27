const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const tenancy = require('../middleware/tenancy');
const rbac = require('../middleware/rbac');
const adminOnly = require('../middleware/adminOnly');
const LeadService = require('../services/LeadService');
const { setActive } = require('../services/SoftDeleteService');
const db = require('../models');

router.use(auth, tenancy);

router.get('/', rbac('leads.read'), async (req, res, next) => {
  try { res.json(await LeadService.list(req.orgId, req.query)); }
  catch (e) { next(e); }
});

router.get('/:id', rbac('leads.read'), async (req, res, next) => {
  try { res.json(await LeadService.findById(req.params.id, req.orgId)); }
  catch (e) { next(e); }
});

router.patch('/:id/status', rbac('leads.act'), async (req, res, next) => {
  try { res.json(await LeadService.updateStatus(req.params.id, req.orgId, req.body.status, req.user, req.body.note)); }
  catch (e) { next(e); }
});

router.patch('/:id/assign', rbac('leads.act'), async (req, res, next) => {
  try { res.json(await LeadService.assign(req.params.id, req.orgId, req.body.userId || null, req.user)); }
  catch (e) { next(e); }
});

router.post('/:id/convert', rbac('leads.act'), async (req, res, next) => {
  try { res.json(await LeadService.convertToClient(req.params.id, req.orgId, req.user, req.body)); }
  catch (e) { next(e); }
});

// Deactivates (spam/junk), never destroys — same policy as everything else.
router.delete('/:id', adminOnly, rbac('leads.act'), async (req, res, next) => {
  try {
    const lead = await setActive(db.Lead, { id: req.params.id, orgId: req.orgId }, false, 'Lead not found.');
    res.json({ message: 'Lead set to Inactive', lead });
  } catch (e) { next(e); }
});

module.exports = router;
