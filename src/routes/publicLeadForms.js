const express = require('express');
const router = express.Router();
const LeadFormService = require('../services/LeadFormService');
const LeadService = require('../services/LeadService');
const CaptchaService = require('../services/CaptchaService');

// Fully public — no auth/tenancy/rbac. The token in the URL is the only
// credential, same pattern as routes/publicDocuments.js. Reachable from any
// third-party origin the form is embedded on, so every response here must
// stay scoped to exactly what an anonymous visitor is allowed to see.

router.get('/:token', async (req, res, next) => {
  try { res.json(await LeadFormService.getPublicByToken(req.params.token)); }
  catch (e) { next(e); }
});

router.get('/:token/captcha', (req, res) => {
  res.json(CaptchaService.generate());
});

router.post('/:token/submit', async (req, res, next) => {
  try { res.status(201).json(await LeadService.submitPublic(req.params.token, req.body, req)); }
  catch (e) { next(e); }
});

module.exports = router;
