const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const tenancy = require('../middleware/tenancy');
const rbac = require('../middleware/rbac');
const GmbService = require('../services/GmbService');

router.use(auth, tenancy);

router.get('/projects/:projectId/profile', rbac('projects.read'), async (req, res, next) => {
  try {
    res.json(await GmbService.getProfile(req.params.projectId, req.orgId));
  } catch (e) { next(e); }
});

// mode: 'draft' (default, relaxed validation) | 'complete' (full validation, marks status: completed).
router.put('/projects/:projectId/profile', rbac('projects.act'), async (req, res, next) => {
  try {
    const { mode, ...data } = req.body;
    res.json(await GmbService.saveProfile(req.params.projectId, req.orgId, data, { mode, userId: req.user.id }));
  } catch (e) { next(e); }
});

router.get('/suggestions', rbac('projects.read'), async (req, res, next) => {
  try {
    res.json(await GmbService.getSuggestions(req.orgId));
  } catch (e) { next(e); }
});

module.exports = router;
