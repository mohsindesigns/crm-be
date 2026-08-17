const express = require('express');
const router = express.Router({ mergeParams: true });
const CommentController = require('../controllers/CommentController');
const auth = require('../middleware/auth');
const tenancy = require('../middleware/tenancy');
const adminOnly = require('../middleware/adminOnly');

router.use(auth, tenancy);

// Mounted at /api/projects/:projectId/comments
router.get('/', (req, res, next) => CommentController.list(req, res, next));
router.post('/', (req, res, next) => CommentController.create(req, res, next));
// Deactivates, never destroys — see services/SoftDeleteService.js.
router.delete('/:commentId', adminOnly, (req, res, next) => CommentController.remove(req, res, next));
router.post('/:commentId/activate', adminOnly, (req, res, next) => CommentController.activate(req, res, next));

module.exports = router;
