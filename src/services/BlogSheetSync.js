// Keeps a blog `Task` (the writer's to-do) and its `BlogTask` sheet row (the
// Blogs tab on the project) pointing at the same thing.
//
// Why this exists: the two halves were only ever created together from the Blogs
// tab (SeoService#createBlogSheetRow / #bulkImportBlogTasks / #submitBlogDeliverable),
// which creates the sheet row first and the Task second. But a blog Task can also
// arrive from two other places that know nothing about the sheet:
//   - AutoTaskScheduler, for a weekly/monthly "blog_writer" recurring rule, and
//   - the generic Create Task modal, picking type `blog_post` by hand.
// Those tasks have no sheet row and no `pageName`, so a deliverable attached to
// them had nothing to attach *to* — the file lived on the Task and the Blogs tab
// showed the blog as missing entirely. Every downstream blog routine
// (reviewBlogTask, markBlogTasksSubmitted, ensureBlogTask) pairs the two halves by
// `projectId` + `pageName` === `title`, so the fix is to make sure the row and the
// pageName exist before any of them run, then mirror the deliverable across.
//
// Only ever additive to the sheet: an already-approved row is never knocked back
// to pending/rejected here, and a file is only copied over when there actually is
// one (the Blogs-tab submit path uploads without creating an Artifact, and must
// not have its fileUrl blanked by a Task transition that follows it).
const { Op } = require('sequelize');
const db = require('../models');

// Task titles this app generates itself for a blog ("Write blog — Foo"). When a
// sheet row has to be derived from the Task, the instruction half is stripped so
// the Blogs tab shows the blog's own title rather than the sentence aimed at the
// writer. A hand-typed or recurring-rule title is used as-is.
const GENERATED_TITLE_PREFIX = /^(?:write|revise|rewrite)\s+blog\s*[—–-]\s*/i;

// Sheet rows that are still in play — a submit/reassign should land on one of
// these rather than reopening something already signed off.
const OPEN_SHEET_STATUSES = ['draft', 'rejected', 'pending'];

// Task status → sheet status. `done` maps to `pending` on purpose: marking the
// writer's task complete does not itself approve the blog — the strategist/PM
// still signs it off in the Blogs tab, which is what flips the row (and the task)
// to approved. See SeoService#reviewBlogTask, which deliberately accepts `done`
// tasks as approvable.
const SHEET_STATUS_BY_TASK_STATUS = {
  submitted: 'pending',
  in_review: 'pending',
  done: 'pending',
  approved: 'approved',
  rejected: 'rejected',
};

function sheetTitleForTask(task) {
  const pageName = String(task.pageName || '').trim();
  if (pageName) return pageName;
  return String(task.title || '').replace(GENERATED_TITLE_PREFIX, '').trim();
}

async function nextSortOrder(projectId, transaction) {
  const max = await db.BlogTask.max('sortOrder', { where: { projectId }, transaction });
  return (Number.isFinite(max) ? max : -1) + 1;
}

// Prefer the explicit taskId link; fall back to the projectId + title pairing the
// rest of the blog code already relies on, so rows created before `taskId` existed
// still match (and get linked on the way past).
async function findSheetRow(task, title, transaction) {
  const linked = await db.BlogTask.findOne({ where: { taskId: task.id }, transaction });
  if (linked) return linked;
  if (!title) return null;
  const rows = await db.BlogTask.findAll({
    where: { projectId: task.projectId, title },
    order: [['createdAt', 'DESC']],
    transaction,
  });
  return rows.find((r) => OPEN_SHEET_STATUSES.includes(r.status)) || rows[0] || null;
}

// The work handed back, as opposed to a brief from the assigner or a file dropped
// on a "send back for changes" note. Same filter as TaskService#_hasDeliverable
// and the Task Detail page's own `deliverableFiles`.
async function latestDeliverable(taskId, transaction) {
  return db.Artifact.findOne({
    where: {
      taskId,
      isActive: true,
      [Op.or]: [{ kind: null }, { kind: { [Op.notIn]: ['brief', 'review_note'] } }],
    },
    order: [['createdAt', 'DESC']],
    transaction,
  });
}

/**
 * Guarantees the Blogs-tab row for a `blog_post` Task exists and is linked to it,
 * creating a draft row for tasks that arrived without one. Also backfills the
 * Task's `pageName`, which is the key every other blog routine matches on.
 * No-op for any other task type.
 */
async function ensureSheetRowForTask(task, actorUserId = null, transaction = null) {
  if (!task || task.type !== 'blog_post') return null;
  const title = sheetTitleForTask(task);
  if (!title) return null;

  let bt = await findSheetRow(task, title, transaction);
  if (!bt) {
    bt = await db.BlogTask.create({
      projectId: task.projectId,
      taskId: task.id,
      title,
      status: 'draft',
      assignedWriterId: task.assigneeId || null,
      createdBy: task.createdBy || actorUserId || null,
      sortOrder: await nextSortOrder(task.projectId, transaction),
    }, { transaction });
  } else {
    const patch = {};
    if (!bt.taskId) patch.taskId = task.id;
    if (!bt.assignedWriterId && task.assigneeId) patch.assignedWriterId = task.assigneeId;
    if (Object.keys(patch).length) await bt.update(patch, { transaction });
  }

  if (!task.pageName) await task.update({ pageName: title }, { transaction });

  return bt;
}

/**
 * Mirrors a blog Task onto its sheet row: the latest deliverable's file, and the
 * matching sheet status for the task status being moved to. Called on every
 * blog_post transition and whenever a deliverable is uploaded against one, so the
 * Blogs tab shows the attachment as soon as it is attached rather than only after
 * a submit that came through the Blogs tab itself.
 *
 * `taskStatus` is the status being transitioned *to* — pass it explicitly when
 * calling mid-transaction, before the row has been written.
 */
async function syncFromTask(task, {
  actorUserId = null, taskStatus = null, note = null, transaction = null,
} = {}) {
  if (!task) return null;
  if (task.type === 'blog_image') return syncDesignFromTask(task, transaction);
  if (task.type !== 'blog_post') return null;
  const bt = await ensureSheetRowForTask(task, actorUserId, transaction);
  if (!bt) return null;

  const patch = {};

  const deliverable = await latestDeliverable(task.id, transaction);
  if (deliverable && deliverable.fileUrl && deliverable.fileUrl !== bt.fileUrl) {
    patch.fileUrl = deliverable.fileUrl;
    patch.fileName = deliverable.fileName || null;
  }

  const nextStatus = SHEET_STATUS_BY_TASK_STATUS[taskStatus || task.status] || null;
  // An approved row is terminal on the sheet — only another approve can touch it.
  const canChangeStatus = nextStatus
    && nextStatus !== bt.status
    && !(bt.status === 'approved' && nextStatus !== 'approved');
  if (canChangeStatus) {
    patch.status = nextStatus;
    if (nextStatus === 'pending') {
      patch.submittedBy = actorUserId || task.assigneeId || bt.submittedBy;
      patch.rejectionReason = null;
      patch.reviewedBy = null;
      patch.reviewedAt = null;
    } else {
      patch.reviewedBy = actorUserId || bt.reviewedBy;
      patch.reviewedAt = new Date();
      patch.rejectionReason = nextStatus === 'rejected' ? (note || bt.rejectionReason) : null;
    }
  }

  if (Object.keys(patch).length) await bt.update(patch, { transaction });
  return bt;
}

/**
 * Design counterpart to syncFromTask above: mirrors the designer's latest
 * deliverable onto BlogTask.designFileUrl/designFileName whenever a file is
 * attached and submitted from the Task Detail page's own Deliverable panel,
 * same "second fully-supported path" reasoning as the writer's copy — without
 * this, a design submitted there never reached the Blogs tab's Design File
 * column (only SeoService#submitBlogDesign's own sheet-card path did).
 *
 * Unlike the writer's half, this never touches `status` — the row's approve/
 * reject lifecycle belongs to the copy, not the illustration, and a
 * blog_image Task is never an orphan (ensureBlogImageTask always sets
 * pageName and only ever creates one once the row is already 'approved'), so
 * there's no ensure-row-exists step here either.
 */
async function syncDesignFromTask(task, transaction = null) {
  const title = sheetTitleForTask(task);
  if (!title) return null;

  const rows = await db.BlogTask.findAll({
    where: { projectId: task.projectId, title },
    order: [['createdAt', 'DESC']],
    transaction,
  });
  const bt = rows.find((r) => r.assignedDesignerId === task.assigneeId) || rows[0] || null;
  if (!bt) return null;

  const deliverable = await latestDeliverable(task.id, transaction);
  if (deliverable && deliverable.fileUrl && deliverable.fileUrl !== bt.designFileUrl) {
    await bt.update({ designFileUrl: deliverable.fileUrl, designFileName: deliverable.fileName || null }, { transaction });
  }
  return bt;
}

module.exports = { ensureSheetRowForTask, syncFromTask, sheetTitleForTask };
