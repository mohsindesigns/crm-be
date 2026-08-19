const express = require('express');
const router = express.Router();
const portalAuth = require('../middleware/portalAuth');
const LeadService = require('../services/LeadService');

// Read-only from the portal, deliberately: a client can see every lead their
// own forms brought in, but status changes, assignment, and conversion stay
// staff-only actions (assignment targets internal Users a client shouldn't
// see; qualification is the agency's call to make on the client's behalf).
router.use(portalAuth);

router.get('/', async (req, res, next) => {
  try { res.json(await LeadService.list(req.orgId, req.query, req.portalClientId)); }
  catch (e) { next(e); }
});

router.get('/:id', async (req, res, next) => {
  try { res.json(await LeadService.findById(req.params.id, req.orgId, req.portalClientId)); }
  catch (e) { next(e); }
});

module.exports = router;
