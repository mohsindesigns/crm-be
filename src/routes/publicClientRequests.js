const express = require('express');
const router = express.Router();
const ClientRequestService = require('../services/ClientRequestService');
const CaptchaService = require('../services/CaptchaService');

// Fully public — no auth/tenancy/rbac. The token in the URL is the only
// credential, same pattern as routes/publicLeadForms.js and
// routes/publicDocuments.js. Every response here must stay scoped to exactly
// what the client holding the link is allowed to see.

router.get('/:token', async (req, res, next) => {
  try { res.json(await ClientRequestService.getPublicByToken(req.params.token)); }
  catch (e) { next(e); }
});

router.get('/:token/captcha', (req, res) => {
  res.json(CaptchaService.generate());
});

router.post('/:token/submit', async (req, res, next) => {
  try { res.status(201).json(await ClientRequestService.submitPublic(req.params.token, req.body, req)); }
  catch (e) { next(e); }
});

module.exports = router;
