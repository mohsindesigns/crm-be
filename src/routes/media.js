const express = require('express');
const multer = require('multer');
const os = require('os');
const fs = require('fs');
const router = express.Router();
const auth = require('../middleware/auth');
const tenancy = require('../middleware/tenancy');
const adminOnly = require('../middleware/adminOnly');
const { isTruthy } = require('../services/SoftDeleteService');
const db = require('../models');
const { Artifact } = db;
const MediaService = require('../services/MediaService');
const BlogSheetSync = require('../services/BlogSheetSync');

// A deliverable dropped on a blog task should surface in the project's Blogs tab
// straight away — the writer attaching the file and the strategist looking for it
// on the sheet are usually not the same person, and waiting for the submit
// transition made the file look lost in between. Fire-and-forget: a sync failure
// must never fail the upload itself, which has already succeeded by this point.
// See services/BlogSheetSync.js — status is left alone here, only the file moves.
function mirrorToBlogSheet(taskId, kind, actorUserId) {
  if (!taskId || kind === 'brief' || kind === 'review_note') return;
  db.Task.findByPk(taskId)
    .then((task) => (task ? BlogSheetSync.syncFromTask(task, { actorUserId }) : null))
    .catch((err) => console.error('[media] Failed to mirror deliverable to blog sheet:', err.message));
}

const upload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (req, file, cb) => cb(null, `upload-${Date.now()}-${Math.random().toString(36).slice(2)}`),
  }),
  limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE_MB || '50', 10) * 1024 * 1024 },
});

router.use(auth, tenancy);

// POST /api/media/upload
// Accepts multipart/form-data with field "file" + optional body fields: projectId, stageKey, kind
router.post('/upload', upload.single('file'), async (req, res, next) => {
  const tmpPath = req.file?.path;
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded. Use multipart field "file".' });

    const { projectId, taskId, stageKey, kind } = req.body;
    const stream = fs.createReadStream(tmpPath);
    const result = await MediaService.upload(stream, req.file.originalname, req.file.mimetype);
    fs.unlink(tmpPath, () => {});

    let artifact = null;
    let resolvedProjectId = projectId;
    if (taskId && !resolvedProjectId) {
      const task = await db.Task.findByPk(taskId);
      resolvedProjectId = task?.projectId;
    }
    if (resolvedProjectId) {
      artifact = await Artifact.create({
        projectId: resolvedProjectId,
        taskId: taskId || null,
        stageKey: stageKey || 'general',
        fileUrl: result.url,
        fileName: result.originalName,
        fileSize: result.size,
        mimeType: result.mimetype,
        kind: kind || null,
        uploadedBy: req.user.id,
      });
      mirrorToBlogSheet(taskId, kind, req.user.id);
    }

    res.status(201).json({ ...result, artifact });
  } catch (err) {
    if (tmpPath) fs.unlink(tmpPath, () => {});
    next(err);
  }
});

// POST /api/media/upload-multi
// Accepts multipart/form-data with multiple files under field "file" +
// optional body fields: projectId, taskId, stageKey, kind.
// Returns an array of uploads/artifacts.
router.post('/upload-multi', upload.array('file', 20), async (req, res, next) => {
  const tmpPaths = (req.files || []).map((f) => f.path);
  try {
    const files = Array.isArray(req.files) ? req.files : [];
    if (!files.length) return res.status(400).json({ error: 'No files uploaded. Use multipart field "file".' });

    const { projectId, taskId, stageKey, kind } = req.body;

    // Resolve projectId if client supplied only taskId.
    let resolvedProjectId = projectId;
    if (taskId && !resolvedProjectId) {
      const task = await db.Task.findByPk(taskId);
      resolvedProjectId = task?.projectId;
    }
    if (!resolvedProjectId) return res.status(400).json({ error: 'projectId or taskId (resolvable to projectId) is required.' });

    const results = await Promise.all(files.map(async (file) => {
      const stream = fs.createReadStream(file.path);
      const result = await MediaService.upload(stream, file.originalname, file.mimetype);
      fs.unlink(file.path, () => {});
      let artifact = null;
      if (resolvedProjectId) {
        artifact = await Artifact.create({
          projectId: resolvedProjectId,
          taskId: taskId || null,
          stageKey: stageKey || 'general',
          fileUrl: result.url,
          fileName: result.originalName,
          fileSize: result.size,
          mimeType: result.mimetype,
          kind: kind || null,
          uploadedBy: req.user.id,
        });
      }
      return { ...result, artifact };
    }));
    mirrorToBlogSheet(taskId, kind, req.user.id);

    res.status(201).json({ results });
  } catch (err) {
    // Best-effort cleanup for tmp files that might remain on error.
    tmpPaths.forEach((p) => { if (p) fs.unlink(p, () => {}); });
    next(err);
  }
});

// GET /api/media/artifacts?projectId=xxx&stageKey=yyy&taskId=zzz
router.get('/artifacts', async (req, res, next) => {
  try {
    const { projectId, stageKey, taskId } = req.query;
    if (!projectId && !taskId) return res.status(400).json({ error: 'projectId or taskId is required.' });
    const where = {};
    // Deactivated artifacts are hidden unless explicitly asked for.
    if (!isTruthy(req.query.includeInactive)) where.isActive = true;
    if (projectId) where.projectId = projectId;
    if (stageKey) where.stageKey = stageKey;
    if (taskId) where.taskId = taskId;
    const artifacts = await Artifact.findAll({
      where,
      include: [{ model: db.User, as: 'uploader', attributes: ['id', 'name'] }],
      order: [['createdAt', 'DESC']],
    });
    res.json(artifacts);
  } catch (err) { next(err); }
});

// POST /api/media/link — save a URL (e.g. Figma) as an artifact without file upload
router.post('/link', async (req, res, next) => {
  try {
    const { projectId, taskId, stageKey, url, kind } = req.body;
    if (!projectId || !url) return res.status(400).json({ error: 'projectId and url are required.' });
    const artifact = await Artifact.create({
      projectId,
      taskId: taskId || null,
      stageKey: stageKey || 'general',
      fileUrl: url,
      fileName: url,
      kind: kind || 'link',
      uploadedBy: req.user.id,
    });
    mirrorToBlogSheet(taskId, kind || 'link', req.user.id);
    res.status(201).json({ artifact });
  } catch (err) { next(err); }
});

// DELETE /api/media/:filename
// Deactivates, never destroys — see services/SoftDeleteService.js. The stored blob
// is left in place too: an artifact link that a client or a past task references
// must not turn into a dead URL because someone tidied up the deliverables list.
router.delete('/:filename', adminOnly, async (req, res, next) => {
  try {
    const { filename } = req.params;
    const { Op } = require('sequelize');
    const [count] = await Artifact.update(
      { isActive: false },
      { where: { fileUrl: { [Op.like]: `%${filename}` } } },
    );
    res.json({ message: 'File set to Inactive', updated: count });
  } catch (err) { next(err); }
});

router.post('/:filename/activate', adminOnly, async (req, res, next) => {
  try {
    const { filename } = req.params;
    const { Op } = require('sequelize');
    const [count] = await Artifact.update(
      { isActive: true },
      { where: { fileUrl: { [Op.like]: `%${filename}` } } },
    );
    res.json({ message: 'File set to Active', updated: count });
  } catch (err) { next(err); }
});

module.exports = router;
