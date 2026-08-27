const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const tenancy = require('../middleware/tenancy');
const rbac = require('../middleware/rbac');
const adminOnly = require('../middleware/adminOnly');
const LeadFormService = require('../services/LeadFormService');

router.use(auth, tenancy);

router.get('/', rbac('leads.manage'), async (req, res, next) => {
  try { res.json(await LeadFormService.list(req.orgId, req.query)); }
  catch (e) { next(e); }
});

router.post('/', rbac('leads.manage'), async (req, res, next) => {
  try { res.status(201).json(await LeadFormService.create(req.orgId, req.body, { userId: req.user.id })); }
  catch (e) { next(e); }
});

router.get('/:id', rbac('leads.manage'), async (req, res, next) => {
  try { res.json(await LeadFormService.findById(req.params.id, req.orgId)); }
  catch (e) { next(e); }
});

router.patch('/:id', rbac('leads.manage'), async (req, res, next) => {
  try { res.json(await LeadFormService.update(req.params.id, req.orgId, req.body)); }
  catch (e) { next(e); }
});

// Deactivates, never destroys — mirrors every other resource in this app.
router.delete('/:id', adminOnly, rbac('leads.manage'), async (req, res, next) => {
  try {
    const form = await LeadFormService.setFormActive(req.params.id, req.orgId, false);
    res.json({ message: 'Form set to Inactive', form });
  } catch (e) { next(e); }
});

router.post('/:id/activate', adminOnly, rbac('leads.manage'), async (req, res, next) => {
  try {
    const form = await LeadFormService.setFormActive(req.params.id, req.orgId, true);
    res.json({ message: 'Form set to Active', form });
  } catch (e) { next(e); }
});

module.exports = router;
