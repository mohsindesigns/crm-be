const { Op } = require('sequelize');
const { v4: uuidv4 } = require('uuid');
const db = require('../models');
const { performAction } = require('./engine');
const RecurringTaskRuleService = require('../services/RecurringTaskRuleService');

/**
 * Auto-create tasks when a work stage is entered or a project is created.
 * - Approval stages are skipped (they advance via project action, not task completion).
 * - The stage owner (from ProjectAssignment) is set as assigneeId so the task
 *   appears in their "My Tasks" view immediately.
 * - 'content' stages: one task per unique keyword pageName.
 * - All other work stages: a single generic task.
 */
async function autoCreateStageTasks(project, stage, orgId) {
  if (stage.stageType === 'approval') return;

  const existing = await db.Task.count({ where: { projectId: project.id, stageKey: stage.key, autoCreated: true } });
  if (existing > 0) return;

  // Resolve the stage owner so the task appears in their My Tasks
  let assigneeId = null;
  if (stage.ownerRoleSlot) {
    const assignment = await db.ProjectAssignment.findOne({
      where: { projectId: project.id, roleSlot: stage.ownerRoleSlot },
    });
    assigneeId = assignment?.userId ?? null;
  }

  if (stage.taskType === 'content') {
    const keywords = await db.Keyword.findAll({
      where: { projectId: project.id },
      attributes: ['pageName'],
      group: ['pageName'],
    });

    const pageNames = keywords.map((k) => k.pageName).filter(Boolean);
    if (pageNames.length === 0) return;

    await db.Task.bulkCreate(
      pageNames.map((pageName) => ({
        id: uuidv4(),
        orgId,
        projectId: project.id,
        stageKey: stage.key,
        type: 'content',
        title: pageName,
        assigneeId,
        status: 'todo',
        autoCreated: true,
      }))
    );
  } else {
    await db.Task.create({
      id: uuidv4(),
      orgId,
      projectId: project.id,
      stageKey: stage.key,
      type: stage.taskType || 'work',
      title: `${stage.name} — auto task`,
      assigneeId,
      status: 'todo',
      autoCreated: true,
    });
  }
}

/**
 * Shared "we just moved forward onto `toStage`" side effects — used both by a
 * manual stage action (ProjectController#action) and by autoAdvancePastHiddenStages
 * chaining through several hidden work stages in one go.
 */
async function applyForwardAdvanceSideEffects(project, fromStage, toStage, orgId) {
  // Implicitly complete any open auto-tasks left over in the stage just left.
  await db.Task.update(
    { status: 'done', completedAt: new Date() },
    {
      where: {
        projectId: project.id,
        stageKey: fromStage.key,
        autoCreated: true,
        status: { [Op.notIn]: ['done', 'approved'] },
      },
    }
  );
  await autoCreateStageTasks(project, toStage, orgId);
  // Recurring SEO projects landing on their terminal stage get their monthly
  // review + ranking-update rules provisioned automatically — fire-and-forget,
  // must never block the caller.
  RecurringTaskRuleService.handleTerminalStageReached(project, toStage, orgId).catch((err) => {
    console.error('[autoAdvance] Failed to auto-provision recurring task rules:', err.message);
  });
}

/**
 * Chains a project forward through consecutive hidden (`showInTimeline: false`)
 * work stages once each one's advance rule is already satisfied — the
 * "default"/auto-advance counterpart to a manual Mark Complete click. The
 * stage's actual work still happens through its own tab (Keywords, Content,
 * …); this just removes the redundant manual stage-advance click once that
 * work is done.
 *
 * Approval stages are never touched here — hiding one from the timeline only
 * hides its pill (see Stage.showInTimeline on the model). A real
 * approve/reject decision is never guessed by this function, only a stage
 * with exactly one possible next stage (no branching) is eligible.
 *
 * Safe to call speculatively any time task state might have changed — it's a
 * no-op if the current stage isn't an eligible hidden work stage, or if its
 * advance rule isn't satisfied yet (a normal, expected outcome, not an error).
 */
async function autoAdvancePastHiddenStages(project, orgId) {
  let lastResult = null;
  for (let hop = 0; hop < 10; hop += 1) {
    await project.reload();
    const stage = await db.Stage.findOne({
      where: { templateId: project.workflowTemplateId, key: project.currentStageKey },
    });
    if (!stage || stage.stageType !== 'work' || stage.showInTimeline !== false) return lastResult;

    const transitions = await db.Transition.findAll({
      where: { templateId: project.workflowTemplateId, fromStageKey: stage.key },
    });
    if (transitions.length !== 1) return lastResult; // ambiguous — never guess which branch to take

    // Synthetic system actor — same pattern as the client-portal approve/reject
    // routes (routes/portal.js), whose caller (a Contact) isn't a User FK either.
    const systemActor = { id: null, role: { key: 'super_admin' }, orgId };
    let result;
    try {
      result = await performAction({
        user: systemActor,
        project,
        action: transitions[0].action,
        note: 'Auto-advanced — stage hidden from timeline.',
      });
    } catch (err) {
      // Advance rule not satisfied yet is the expected, common outcome here —
      // only log the unexpected shapes (missing stage/transition rows, etc).
      if (!err.status || err.status >= 500) {
        console.error('[autoAdvance] unexpected failure:', err.message);
      }
      return lastResult;
    }

    await applyForwardAdvanceSideEffects(project, result.fromStage, result.toStage, orgId);
    lastResult = result;
  }
  console.error(`[autoAdvance] hop limit reached for project ${project.id} — check the workflow template for a cycle of hidden work stages.`);
  return lastResult;
}

module.exports = { autoCreateStageTasks, applyForwardAdvanceSideEffects, autoAdvancePastHiddenStages };
