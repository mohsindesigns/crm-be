const { Comment, User, Project } = require('../models');

function orgScope(orgId) {
  return {
    include: [{
      model: Project,
      as: 'project',
      where: { orgId },
      attributes: [],
    }],
  };
}

async function listForProject(projectId, orgId, { includeInactive = false } = {}) {
  return Comment.findAll({
    where: { projectId, ...(includeInactive ? {} : { isActive: true }) },
    include: [
      { model: User, as: 'author', attributes: ['id', 'name', 'avatarUrl'] },
      // Scope to the org via the parent project without selecting its columns
      { model: Project, as: 'project', where: { orgId }, attributes: [] },
    ],
    order: [['createdAt', 'ASC']],
  });
}

async function create({ body, projectId, stageKey, authorId, orgId }) {
  // Verify project belongs to this org
  const project = await Project.findOne({ where: { id: projectId, orgId } });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });
  return Comment.create({ body, projectId, stageKey: stageKey || null, authorId });
}

// Deactivates rather than destroys — see services/SoftDeleteService.js. The route
// is already admin-gated (middleware/adminOnly), and an admin moderating the board
// is the main reason to hide a comment, so authorship is no longer required —
// but the author check is kept for any non-admin caller.
async function remove(id, user, orgId, active = false) {
  const comment = await Comment.findOne({
    where: { id },
    ...orgScope(orgId),
  });
  if (!comment) throw Object.assign(new Error('Comment not found'), { status: 404 });
  const isAdmin = ['super_admin', 'admin'].includes(user?.role?.key);
  if (!isAdmin && comment.authorId !== user?.id) {
    throw Object.assign(new Error('Forbidden'), { status: 403 });
  }
  await comment.update({ isActive: active });
  return comment;
}

module.exports = { listForProject, create, remove };
