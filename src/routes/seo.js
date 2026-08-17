const express = require('express');
const multer = require('multer');
const router = express.Router();
const auth = require('../middleware/auth');
const tenancy = require('../middleware/tenancy');
const adminOnly = require('../middleware/adminOnly');
const { isTruthy } = require('../services/SoftDeleteService');
const rbac = require('../middleware/rbac');
const SeoService = require('../services/SeoService');
const MediaService = require('../services/MediaService');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.use(auth, tenancy);

// ─── Keywords ─────────────────────────────────────────────────────────────────
router.get('/projects/:projectId/keywords', rbac('projects.read'), async (req, res, next) => {
  try {
    res.json(await SeoService.listKeywords(req.params.projectId, req.orgId, {
      includeInactive: isTruthy(req.query.includeInactive),
    }));
  } catch (e) { next(e); }
});

router.post('/projects/:projectId/keywords', rbac('projects.act'), async (req, res, next) => {
  try {
    const kw = await SeoService.createKeyword({ ...req.body, projectId: req.params.projectId, createdBy: req.user.id }, req.orgId);
    res.status(201).json(kw);
  } catch (e) { next(e); }
});

router.get('/projects/:projectId/keywords/pdf', rbac('projects.read'), async (req, res, next) => {
  try {
    const { buffer, project } = await SeoService.generateKeywordReportBuffer(req.params.projectId, req.orgId);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="keyword-report-${project.id}.pdf"`);
    res.send(buffer);
  } catch (e) { next(e); }
});

router.get('/projects/:projectId/backlinks/pdf', rbac('projects.read'), async (req, res, next) => {
  try {
    const { buffer, project } = await SeoService.generateBacklinkReportBuffer(req.params.projectId, req.orgId);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="backlink-report-${project.id}.pdf"`);
    res.send(buffer);
  } catch (e) { next(e); }
});

router.post('/projects/:projectId/keywords/import', rbac('projects.act'), upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const rows = await SeoService.bulkImportKeywords(req.params.projectId, req.orgId, req.file.buffer, req.user.id);
    res.status(201).json({ imported: rows.length, rows });
  } catch (e) { next(e); }
});

router.patch('/keywords/:id', rbac('projects.act'), async (req, res, next) => {
  try {
    res.json(await SeoService.updateKeyword(req.params.id, req.body, req.orgId, req.user.id));
  } catch (e) { next(e); }
});

// Kept on the DELETE verb so existing clients don't break, but the effect is a
// deactivation — nothing is destroyed. Reactivate via PATCH /keywords/:id
// { status: 'active' }.
router.delete('/keywords/:id', adminOnly, rbac('projects.act'), async (req, res, next) => {
  try {
    const kw = await SeoService.deleteKeyword(req.params.id, req.orgId);
    res.json({ message: 'Keyword set to Inactive', keyword: kw });
  } catch (e) { next(e); }
});

router.delete('/projects/:projectId/keywords', adminOnly, rbac('projects.act'), async (req, res, next) => {
  try {
    res.json(await SeoService.clearKeywords(req.params.projectId, req.orgId));
  } catch (e) { next(e); }
});

router.post('/projects/:projectId/keywords/bulk-delete', adminOnly, rbac('projects.act'), async (req, res, next) => {
  try {
    res.json(await SeoService.bulkDeleteKeywords(req.params.projectId, req.orgId, req.body?.ids));
  } catch (e) { next(e); }
});

// ─── Rank Snapshots / Monthly Reporting ───────────────────────────────────────
router.post('/keywords/:keywordId/rankings', rbac('projects.act'), async (req, res, next) => {
  try {
    const { position, checkedAt } = req.body;
    res.status(201).json(await SeoService.addRankSnapshot(req.params.keywordId, position, checkedAt, req.orgId));
  } catch (e) { next(e); }
});

// The Monthly Report grid: keywords × report dates, with the movement between
// the two most recent dates.
router.get('/projects/:projectId/rankings', rbac('projects.read'), async (req, res, next) => {
  try {
    res.json(await SeoService.listRankings(req.params.projectId, req.orgId, {
      from: req.query.from, to: req.query.to,
    }));
  } catch (e) { next(e); }
});

// Records one report date's positions in a single call.
router.post('/projects/:projectId/rankings', rbac('projects.act'), async (req, res, next) => {
  try {
    res.status(201).json(await SeoService.recordRankings(req.params.projectId, req.orgId, req.body));
  } catch (e) { next(e); }
});

router.post('/projects/:projectId/rankings/import', rbac('projects.act'), upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const result = await SeoService.bulkImportRankings(
      req.params.projectId, req.orgId, req.file.buffer, req.body?.date
    );
    res.status(201).json(result);
  } catch (e) { next(e); }
});

// Rank snapshots are pure measurements, not business records — a mis-dated
// column is deleted outright rather than deactivated.
router.delete('/projects/:projectId/rankings/:date', adminOnly, rbac('projects.act'), async (req, res, next) => {
  try {
    res.json(await SeoService.deleteRankingDate(req.params.projectId, req.orgId, req.params.date));
  } catch (e) { next(e); }
});

// ─── Backlinks ────────────────────────────────────────────────────────────────
router.get('/projects/:projectId/backlinks', rbac('projects.read'), async (req, res, next) => {
  try {
    res.json(await SeoService.listBacklinks(req.params.projectId, req.orgId, {
      includeInactive: isTruthy(req.query.includeInactive),
    }));
  } catch (e) { next(e); }
});

router.post('/projects/:projectId/backlinks', rbac('projects.act'), async (req, res, next) => {
  try {
    const bl = await SeoService.createBacklink({ ...req.body, projectId: req.params.projectId, addedBy: req.user.id }, req.orgId);
    res.status(201).json(bl);
  } catch (e) { next(e); }
});

router.patch('/backlinks/:id', rbac('projects.act'), async (req, res, next) => {
  try {
    res.json(await SeoService.updateBacklink(req.params.id, req.body, req.orgId));
  } catch (e) { next(e); }
});

// Deactivates, never destroys. Reactivate via PATCH /backlinks/:id { isActive: true }.
router.delete('/backlinks/:id', adminOnly, rbac('projects.act'), async (req, res, next) => {
  try {
    const bl = await SeoService.deleteBacklink(req.params.id, req.orgId);
    res.json({ message: 'Backlink set to Inactive', backlink: bl });
  } catch (e) { next(e); }
});

router.delete('/projects/:projectId/backlinks', adminOnly, rbac('projects.act'), async (req, res, next) => {
  try {
    res.json(await SeoService.clearBacklinks(req.params.projectId, req.orgId));
  } catch (e) { next(e); }
});

router.post('/projects/:projectId/backlinks/bulk-delete', adminOnly, rbac('projects.act'), async (req, res, next) => {
  try {
    res.json(await SeoService.bulkDeleteBacklinks(req.params.projectId, req.orgId, req.body?.ids));
  } catch (e) { next(e); }
});

router.post('/projects/:projectId/backlinks/import', rbac('projects.act'), upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const rows = await SeoService.bulkImportBacklinks(req.params.projectId, req.orgId, req.file.buffer, req.user.id);
    res.status(201).json({ imported: rows.length, rows });
  } catch (e) { next(e); }
});

// Updates status/isIndexed on existing backlinks by matching "Published URL" —
// never creates new rows. Separate endpoint from /import (which always creates)
// so the two modes can't be confused client-side.
router.post('/projects/:projectId/backlinks/update-status', rbac('projects.act'), upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const result = await SeoService.bulkUpdateBacklinkStatus(req.params.projectId, req.orgId, req.file.buffer);
    res.status(200).json(result);
  } catch (e) { next(e); }
});

// ─── Content Submissions ──────────────────────────────────────────────────────
router.get('/projects/:projectId/content', rbac('projects.read'), async (req, res, next) => {
  try {
    res.json(await SeoService.listContent(req.params.projectId, req.orgId));
  } catch (e) { next(e); }
});

router.post('/projects/:projectId/content', rbac('projects.act'), upload.single('file'), async (req, res, next) => {
  try {
    // Deliverable can be an uploaded file OR a pasted link (Google Doc, Drive, Notion, …).
    let fileUrl = String(req.body.fileUrl || '').trim() || undefined;
    let fileName = String(req.body.fileName || '').trim() || undefined;
    if (req.file) {
      const media = await MediaService.upload(req.file.buffer, req.file.originalname, req.file.mimetype);
      fileUrl = media.url;
      fileName = req.file.originalname;
    } else if (fileUrl && !fileName) {
      fileName = 'Link';
    }
    if (!fileUrl) {
      return res.status(400).json({ message: 'Attach a file or paste a deliverable link.' });
    }
    const rawIds = req.body.keywordIds;
    const keywordIds = rawIds === undefined ? undefined
      : typeof rawIds === 'string' ? JSON.parse(rawIds)
      : rawIds;
    const cs = await SeoService.createContent({
      pageName: req.body.pageName,
      keywordIds,
      fileUrl,
      fileName,
      wordCount: req.body.wordCount ? parseInt(req.body.wordCount, 10) : null,
      projectId: req.params.projectId,
      submittedBy: req.user.id,
    }, req.orgId, req.user);
    res.status(201).json(cs);
  } catch (e) { next(e); }
});

router.patch('/content/:id/review', rbac('projects.act'), async (req, res, next) => {
  try {
    const cs = await SeoService.reviewContent(req.params.id, {
      status: req.body.status,
      rejectionReason: req.body.rejectionReason,
    }, req.orgId, req.user);
    res.json(cs);
  } catch (e) { next(e); }
});

router.delete('/content/:id', rbac('projects.act'), async (req, res, next) => {
  try {
    res.json(await SeoService.deleteContent(req.params.id, req.orgId, req.user));
  } catch (e) { next(e); }
});

// ─── Blog Tasks ───────────────────────────────────────────────────────────────
router.get('/projects/:projectId/blogs', rbac('projects.read'), async (req, res, next) => {
  try {
    res.json(await SeoService.listBlogTasks(req.params.projectId, req.orgId));
  } catch (e) { next(e); }
});

router.post('/projects/:projectId/blogs', rbac('projects.act'), async (req, res, next) => {
  try {
    const bt = await SeoService.createBlogTask({ ...req.body, projectId: req.params.projectId, createdBy: req.user.id }, req.orgId);
    res.status(201).json(bt);
  } catch (e) { next(e); }
});

router.patch('/blogs/:id', rbac('projects.act'), async (req, res, next) => {
  try {
    res.json(await SeoService.updateBlogTask(req.params.id, req.body, req.orgId, req.user.id));
  } catch (e) { next(e); }
});

// ─── Blog Sheet (CSV/XLSX import + approval) ──────────────────────────────────
router.get('/projects/:projectId/blog-sheet', rbac('projects.read'), async (req, res, next) => {
  try {
    res.json(await SeoService.listBlogSheet(req.params.projectId, req.orgId, {
      includeInactive: isTruthy(req.query.includeInactive),
    }));
  } catch (e) { next(e); }
});

router.post('/projects/:projectId/blog-sheet', rbac('projects.act'), async (req, res, next) => {
  try {
    const bt = await SeoService.createBlogSheetRow(req.params.projectId, req.body, req.orgId, req.user.id);
    res.status(201).json(bt);
  } catch (e) { next(e); }
});

// Writer deliverable submit (file optional) — mirrors POST .../content.
router.post('/projects/:projectId/blog-sheet/submit', rbac('projects.act'), upload.single('file'), async (req, res, next) => {
  try {
    // Same as content: uploaded file OR pasted link counts as the deliverable.
    let fileUrl = String(req.body.fileUrl || '').trim() || undefined;
    if (req.file) {
      const media = await MediaService.upload(req.file.buffer, req.file.originalname, req.file.mimetype);
      fileUrl = media.url;
    }
    const bt = await SeoService.submitBlogDeliverable(req.params.projectId, {
      blogId: req.body.blogId || null,
      title: req.body.title,
      contentType: req.body.contentType,
      mainKeyword: req.body.mainKeyword,
      assignedWriterId: req.body.assignedWriterId || null,
      fileUrl,
    }, req.orgId, req.user);
    res.status(201).json(bt);
  } catch (e) { next(e); }
});

router.post('/projects/:projectId/blog-sheet/import', rbac('projects.act'), upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const { rows, unmatchedWriters } = await SeoService.bulkImportBlogTasks(req.params.projectId, req.orgId, req.file.buffer, req.user.id);
    res.status(201).json({ imported: rows.length, rows, unmatchedWriters });
  } catch (e) { next(e); }
});

router.patch('/blog-sheet/:id/review', rbac('projects.act'), async (req, res, next) => {
  try {
    const bt = await SeoService.reviewBlogTask(req.params.id, {
      status: req.body.status,
      rejectionReason: req.body.rejectionReason,
    }, req.orgId, req.user);
    res.json(bt);
  } catch (e) { next(e); }
});

// Deactivates, never destroys.
router.delete('/blog-sheet/:id', adminOnly, rbac('projects.act'), async (req, res, next) => {
  try {
    const bt = await SeoService.deleteBlogTask(req.params.id, req.orgId, false);
    res.json({ message: 'Blog set to Inactive', blog: bt });
  } catch (e) { next(e); }
});

router.post('/blog-sheet/:id/activate', adminOnly, rbac('projects.act'), async (req, res, next) => {
  try {
    const bt = await SeoService.deleteBlogTask(req.params.id, req.orgId, true);
    res.json({ message: 'Blog set to Active', blog: bt });
  } catch (e) { next(e); }
});

module.exports = router;
