const express = require('express');
const router = express.Router();
const ClientRequestService = require('../services/ClientRequestService');

// Fully public — no auth/tenancy/rbac. The token in the URL is the only
// credential, same pattern as routes/publicLeadForms.js and
// routes/publicDocuments.js. Every response here must stay scoped to exactly
// what the client holding the link is allowed to see.
// Bot protection is Cloudflare Turnstile (verified in
// ClientRequestService#submitPublic via CaptchaService) — the widget is
// client-side only, so there's no server-issued challenge to fetch first.

router.get('/:token', async (req, res, next) => {
  try { res.json(await ClientRequestService.getPublicByToken(req.params.token)); }
  catch (e) { next(e); }
});

router.post('/:token/submit', async (req, res, next) => {
  try { res.status(201).json(await ClientRequestService.submitPublic(req.params.token, req.body, req)); }
  catch (e) { next(e); }
});

module.exports = router;
