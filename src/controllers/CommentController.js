const CommentService = require('../services/CommentService');
const { isTruthy } = require('../services/SoftDeleteService');

const CommentController = {
  async list(req, res, next) {
    try {
      const comments = await CommentService.listForProject(req.params.projectId, req.orgId, {
        includeInactive: isTruthy(req.query.includeInactive),
      });
      res.json(comments);
    } catch (err) { next(err); }
  },

  async create(req, res, next) {
    try {
      const { body, stageKey } = req.body;
      if (!body || !body.trim()) return res.status(400).json({ error: 'body is required' });
      const comment = await CommentService.create({
        body: body.trim(),
        projectId: req.params.projectId,
        stageKey: stageKey || null,
        authorId: req.user.id,
        orgId: req.orgId,
      });
      res.status(201).json(comment);
    } catch (err) { next(err); }
  },

  // Deactivates, never destroys — see services/SoftDeleteService.js.
  async remove(req, res, next) {
    try {
      const comment = await CommentService.remove(req.params.commentId, req.user, req.orgId, false);
      res.json({ message: 'Comment set to Inactive', comment });
    } catch (err) { next(err); }
  },

  async activate(req, res, next) {
    try {
      const comment = await CommentService.remove(req.params.commentId, req.user, req.orgId, true);
      res.json({ message: 'Comment set to Active', comment });
    } catch (err) { next(err); }
  },
};

module.exports = CommentController;
