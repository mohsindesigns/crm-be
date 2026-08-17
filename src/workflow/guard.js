const { ProjectAssignment, Stage, WorkflowTemplate } = require('../models');

/**
 * Returns true if the user is allowed to act on the project's current stage.
 *
 * Two-layer check:
 *  1. Global role gate is handled upstream by rbac middleware.
 *  2. Here we check project-assignment gate: is this user the assigned
 *     owner of the role slot that owns the current stage?
 *
 * Super admin can always act.
 */
const canActOnProject = async (user, project) => {
  if (user.role?.key === 'super_admin') return true;

  const stage = await Stage.findOne({
    where: {
      templateId: project.workflowTemplateId,
      key: project.currentStageKey,
    },
  });

  if (!stage) return false;

  const assignment = await ProjectAssignment.findOne({
    where: {
      projectId: project.id,
      roleSlot: stage.ownerRoleSlot,
      userId: user.id,
    },
  });

  return Boolean(assignment);
};

module.exports = { canActOnProject };
