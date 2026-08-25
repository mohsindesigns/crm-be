const { Op } = require('sequelize');
const db = require('../models');
const { canActOnProject } = require('./guard');
const { PROJECT_STATUS, ADVANCE_RULE, TASK_STATUS } = require('../config/constants');

/**
 * Workflow Engine — Open/Closed principle:
 *   - performAction() never changes when new services are added.
 *   - New services = new rows in workflow_templates + stages + transitions.
 *
 * Flow:
 *   1. Authorise: caller must be the stage owner (or super_admin).
 *   2. Resolve transition: look up transitions table for (fromStage, action).
 *   3. Check advance rule: confirm stage completion criteria are met.
 *   4. Advance: update project.currentStageKey + append ProjectEvent.
 *   5. If terminal stage: close the project.
 */
const performAction = async ({ user, project, action, reasonCategory = null, note = null, transaction: outerTx }) => {
  const sequelize = db.sequelize;

  const execute = async (t) => {
    const authorized = await canActOnProject(user, project);
    if (!authorized) {
      const err = new Error('You are not assigned to act on this stage.');
      err.status = 403;
      throw err;
    }

    const currentStage = await db.Stage.findOne({
      where: { templateId: project.workflowTemplateId, key: project.currentStageKey },
      transaction: t,
    });

    if (!currentStage) {
      const err = new Error('Current stage not found in workflow template.');
      err.status = 500;
      throw err;
    }

    if (project.status === PROJECT_STATUS.COMPLETED) {
      const err = new Error('Project is already completed.');
      err.status = 400;
      throw err;
    }

    const isSuperAdmin = user.role?.key === 'super_admin';

    // For 'complete' / 'approve': auto-close unfinished tasks that don't need a
    // separate reviewer. Tasks handed to someone else (assignee ≠ reviewer) must
    // go through submit → approve individually — bulk-closing them bypasses that
    // workflow and leaves no audit trail in TaskEvent.
    if (action === 'complete' || action === 'approve') {
      const openTasks = await db.Task.findAll({
        where: {
          projectId: project.id,
          stageKey: currentStage.key,
          status: { [Op.ne]: TASK_STATUS.APPROVED },
          // Recurring-rule tasks (GMB posts, monthly SEO reviews, …) are tagged
          // with whatever stageKey the project happened to be on when
          // AutoTaskScheduler generated them — they aren't a deliverable for
          // THIS stage, they're an independent cadence that (per that
          // scheduler's own comment) keeps running even after the project
          // reaches its terminal stage. Auto-closing them here would silently
          // mark ongoing retainer work "done" just because an unrelated stage
          // advanced.
          ruleId: null,
        },
        transaction: t,
      });
      const now = new Date();
      for (const tk of openTasks) {
        const effectiveReviewerId = tk.reviewerId || tk.createdBy || null;
        const usesReviewPipeline = !!(
          effectiveReviewerId
          && tk.assigneeId
          && effectiveReviewerId !== tk.assigneeId
        );
        if (usesReviewPipeline) continue;
        await tk.update({ status: TASK_STATUS.APPROVED, completedAt: now }, { transaction: t });
      }
    }

    // Super Admin Mark Complete / Approve is an override — never block on leftover tasks.
    if (!(isSuperAdmin && (action === 'complete' || action === 'approve'))) {
      await assertAdvanceRule(currentStage, project, t);
    }

    const transition = await db.Transition.findOne({
      where: {
        templateId: project.workflowTemplateId,
        fromStageKey: project.currentStageKey,
        action,
        [Op.or]: [
          { reasonCategory },
          { reasonCategory: null },
        ],
      },
      order: [['reasonCategory', 'DESC']],
      transaction: t,
    });

    if (!transition) {
      const err = new Error(`No transition defined for action "${action}" from stage "${project.currentStageKey}".`);
      err.status = 400;
      throw err;
    }

    const nextStage = await db.Stage.findOne({
      where: { templateId: project.workflowTemplateId, key: transition.toStageKey },
      transaction: t,
    });

    if (!nextStage) {
      const err = new Error('Target stage not found in workflow template.');
      err.status = 500;
      throw err;
    }

    await db.ProjectEvent.create({
      projectId: project.id,
      fromStageKey: project.currentStageKey,
      toStageKey: nextStage.key,
      action,
      reasonCategory,
      actorUserId: user.id,
      note,
    }, { transaction: t });

    // Completed once the project REACHES its terminal stage, not when leaving
    // whatever stage it happened to be on before — checking currentStage here meant
    // a project only ever completed on the (rare) hop out of an already-terminal
    // stage, so reaching e.g. Hosting's "Live" or GMB's "Recurring Posts" for the
    // first time left status stuck on "active" everywhere in the app even though
    // the stage timeline showed the terminal stage reached.
    const newStatus = nextStage.isTerminal ? PROJECT_STATUS.COMPLETED : PROJECT_STATUS.ACTIVE;

    await project.update(
      { currentStageKey: nextStage.key, status: newStatus },
      { transaction: t }
    );

    return { fromStage: currentStage, toStage: nextStage };
  };

  if (outerTx) return execute(outerTx);
  return sequelize.transaction(execute);
};

/**
 * Checks whether the stage's advance rule allows moving forward.
 * Throws a 400 error if conditions are not met.
 */
const assertAdvanceRule = async (stage, project, t) => {
  // requiresArtifact is advisory — the UI prompts for a deliverable but does not hard-block advancing

  const rule = stage.advanceRule;

  if (!rule || rule === ADVANCE_RULE.MANUAL || rule === ADVANCE_RULE.SINGLE_ACTION) {
    return;
  }

  // Same exclusion as the auto-close loop in performAction, and for the same
  // reason: a task materialized from a RecurringTaskRule (GMB post, monthly
  // SEO review, blog post, …) is bound to this stageKey only because that
  // happened to be the project's current stage the day it was generated —
  // it's an ongoing retainer obligation, not a condition for leaving this
  // stage, and AutoTaskScheduler explicitly keeps generating these past
  // project completion. Counting them here blocked advancing/completing a
  // stage on tasks that were never meant to gate it.
  const tasks = await db.Task.findAll({
    where: { projectId: project.id, stageKey: stage.key, ruleId: null },
    transaction: t,
  });

  if (tasks.length === 0) return;

  // "Done" for advancing means the work is finished, which includes tasks that
  // went one better and were APPROVED. Content tasks are the common case: writing
  // a page moves its task to `submitted`, and a strategist approving the
  // submission moves it straight to `approved` — it never passes through `done`.
  // Comparing against DONE alone therefore blocked Content Writing from advancing
  // with "1 task(s) must be completed before advancing" even though every page
  // had been written AND approved.
  const isFinished = (tk) => tk.status === TASK_STATUS.DONE || tk.status === TASK_STATUS.APPROVED;

  if (rule === ADVANCE_RULE.ALL_TASKS_DONE) {
    const undone = tasks.filter((tk) => !isFinished(tk));
    if (undone.length > 0) {
      const names = undone.slice(0, 3).map((tk) => `“${tk.title}” (${tk.status})`).join(', ');
      const more = undone.length > 3 ? ` and ${undone.length - 3} more` : '';
      const err = new Error(`${undone.length} task(s) must be completed before advancing: ${names}${more}.`);
      err.status = 400;
      throw err;
    }
  }

  if (rule === ADVANCE_RULE.ALL_TASKS_APPROVED) {
    // DONE counts, for the mirror of the reason above. An approval stage also
    // collects ad-hoc Issue tasks ("fix on-page error"), and those are finished
    // by being marked done — they never go through submit → approve. Demanding
    // a literal `approved` on every task meant one done Issue could block a
    // stage permanently, with every content page already approved and no way
    // to clear it from the UI.
    const unapproved = tasks.filter((tk) => !isFinished(tk));
    if (unapproved.length > 0) {
      // Name them. "2 task(s) must be approved" with no clue which two is a dead
      // end for whoever is standing in front of it.
      const names = unapproved.slice(0, 3).map((tk) => `“${tk.title}” (${tk.status})`).join(', ');
      const more = unapproved.length > 3 ? ` and ${unapproved.length - 3} more` : '';
      const err = new Error(
        `${unapproved.length} task(s) must be approved or completed before advancing: ${names}${more}.`,
      );
      err.status = 400;
      throw err;
    }
  }

  if (rule === ADVANCE_RULE.ANY_TASK_DONE) {
    if (!tasks.some(isFinished)) {
      const err = new Error('At least one task must be completed before advancing.');
      err.status = 400;
      throw err;
    }
  }
};

/**
 * Super admin only: rewind a project to a previous stage.
 * Records a special 'rewind' event for audit purposes.
 */
const rewindStage = async ({ user, project, targetStageKey, note, transaction: outerTx }) => {
  if (user.role?.key !== 'super_admin') {
    const err = new Error('Only super admin can rewind a project stage.');
    err.status = 403;
    throw err;
  }

  const sequelize = db.sequelize;

  const execute = async (t) => {
    const targetStage = await db.Stage.findOne({
      where: { templateId: project.workflowTemplateId, key: targetStageKey },
      transaction: t,
    });

    if (!targetStage) {
      const err = new Error('Target stage not found.');
      err.status = 400;
      throw err;
    }

    await db.ProjectEvent.create({
      projectId: project.id,
      fromStageKey: project.currentStageKey,
      toStageKey: targetStageKey,
      action: 'rewind',
      actorUserId: user.id,
      note,
    }, { transaction: t });

    await project.update(
      { currentStageKey: targetStageKey, status: PROJECT_STATUS.ACTIVE },
      { transaction: t }
    );

    return targetStage;
  };

  if (outerTx) return execute(outerTx);
  return sequelize.transaction(execute);
};

module.exports = { performAction, rewindStage };
