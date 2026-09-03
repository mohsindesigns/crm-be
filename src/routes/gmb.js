const express = require('express');
const multer = require('multer');
const router = express.Router();
const auth = require('../middleware/auth');
const tenancy = require('../middleware/tenancy');
const rbac = require('../middleware/rbac');
const GmbService = require('../services/GmbService');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.use(auth, tenancy);

// ─── Profile ──────────────────────────────────────────────────────────────────
router.get('/projects/:projectId/profile', rbac('projects.read'), async (req, res, next) => {
  try {
    res.json(await GmbService.getProfile(req.params.projectId, req.orgId));
  } catch (e) { next(e); }
});

router.put('/projects/:projectId/profile', rbac('projects.act'), async (req, res, next) => {
  try {
    res.json(await GmbService.upsertProfile(req.params.projectId, req.orgId, req.body));
  } catch (e) { next(e); }
});

// ─── Phone numbers ────────────────────────────────────────────────────────────
router.post('/profile/:profileId/phones', rbac('projects.act'), async (req, res, next) => {
  try {
    res.status(201).json(await GmbService.addPhone(req.params.profileId, req.orgId, req.body.phoneNumber));
  } catch (e) { next(e); }
});

router.patch('/phones/:id', rbac('projects.act'), async (req, res, next) => {
  try {
    res.json(await GmbService.updatePhone(req.params.id, req.orgId, req.body.phoneNumber));
  } catch (e) { next(e); }
});

router.delete('/phones/:id', rbac('projects.act'), async (req, res, next) => {
  try {
    res.json(await GmbService.deletePhone(req.params.id, req.orgId));
  } catch (e) { next(e); }
});

router.post('/phones/:id/primary', rbac('projects.act'), async (req, res, next) => {
  try {
    res.json(await GmbService.setPrimaryPhone(req.params.id, req.orgId));
  } catch (e) { next(e); }
});

// ─── Addresses ────────────────────────────────────────────────────────────────
router.post('/profile/:profileId/addresses', rbac('projects.act'), async (req, res, next) => {
  try {
    res.status(201).json(await GmbService.addAddress(req.params.profileId, req.orgId, req.body.address));
  } catch (e) { next(e); }
});

router.patch('/addresses/:id', rbac('projects.act'), async (req, res, next) => {
  try {
    res.json(await GmbService.updateAddress(req.params.id, req.orgId, req.body.address));
  } catch (e) { next(e); }
});

router.delete('/addresses/:id', rbac('projects.act'), async (req, res, next) => {
  try {
    res.json(await GmbService.deleteAddress(req.params.id, req.orgId));
  } catch (e) { next(e); }
});

router.post('/addresses/:id/primary', rbac('projects.act'), async (req, res, next) => {
  try {
    res.json(await GmbService.setPrimaryAddress(req.params.id, req.orgId));
  } catch (e) { next(e); }
});

// ─── Keyword ranking (history + CSV import/export) ────────────────────────────
router.post('/profile/:profileId/keyword-ranks', rbac('projects.act'), async (req, res, next) => {
  try {
    res.status(201).json(await GmbService.addKeywordRank(req.params.profileId, req.orgId, req.body));
  } catch (e) { next(e); }
});

router.delete('/keyword-ranks/:id', rbac('projects.act'), async (req, res, next) => {
  try {
    res.json(await GmbService.deleteKeywordRank(req.params.id, req.orgId));
  } catch (e) { next(e); }
});

router.get('/projects/:projectId/keywords/csv', rbac('projects.read'), async (req, res, next) => {
  try {
    const { csv, project } = await GmbService.exportKeywordsCsv(req.params.projectId, req.orgId);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="gmb-keywords-${project.id}.csv"`);
    res.send(csv);
  } catch (e) { next(e); }
});

router.post('/projects/:projectId/keywords/import', rbac('projects.act'), upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) throw Object.assign(new Error('No file uploaded.'), { status: 400 });
    res.status(201).json(await GmbService.importKeywordsCsv(req.params.projectId, req.orgId, req.file.buffer));
  } catch (e) { next(e); }
});

module.exports = router;
