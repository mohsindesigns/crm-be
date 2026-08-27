const express = require('express');
const router = express.Router();
const portalAuth = require('../middleware/portalAuth');
const LeadFormService = require('../services/LeadFormService');

// Every route here is scoped to req.portalClientId (never client-supplied) —
// a portal contact only ever sees/touches lead forms their own client owns.
// No rbac/adminOnly: portal contacts don't carry the staff permission system,
// and a client managing their own form isn't a privileged action the way an
// admin-only deactivate is for staff-owned resources.
router.use(portalAuth);

router.get('/', async (req, res, next) => {
  try { res.json(await LeadFormService.list(req.orgId, req.query, req.portalClientId)); }
  catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    // Portal forms are never project-scoped — a client doesn't have visibility
    // into the agency's internal project list to pick from.
    const payload = { ...req.body, projectId: undefined };
    res.status(201).json(await LeadFormService.create(req.orgId, payload, { contactId: req.portalContact.id, clientId: req.portalClientId }));
  } catch (e) { next(e); }
});

router.get('/:id', async (req, res, next) => {
  try { res.json(await LeadFormService.findById(req.params.id, req.orgId, req.portalClientId)); }
  catch (e) { next(e); }
});

router.patch('/:id', async (req, res, next) => {
  try { res.json(await LeadFormService.update(req.params.id, req.orgId, req.body, req.portalClientId)); }
  catch (e) { next(e); }
});

// Deactivates, never destroys — same policy as everywhere else in this app.
router.delete('/:id', async (req, res, next) => {
  try {
    const form = await LeadFormService.setFormActive(req.params.id, req.orgId, false, req.portalClientId);
    res.json({ message: 'Form set to Inactive', form });
  } catch (e) { next(e); }
});

router.post('/:id/activate', async (req, res, next) => {
  try {
    const form = await LeadFormService.setFormActive(req.params.id, req.orgId, true, req.portalClientId);
    res.json({ message: 'Form set to Active', form });
  } catch (e) { next(e); }
});

module.exports = router;
