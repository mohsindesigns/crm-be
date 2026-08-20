const express = require('express');
const router = express.Router();
const LeadFormService = require('../services/LeadFormService');
const LeadService = require('../services/LeadService');

// Fully public — no auth/tenancy/rbac. The token in the URL is the only
// credential, same pattern as routes/publicDocuments.js. Reachable from any
// third-party origin the form is embedded on, so every response here must
// stay scoped to exactly what an anonymous visitor is allowed to see.
// Bot protection is Cloudflare Turnstile (verified in LeadService#submitPublic
// via CaptchaService) — the widget is client-side only, so there's no
// server-issued challenge to fetch first.

router.get('/:token', async (req, res, next) => {
  try { res.json(await LeadFormService.getPublicByToken(req.params.token)); }
  catch (e) { next(e); }
});

router.post('/:token/submit', async (req, res, next) => {
  try { res.status(201).json(await LeadService.submitPublic(req.params.token, req.body, req)); }
  catch (e) { next(e); }
});

module.exports = router;
