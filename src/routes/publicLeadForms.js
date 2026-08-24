const express = require('express');
const multer = require('multer');
const os = require('os');
const fs = require('fs');
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

const upload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (req, file, cb) => cb(null, `upload-${Date.now()}-${Math.random().toString(36).slice(2)}`),
  }),
  limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE_MB || '50', 10) * 1024 * 1024 },
});

router.get('/:token', async (req, res, next) => {
  try { res.json(await LeadFormService.getPublicByToken(req.params.token)); }
  catch (e) { next(e); }
});

// POST /:token/upload — attachment for a `file`-type question, uploaded ahead
// of submit (the visitor picks a file, sees it attach, then submits the whole
// form) rather than bundled into /:token/submit, which stays JSON-only.
router.post('/:token/upload', upload.single('file'), async (req, res, next) => {
  const tmpPath = req.file?.path;
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded. Use multipart field "file".' });
    const result = await LeadService.uploadPublicFile(req.params.token, tmpPath, req.file.originalname, req.file.mimetype, req);
    fs.unlink(tmpPath, () => {});
    res.status(201).json(result);
  } catch (e) {
    if (tmpPath) fs.unlink(tmpPath, () => {});
    next(e);
  }
});

router.post('/:token/submit', async (req, res, next) => {
  try { res.status(201).json(await LeadService.submitPublic(req.params.token, req.body, req)); }
  catch (e) { next(e); }
});

module.exports = router;
