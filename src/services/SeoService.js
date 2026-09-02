const xlsx = require('xlsx');
const { Op } = require('sequelize');
const { Keyword, KeywordBatch, SupportingKeyword, SupportingKeywordRanking, Backlink, ContentSubmission, BlogTask, RankSnapshot, Project, Client, WhiteLabelConfig, Task, Artifact, User, Role, Stage, ProjectAssignment } = require('../models');
const {
  createPdfBuffer, drawTable, drawFooter, drawReportFooter, drawStatCards, drawPill, BRAND_COLOR,
} = require('./PdfService');
const {
  letterheadForOrg, loadLetterheadLogo, drawPdfKitLetterhead,
  normalizeLetterheadFields, filterLetterheadFields, letterheadShowsLogo,
} = require('./letterhead');
const TaskService = require('./TaskService');
const NotificationService = require('./NotificationService');
const { performAction } = require('../workflow/engine');

function assertProjectAccess(projectId, orgId) {
  return Project.findOne({ where: { id: projectId, orgId } }).then((p) => {
    if (!p) throw Object.assign(new Error('Project not found'), { status: 404 });
    return p;
  });
}

function normName(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * The calendar day a Date falls on *where the server lives*, as "YYYY-MM-DD".
 *
 * Every date this file writes — a backlink's publish date, a rank snapshot's
 * report date — lands in a Sequelize DATEONLY column. Those hold a calendar
 * date with no time and no timezone, so the value written must be the day a
 * person would have written down, never that day pushed through UTC.
 *
 * `toISOString().slice(0, 10)` is exactly that push and must not be used on
 * these: it reads the *UTC* day, which on a UTC+n server (this one runs
 * Asia/Karachi) is the previous day for anything before 05:00 local — and for
 * a Date at local midnight, which is what `xlsx` hands back for a date cell,
 * it is *always* the previous day. That is how sheet imports silently landed
 * a day early. Read the local Y/M/D components instead.
 */
function localDateParts(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function cell(row, ...keys) {
  for (const key of keys) {
    if (row[key] != null && String(row[key]).trim() !== '') return row[key];
  }
  // Case-insensitive fallback for sheets with odd header casing
  const map = Object.fromEntries(
    Object.entries(row || {}).map(([k, v]) => [String(k).trim().toLowerCase(), v]),
  );
  for (const key of keys) {
    const v = map[String(key).trim().toLowerCase()];
    if (v != null && String(v).trim() !== '') return v;
  }
  return null;
}

// Reads a numeric sheet cell exactly as the file has it.
//
// The old `parseInt(cell(...) || 0, 10) || null` lost real data three ways:
//   • a genuine 0 (KD 0, Volume 0) became null and printed as "—";
//   • the "<10" / "0-10" / "10-100" buckets that Ahrefs and Semrush export for
//     low-volume keywords hit `parseInt("<10") === NaN` and vanished entirely;
//   • abbreviated volumes ("1.2K", "3M") and thousands separators ("1,300")
//     parsed as 1, 3 and 1 respectively.
// Now a leading comparison operator is dropped, a range takes its first bound,
// separators are stripped, K/M suffixes are expanded, and 0 survives.
function sheetNumber(raw) {
  if (raw == null) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? Math.round(raw) : null;

  let s = String(raw).trim();
  if (!s || s === '-' || s === '—' || s === 'n/a' || s.toLowerCase() === 'na') return null;

  s = s.replace(/^[<>~≈≤≥]+\s*/, '');            // "<10" → "10"
  s = s.split(/\s*[-–—]\s*/)[0] || s;             // "10-100" → "10"
  s = s.replace(/,/g, '').replace(/\s+/g, '');    // "1,300" → "1300"

  const match = s.match(/^(\d+(?:\.\d+)?)([kKmM]?)/);
  if (!match) return null;
  const value = parseFloat(match[1]);
  if (!Number.isFinite(value)) return null;
  const multiplier = match[2].toLowerCase() === 'k' ? 1000 : match[2].toLowerCase() === 'm' ? 1000000 : 1;
  return Math.round(value * multiplier);
}

// "Secondary Keywords" sheet/form cells don't reliably arrive comma-separated —
// keyword-research tools (Ahrefs, Semrush, …) commonly export a "Related
// keywords" list as one bullet-prefixed entry per line, and pasting that into
// Excel keeps the line breaks and bullet glyphs as-is. The frontend list view
// already tolerates this (see parseKeywordList's `/[\n,;]+/` split); this is
// the same normalization for anywhere the string is stored or printed —
// PDFKit's standard fonts only support the WinAnsi/Latin-1 glyph range, so an
// un-normalized bullet or smart-typography character comes out as a garbled
// "Ð" per line in the PDF report instead of erroring loudly.
function normalizeKeywordList(raw) {
  if (!raw) return null;
  const BULLET_PREFIX = /^[\s\u2022\u25CF\u25E6\u2023\u2043\u00B7*\-\u2013\u2014]+/;
  const NOT_WINANSI = /[^\x20-\x7E\u00A0-\u00FF]/g;
  const items = String(raw)
    .split(/[\n\r,;]+/)
    .map((s) => s.replace(BULLET_PREFIX, '').replace(NOT_WINANSI, '').trim())
    .filter(Boolean);
  return items.length ? items.join(', ') : null;
}

async function ensureContentTask(orgId, project, pageName, assigneeId, actorUserId) {
  if (!assigneeId || !pageName) return;
  const existing = await Task.findOne({
    where: {
      projectId: project.id,
      type: 'content',
      pageName,
      assigneeId,
      status: { [Op.notIn]: ['done', 'approved'] },
    },
  });
  if (existing) return;
  await TaskService.create(orgId, project.id, {
    type: 'content',
    title: `Write content — ${pageName}`,
    assigneeId,
    pageName,
    stageKey: project.currentStageKey,
  }, actorUserId);
}

/** Same pipeline as content — blog sheet rows get a writer Task (type blog_post). */
async function ensureBlogTask(orgId, project, title, assigneeId, actorUserId) {
  if (!assigneeId || !title) return;
  const existing = await Task.findOne({
    where: {
      projectId: project.id,
      type: 'blog_post',
      pageName: title,
      assigneeId,
      status: { [Op.notIn]: ['done', 'approved'] },
    },
  });
  if (existing) return existing;
  return TaskService.create(orgId, project.id, {
    type: 'blog_post',
    title: `Write blog — ${title}`,
    assigneeId,
    pageName: title,
    stageKey: project.currentStageKey,
  }, actorUserId);
}

/** Same pipeline, for the designer who illustrates an already-approved blog. */
async function ensureBlogImageTask(orgId, project, title, assigneeId, actorUserId) {
  if (!assigneeId || !title) return;
  const existing = await Task.findOne({
    where: {
      projectId: project.id,
      type: 'blog_image',
      pageName: title,
      assigneeId,
      status: { [Op.notIn]: ['done', 'approved'] },
    },
  });
  if (existing) return existing;
  return TaskService.create(orgId, project.id, {
    type: 'blog_image',
    title: `Design blog image — ${title}`,
    assigneeId,
    pageName: title,
    stageKey: project.currentStageKey,
  }, actorUserId);
}

/**
 * Mirrors a sheet-submitted deliverable onto the writer's Task as an Artifact, so
 * the Task Detail page's Deliverable panel and the Blogs tab's File column always
 * show the same thing. Idempotent — resubmitting the same URL doesn't duplicate.
 * A pasted link is stored as kind 'link' (fileName "Link"), matching /media/link.
 */
async function ensureTaskDeliverableArtifact(task, fileUrl, fileName, uploadedBy) {
  if (!task?.id || !fileUrl) return null;
  const existing = await Artifact.findOne({ where: { taskId: task.id, fileUrl } });
  if (existing) {
    if (!existing.isActive) await existing.update({ isActive: true });
    return existing;
  }
  return Artifact.create({
    projectId: task.projectId,
    taskId: task.id,
    stageKey: task.stageKey || 'general',
    fileUrl,
    fileName: fileName || null,
    kind: fileName === 'Link' ? 'link' : null,
    uploadedBy,
  });
}

async function markBlogTasksSubmitted(orgId, projectId, title, assigneeId, actorUserId) {
  if (!assigneeId || !title) return;
  const openTasks = await Task.findAll({
    where: {
      projectId,
      type: 'blog_post',
      pageName: title,
      assigneeId,
      // `accepted` included too — a writer who clicked Accept on the task first
      // and then submitted from the Blogs tab was otherwise skipped here, leaving
      // their task stuck while the sheet row moved to In review.
      status: { [Op.in]: ['todo', 'accepted', 'in_progress', 'rejected'] },
    },
  });
  for (const task of openTasks) {
    try {
      if (task.status === 'rejected') {
        await TaskService.transition(task.id, orgId, 'in_progress', { id: actorUserId }, null, 'Blog resubmitted.');
      }
      await TaskService.transition(task.id, orgId, 'submitted', { id: actorUserId }, null, 'Blog submitted.');
    } catch (err) {
      console.error('[SeoService] Failed to mark blog task submitted:', err.message);
    }
  }
}

// Name → userId map for resolving a sheet's "Writer" column, restricted to the
// same role pool the matching UI dropdown offers. Shared by the keyword and
// backlink imports so a name that resolves in one resolves in the other.
async function buildWriterLookup(orgId, roleKeys) {
  const users = await User.findAll({
    where: { orgId, isActive: true },
    include: [{ model: Role, as: 'role', attributes: [], where: { key: roleKeys } }],
    attributes: ['id', 'name'],
  });
  const byName = new Map();
  for (const u of users) {
    const key = normName(u.name);
    if (key && !byName.has(key)) byName.set(key, u.id);
  }
  return byName;
}

async function nextSortOrder(Model, projectId) {
  const max = await Model.max('sortOrder', { where: { projectId } });
  return (Number.isFinite(max) ? max : -1) + 1;
}

const SHEET_ORDER = [['sortOrder', 'ASC'], ['createdAt', 'ASC']];

// Backlinks tab wants the opposite feel from the rest of the SEO sheets: newest
// activity on top rather than sheet-import order. Primary sort is createdAt
// DESC so the latest add (single or imported) always lands first; secondary
// sortOrder ASC keeps rows from the same bulk import in their original sheet
// order relative to each other, since a bulkCreate batch shares ~the same
// createdAt.
const BACKLINK_ORDER = [['createdAt', 'DESC'], ['sortOrder', 'ASC']];

// ─── Keywords ─────────────────────────────────────────────────────────────────

// Deactivated ("deleted") rows are hidden unless the caller opts in with
// includeInactive — see services/SoftDeleteService.js.
async function listKeywords(projectId, orgId, { includeInactive = false } = {}) {
  await assertProjectAccess(projectId, orgId);
  return Keyword.findAll({
    where: { projectId, ...(includeInactive ? {} : { status: 'active' }) },
    include: [
      { association: 'assignedWriter', attributes: ['id', 'name'] },
      // Pending/rejected rows still show on the sheet (transparency) — the
      // frontend reads approvalStatus for the badge and this for the reason.
      { association: 'batch', attributes: ['id', 'status', 'fileName', 'rejectionReason'] },
    ],
    order: SHEET_ORDER,
  });
}

function normalizeKeywordStatus(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (['inactive', 'off', 'disabled', 'paused'].includes(v)) return 'inactive';
  if (['active', 'on', 'enabled'].includes(v) || !v) return 'active';
  return null;
}

async function createKeyword(data, orgId) {
  const project = await assertProjectAccess(data.projectId, orgId);
  const sortOrder = data.sortOrder != null ? data.sortOrder : await nextSortOrder(Keyword, data.projectId);
  const status = normalizeKeywordStatus(data.status) || 'active';
  // A manual single-row add is never batch-gated — batchId/approvalStatus are
  // only ever set by bulkImportKeywords/reviewKeywordBatch, never trusted from
  // a client payload (which otherwise spreads straight through here).
  const kw = await Keyword.create({
    ...data,
    secondaryKeywords: normalizeKeywordList(data.secondaryKeywords),
    batchId: null,
    approvalStatus: 'approved',
    status,
    sortOrder,
  });

  // Assigning a writer at creation time should spin up their content task too,
  // same as assigning one later via updateKeyword or via bulk import.
  if (kw.assignedWriterId) {
    const pageName = kw.pageName || kw.primaryKeyword;
    await ensureContentTask(orgId, project, pageName, kw.assignedWriterId, data.createdBy);
  }
  return kw;
}

// Bulk-imported keywords no longer go live immediately — they land `pending`
// under a new KeywordBatch and sit in the org's Approvals inbox until a
// teammate (not the uploader) or an admin approves or rejects the whole
// sheet at once. See reviewKeywordBatch for the decision side and
// ApprovalService's `keyword_batch` source for how this reaches the inbox.
// Manual single-row adds (createKeyword) are unaffected and stay instant.
async function bulkImportKeywords(projectId, orgId, fileBuffer, createdBy, fileName) {
  const project = await assertProjectAccess(projectId, orgId);
  const wb = xlsx.read(fileBuffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json(ws, { defval: null });

  const writerByName = await buildWriterLookup(orgId, ['content_writer']);

  let sortOrder = await nextSortOrder(Keyword, projectId);
  const records = rows.map((row) => {
    const primaryKeyword = String(cell(row, 'Keyword', 'Primary Keyword') || '').trim();
    if (!primaryKeyword) return null;

    const writerName = cell(row, 'Writer', 'Assigned Writer', 'Content Writer', 'Assignee');
    const assignedWriterId = writerName ? (writerByName.get(normName(writerName)) || null) : null;

    const record = {
      projectId,
      primaryKeyword,
      secondaryKeywords: normalizeKeywordList(cell(row, 'Secondary Keywords', 'secondary_keywords')),
      kd: sheetNumber(cell(row, 'KD', 'kd')),
      volume: sheetNumber(cell(row, 'Volume', 'volume', 'Search Volume', 'Vol')),
      targetUrl: cell(row, 'URL', 'Target URL', 'url') || null,
      targetLocation: cell(row, 'Target Location', 'target_location', 'Location') || null,
      pageName: cell(row, 'Page', 'Page Name', 'Target Page') || null,
      status: normalizeKeywordStatus(cell(row, 'Status', 'status')) || 'active',
      assignedWriterId,
      createdBy,
      sortOrder,
    };
    sortOrder += 1;
    return record;
  }).filter(Boolean);

  if (!records.length) {
    const err = new Error('No valid rows found — make sure the sheet has a "Keyword" column.');
    err.status = 400;
    throw err;
  }

  const batch = await KeywordBatch.create({
    projectId,
    fileName: fileName || null,
    rowCount: records.length,
    submittedBy: createdBy,
    status: 'pending',
  });

  const created = await Keyword.bulkCreate(
    records.map((rec) => ({ ...rec, batchId: batch.id, approvalStatus: 'pending' })),
    { validate: true },
  );

  // Content tasks (and the writer's "your work" view) only make sense once the
  // sheet is actually live — deferred to reviewKeywordBatch on approval.
  return { batch, created };
}

/**
 * Approve or reject an entire bulk keyword upload. Approving cascades
 * approvalStatus: 'approved' onto every keyword the batch created and, only
 * now, spins up the content tasks a writer assignment on the sheet implied.
 * Rejecting requires a reason and flips the same rows to 'rejected' — they
 * stay on the sheet (soft, not deleted) so the uploader can see why and
 * re-import a corrected sheet.
 */
async function reviewKeywordBatch(batchId, updates, orgId, reviewer) {
  const batch = await KeywordBatch.findOne({
    where: { id: batchId },
    include: [{ model: Project, as: 'project', where: { orgId }, attributes: ['id', 'currentStageKey'] }],
  });
  if (!batch) throw Object.assign(new Error('Keyword batch not found'), { status: 404 });
  if (batch.status !== 'pending') {
    throw Object.assign(new Error('This upload has already been decided.'), { status: 400 });
  }
  // Self-approval is blocked as a maker-checker control — except for
  // admins/super_admins, who are still the only one able to sign off when
  // they're also the one who uploaded the sheet.
  const reviewerIsAdmin = ['super_admin', 'admin'].includes(reviewer?.role?.key);
  if (batch.submittedBy === reviewer?.id && !reviewerIsAdmin) {
    throw Object.assign(new Error('You cannot approve your own upload.'), { status: 403 });
  }

  const status = updates?.status === 'approved' ? 'approved' : 'rejected';
  if (status === 'rejected' && !String(updates?.rejectionReason || '').trim()) {
    throw Object.assign(new Error('Tell the uploader why this was rejected.'), { status: 400 });
  }

  await batch.update({
    status,
    rejectionReason: status === 'rejected' ? updates.rejectionReason : null,
    reviewedBy: reviewer?.id || null,
    reviewedAt: new Date(),
  });

  await Keyword.update(
    { approvalStatus: status, ...(status === 'rejected' ? { status: 'inactive' } : {}) },
    { where: { batchId: batch.id } },
  );

  if (status === 'approved') {
    const rows = await Keyword.findAll({
      where: { batchId: batch.id, assignedWriterId: { [Op.ne]: null } },
      attributes: ['pageName', 'primaryKeyword', 'assignedWriterId'],
    });
    const taskKeys = new Set();
    for (const rec of rows) {
      const pageName = rec.pageName || rec.primaryKeyword;
      const key = `${rec.assignedWriterId}::${pageName}`;
      if (taskKeys.has(key)) continue;
      taskKeys.add(key);
      await ensureContentTask(orgId, batch.project, pageName, rec.assignedWriterId, reviewer?.id);
    }
  }

  return batch;
}

async function updateKeyword(id, updates, orgId, actor) {
  const kw = await Keyword.findOne({
    where: { id },
    include: [{ model: Project, as: 'project', where: { orgId }, attributes: ['id', 'currentStageKey'] }],
  });
  if (!kw) throw Object.assign(new Error('Keyword not found'), { status: 404 });

  const patch = { ...updates };
  // approvalStatus/batchId only ever change via reviewKeywordBatch — never
  // trust them from a PATCH body (that's how a pending row would self-approve).
  delete patch.approvalStatus;
  delete patch.batchId;
  if (Object.prototype.hasOwnProperty.call(patch, 'status')) {
    // Active/Inactive is admin-only — same boundary as delete and the bulk
    // sheet actions (see deleteKeyword). A non-admin can still add keywords
    // and assign writers, just not change what's live.
    const isManager = ['super_admin', 'admin'].includes(actor?.role?.key)
      || !!actor?.role?.permissions?.['projects.manage'];
    if (!isManager) {
      throw Object.assign(new Error('Only an administrator can change a keyword\'s Active/Inactive status.'), { status: 403 });
    }
    const normalized = normalizeKeywordStatus(patch.status);
    if (!normalized) {
      throw Object.assign(new Error('Status must be "active" or "inactive".'), { status: 400 });
    }
    patch.status = normalized;
  }

  const assigningWriter = patch.assignedWriterId && patch.assignedWriterId !== kw.assignedWriterId;
  await kw.update(patch);

  // Assigning a writer spins up their content-writing task for this page — unless
  // they already have one open for it (re-assigning the same page's other keywords
  // to the same writer shouldn't spam duplicate tasks). Skipped while the keyword
  // is still pending its own upload approval — reviewKeywordBatch creates the task
  // once (and only if) the batch is approved, using whatever writer is set then.
  if (assigningWriter && kw.approvalStatus === 'approved') {
    const pageName = kw.pageName || kw.primaryKeyword;
    await ensureContentTask(orgId, kw.project, pageName, patch.assignedWriterId, actor?.id);
  }
  return kw;
}

// A keyword is "locked" once it's handed to a writer or its content is
// approved — used to protect the non-destructive bulk deactivate actions
// (clearKeywords, bulkDeactivateKeywords) from pulling work out from under a
// writer mid-flight. Deletion itself is admin-only and, being permanent and
// deliberate, is not subject to this lock — an admin can delete any keyword.
async function lockedKeywordIdSet(projectId) {
  const [assigned, submissions] = await Promise.all([
    Keyword.findAll({ where: { projectId, assignedWriterId: { [Op.ne]: null } }, attributes: ['id'] }),
    ContentSubmission.findAll({
      where: { projectId },
      attributes: ['keywordIds', 'status', 'pageName', 'submittedBy', 'createdAt', 'revisionNumber'],
      order: [['createdAt', 'DESC'], ['revisionNumber', 'DESC']],
    }),
  ]);
  const ids = new Set(assigned.map((k) => k.id));
  const seen = new Set();
  for (const cs of submissions) {
    if (cs.status === 'superseded') continue;
    const key = `${cs.pageName || ''}::${cs.submittedBy || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (cs.status !== 'approved') continue;
    for (const kid of cs.keywordIds || []) ids.add(kid);
  }
  return ids;
}

/**
 * Permanently deletes a single keyword — real removal, not a status flip.
 * Its rank-history rows (RankSnapshot) are destroyed first since the DB has a
 * real foreign key from rank_snapshots.keywordId to keywords.id, which would
 * otherwise reject the delete.
 *
 * Admin-only, full stop — a regular project.act user can add keywords and
 * assign writers, but deleting (and, see updateKeyword, flipping active/
 * inactive) is reserved for super_admin/admin, same as the bulk sheet
 * actions below. The route also carries `adminOnly`; this is the backstop.
 */
async function deleteKeyword(id, orgId, actor) {
  const kw = await Keyword.findOne({
    where: { id },
    include: [{ model: Project, as: 'project', where: { orgId }, attributes: [] }],
  });
  if (!kw) throw Object.assign(new Error('Keyword not found'), { status: 404 });

  const isManager = ['super_admin', 'admin'].includes(actor?.role?.key)
    || !!actor?.role?.permissions?.['projects.manage'];
  if (!isManager) {
    throw Object.assign(new Error('Only an administrator can delete a keyword.'), { status: 403 });
  }
  await RankSnapshot.destroy({ where: { keywordId: kw.id } });
  await kw.destroy();
  return kw;
}

/** Non-destructive: sets every eligible active keyword on the sheet to Inactive — assigned or approved-content keywords are kept as-is. */
async function clearKeywords(projectId, orgId) {
  await assertProjectAccess(projectId, orgId);
  const protectedIds = await lockedKeywordIdSet(projectId);
  const keywords = await Keyword.findAll({ where: { projectId, status: 'active' }, attributes: ['id'] });
  const deactivatableIds = keywords.map((k) => k.id).filter((id) => !protectedIds.has(id));
  if (deactivatableIds.length) {
    await Keyword.update({ status: 'inactive' }, { where: { id: deactivatableIds, projectId } });
  }
  return { deleted: deactivatableIds.length, deactivated: deactivatableIds.length, kept: protectedIds.size };
}

async function bulkDeleteKeywords(projectId, orgId, ids) {
  await assertProjectAccess(projectId, orgId);
  const idList = Array.isArray(ids) ? [...new Set(ids.filter(Boolean))] : [];
  if (!idList.length) {
    throw Object.assign(new Error('No keyword IDs provided.'), { status: 400 });
  }
  if (idList.length > 200) {
    throw Object.assign(new Error('You can change at most 200 keywords at a time.'), { status: 400 });
  }

  const rows = await Keyword.findAll({
    where: { id: idList, projectId },
    attributes: ['id'],
  });
  const found = new Set(rows.map((r) => r.id));
  const deleted = [];
  const skipped = [];

  for (const id of idList) {
    if (!found.has(id)) {
      skipped.push({ id, reason: 'not_found' });
      continue;
    }
    deleted.push(id);
  }

  if (deleted.length) {
    await RankSnapshot.destroy({ where: { keywordId: deleted } });
    await Keyword.destroy({ where: { id: deleted, projectId } });
  }
  return { deleted: deleted.length, deactivated: deleted.length, skipped };
}

/**
 * Bulk reactivate keywords — the counterpart to bulkDeleteKeywords. Unlike
 * deactivation, there's no lock check: putting an already-inactive keyword
 * back in the pool can't orphan anything, so any keyword on the project can
 * be reactivated.
 */
async function bulkActivateKeywords(projectId, orgId, ids) {
  await assertProjectAccess(projectId, orgId);
  const idList = Array.isArray(ids) ? [...new Set(ids.filter(Boolean))] : [];
  if (!idList.length) {
    throw Object.assign(new Error('No keyword IDs provided.'), { status: 400 });
  }
  if (idList.length > 200) {
    throw Object.assign(new Error('You can change at most 200 keywords at a time.'), { status: 400 });
  }

  const rows = await Keyword.findAll({ where: { id: idList, projectId }, attributes: ['id'] });
  const found = rows.map((r) => r.id);
  if (found.length) {
    await Keyword.update({ status: 'active' }, { where: { id: found, projectId } });
  }
  const skipped = idList.filter((id) => !found.includes(id)).map((id) => ({ id, reason: 'not_found' }));
  return { activated: found.length, skipped };
}

/**
 * Non-destructive: sets selected keywords to Inactive (a status flip, not a
 * delete) — the reversible counterpart to bulkActivateKeywords, and a
 * separate action from bulkDeleteKeywords now that "delete" really deletes.
 * Same lock check as delete: assigned/approved keywords are skipped so a
 * bulk action can't silently pull one out of a writer's active pool.
 */
async function bulkDeactivateKeywords(projectId, orgId, ids) {
  await assertProjectAccess(projectId, orgId);
  const idList = Array.isArray(ids) ? [...new Set(ids.filter(Boolean))] : [];
  if (!idList.length) {
    throw Object.assign(new Error('No keyword IDs provided.'), { status: 400 });
  }
  if (idList.length > 200) {
    throw Object.assign(new Error('You can change at most 200 keywords at a time.'), { status: 400 });
  }

  const protectedIds = await lockedKeywordIdSet(projectId);
  const rows = await Keyword.findAll({ where: { id: idList, projectId }, attributes: ['id'] });
  const found = new Set(rows.map((r) => r.id));
  const deactivated = [];
  const skipped = [];

  for (const id of idList) {
    if (!found.has(id)) { skipped.push({ id, reason: 'not_found' }); continue; }
    if (protectedIds.has(id)) { skipped.push({ id, reason: 'assigned_or_approved' }); continue; }
    deactivated.push(id);
  }

  if (deactivated.length) {
    await Keyword.update({ status: 'inactive' }, { where: { id: deactivated, projectId } });
  }
  return { deactivated: deactivated.length, skipped };
}

// ─── Rank Snapshots ───────────────────────────────────────────────────────────

function todayDateOnly() {
  return localDateParts(new Date());
}

// `orgId` and `projectId` are NOT NULL on rank_snapshots but were never being
// set here, so every write through this path failed at the DB. Both are read
// off the keyword's own project.
async function addRankSnapshot(keywordId, position, checkedAt, orgId) {
  const kw = await Keyword.findOne({
    where: { id: keywordId },
    include: [{ model: Project, as: 'project', where: { orgId }, attributes: ['id'] }],
  });
  if (!kw) throw Object.assign(new Error('Keyword not found'), { status: 404 });
  return upsertRankSnapshot({
    orgId,
    projectId: kw.projectId,
    keywordId,
    date: toDateOnlyString(checkedAt) || todayDateOnly(),
    position,
  });
}

function toDateOnlyString(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  if (value instanceof Date && !Number.isNaN(value.getTime())) return localDateParts(value);
  return null;
}

// One position per keyword per date per engine — re-recording the same report
// date corrects the existing row rather than stacking duplicates, so a typo can
// simply be re-entered.
async function upsertRankSnapshot({ orgId, projectId, keywordId, date, position, url, searchEngine = 'google' }) {
  const where = { projectId, keywordId, date, searchEngine };
  const existing = await RankSnapshot.findOne({ where });
  if (existing) {
    await existing.update({ position, ...(url !== undefined ? { url } : {}) });
    return existing;
  }
  return RankSnapshot.create({ orgId, projectId, keywordId, date, position, url, searchEngine });
}

// ─── Monthly Reporting ────────────────────────────────────────────────────────
//
// The Monthly Report stage needs a rank-tracking grid: every active keyword down
// the side, every date the project was checked across the top, and the position
// recorded in each cell. Returns exactly that, plus the movement between the two
// most recent report dates so a strategist can see at a glance what improved.

async function listRankings(projectId, orgId, { from, to } = {}) {
  await assertProjectAccess(projectId, orgId);

  const where = { projectId };
  if (from && to) where.date = { [Op.between]: [String(from).slice(0, 10), String(to).slice(0, 10)] };
  else if (from) where.date = { [Op.gte]: String(from).slice(0, 10) };
  else if (to) where.date = { [Op.lte]: String(to).slice(0, 10) };

  const [keywords, snapshots] = await Promise.all([
    Keyword.findAll({
      where: { projectId, status: 'active', approvalStatus: 'approved' },
      attributes: ['id', 'primaryKeyword', 'pageName', 'targetUrl', 'volume', 'kd'],
      order: SHEET_ORDER,
    }),
    RankSnapshot.findAll({ where, order: [['date', 'ASC']] }),
  ]);

  const dates = [...new Set(snapshots.map((s) => String(s.date).slice(0, 10)))].sort();
  const byKeyword = new Map();
  for (const s of snapshots) {
    if (!byKeyword.has(s.keywordId)) byKeyword.set(s.keywordId, {});
    byKeyword.get(s.keywordId)[String(s.date).slice(0, 10)] = s.position;
  }

  const latest = dates[dates.length - 1] || null;
  const previous = dates[dates.length - 2] || null;

  const rows = keywords.map((k) => {
    const positions = byKeyword.get(k.id) || {};
    const latestPos = latest != null ? (positions[latest] ?? null) : null;
    const prevPos = previous != null ? (positions[previous] ?? null) : null;
    return {
      keywordId: k.id,
      primaryKeyword: k.primaryKeyword,
      pageName: k.pageName,
      targetUrl: k.targetUrl,
      volume: k.volume,
      kd: k.kd,
      positions,
      latestPosition: latestPos,
      previousPosition: prevPos,
      // Positive = moved up the results (rank number got smaller).
      change: latestPos != null && prevPos != null ? prevPos - latestPos : null,
    };
  });

  return { dates, rows, latestDate: latest, previousDate: previous };
}

/**
 * Records one report date's positions in a single call:
 *   { date, entries: [{ keywordId, position, url? }] }
 * A null/blank position means "not ranking on this date" and is stored as such
 * (rather than skipped), so the grid can distinguish "checked, not found" from
 * "never checked".
 */
async function recordRankings(projectId, orgId, { date, entries, searchEngine = 'google' }) {
  await assertProjectAccess(projectId, orgId);

  const day = toDateOnlyString(date) || todayDateOnly();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw Object.assign(new Error('A valid report date (YYYY-MM-DD) is required.'), { status: 400 });
  }
  const list = Array.isArray(entries) ? entries : [];
  if (!list.length) {
    throw Object.assign(new Error('No rankings provided.'), { status: 400 });
  }

  // Only keywords that actually belong to this project may be written to.
  const valid = new Set(
    (await Keyword.findAll({ where: { projectId }, attributes: ['id'] })).map((k) => k.id)
  );

  let saved = 0;
  for (const entry of list) {
    if (!valid.has(entry.keywordId)) continue;
    const raw = entry.position;
    const position = raw === '' || raw == null ? null : parseInt(raw, 10);
    if (position != null && (Number.isNaN(position) || position < 0)) {
      throw Object.assign(
        new Error(`Position must be a positive number (got "${raw}").`), { status: 400 }
      );
    }
    await upsertRankSnapshot({
      orgId, projectId, keywordId: entry.keywordId, date: day, position,
      url: entry.url ?? undefined, searchEngine,
    });
    saved += 1;
  }
  return { date: day, saved };
}

/** Removes one whole report date — used to undo a mis-dated entry. */
async function deleteRankingDate(projectId, orgId, date) {
  await assertProjectAccess(projectId, orgId);
  const day = toDateOnlyString(date);
  if (!day) throw Object.assign(new Error('A report date is required.'), { status: 400 });
  const deleted = await RankSnapshot.destroy({ where: { projectId, date: day } });
  return { date: day, deleted };
}

// ─── Supporting Keyword Rankings ───────────────────────────────────────────────
//
// Keyword.secondaryKeywords is a single free-text field (comma/line separated
// phrases) — fine for display, but there's nowhere to hang a per-phrase rank
// position or a "show this one to the client" flag. SupportingKeyword gives
// each phrase a stable row for that; this section keeps those rows in sync
// with the text and records/reads rankings against them, mirroring the main
// listRankings/recordRankings/RankSnapshot pattern above.

function parseSupportingKeywordPhrases(raw) {
  if (!raw) return [];
  return String(raw).split(/[\n\r,;]+/).map((s) => s.trim()).filter(Boolean);
}

// Additive only: a phrase dropped from the text leaves its row (and any
// recorded rankings) exactly where it is rather than deleting it. Existing
// rows are matched by normalized text so re-saving the same phrase — or a
// bulk import re-writing the same keyword — never creates a duplicate.
async function syncSupportingKeywords(keyword) {
  const phrases = parseSupportingKeywordPhrases(keyword.secondaryKeywords);
  if (!phrases.length) return;
  const existing = await SupportingKeyword.findAll({ where: { keywordId: keyword.id } });
  const byNorm = new Set(existing.map((sk) => normName(sk.text)));
  let sortOrder = existing.reduce((max, sk) => Math.max(max, sk.sortOrder ?? -1), -1) + 1;
  for (const phrase of phrases) {
    const key = normName(phrase);
    if (byNorm.has(key)) continue;
    byNorm.add(key);
    await SupportingKeyword.create({
      projectId: keyword.projectId,
      keywordId: keyword.id,
      text: phrase,
      sortOrder: sortOrder++,
    });
  }
}

/**
 * The Monthly Report's Supporting Keywords card: every active/approved main
 * keyword down the side, its supporting phrases nested underneath, each with
 * its own position-by-date grid — same dates/movement shape as listRankings.
 */
async function listSupportingKeywordRankings(projectId, orgId, { from, to } = {}) {
  await assertProjectAccess(projectId, orgId);

  const mainKeywords = await Keyword.findAll({
    where: { projectId, status: 'active', approvalStatus: 'approved' },
    attributes: ['id', 'projectId', 'primaryKeyword', 'secondaryKeywords'],
    order: SHEET_ORDER,
  });

  // Self-healing: picks up phrases added/edited on the keyword since the last
  // sync, so this never needs a one-time backfill for keywords that predate
  // the feature.
  for (const kw of mainKeywords) await syncSupportingKeywords(kw);

  const keywordIds = mainKeywords.map((k) => k.id);
  const supporting = keywordIds.length
    ? await SupportingKeyword.findAll({
        where: { keywordId: keywordIds },
        order: [['sortOrder', 'ASC'], ['createdAt', 'ASC']],
      })
    : [];

  const supportingIds = supporting.map((s) => s.id);
  const where = { supportingKeywordId: supportingIds };
  if (from && to) where.date = { [Op.between]: [String(from).slice(0, 10), String(to).slice(0, 10)] };
  else if (from) where.date = { [Op.gte]: String(from).slice(0, 10) };
  else if (to) where.date = { [Op.lte]: String(to).slice(0, 10) };

  const snapshots = supportingIds.length
    ? await SupportingKeywordRanking.findAll({ where, order: [['date', 'ASC']] })
    : [];

  const dates = [...new Set(snapshots.map((s) => String(s.date).slice(0, 10)))].sort();
  const latest = dates[dates.length - 1] || null;
  const previous = dates[dates.length - 2] || null;

  const positionsById = new Map();
  for (const s of snapshots) {
    if (!positionsById.has(s.supportingKeywordId)) positionsById.set(s.supportingKeywordId, {});
    positionsById.get(s.supportingKeywordId)[String(s.date).slice(0, 10)] = s.position;
  }

  const supportingByKeyword = new Map();
  for (const sk of supporting) {
    if (!supportingByKeyword.has(sk.keywordId)) supportingByKeyword.set(sk.keywordId, []);
    const positions = positionsById.get(sk.id) || {};
    const latestPos = latest != null ? (positions[latest] ?? null) : null;
    const prevPos = previous != null ? (positions[previous] ?? null) : null;
    supportingByKeyword.get(sk.keywordId).push({
      id: sk.id,
      text: sk.text,
      showToClient: sk.showToClient,
      positions,
      latestPosition: latestPos,
      previousPosition: prevPos,
      change: latestPos != null && prevPos != null ? prevPos - latestPos : null,
    });
  }

  const rows = mainKeywords.map((k) => ({
    keywordId: k.id,
    primaryKeyword: k.primaryKeyword,
    supportingKeywords: supportingByKeyword.get(k.id) || [],
  }));

  return { dates, rows, latestDate: latest, previousDate: previous };
}

/**
 * Records one report date's positions for supporting keywords —
 * { date, entries: [{ supportingKeywordId, position }] }, same semantics as
 * recordRankings (null/blank position = "checked, not ranking").
 */
async function recordSupportingKeywordRankings(projectId, orgId, { date, entries }) {
  await assertProjectAccess(projectId, orgId);

  const day = toDateOnlyString(date) || todayDateOnly();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw Object.assign(new Error('A valid report date (YYYY-MM-DD) is required.'), { status: 400 });
  }
  const list = Array.isArray(entries) ? entries : [];
  if (!list.length) {
    throw Object.assign(new Error('No rankings provided.'), { status: 400 });
  }

  const valid = new Set(
    (await SupportingKeyword.findAll({ where: { projectId }, attributes: ['id'] })).map((sk) => sk.id)
  );

  let saved = 0;
  for (const entry of list) {
    if (!valid.has(entry.supportingKeywordId)) continue;
    const raw = entry.position;
    const position = raw === '' || raw == null ? null : parseInt(raw, 10);
    if (position != null && (Number.isNaN(position) || position < 0)) {
      throw Object.assign(
        new Error(`Position must be a positive number (got "${raw}").`), { status: 400 }
      );
    }
    const where = { projectId, supportingKeywordId: entry.supportingKeywordId, date: day, searchEngine: 'google' };
    const existing = await SupportingKeywordRanking.findOne({ where });
    if (existing) await existing.update({ position });
    else {
      await SupportingKeywordRanking.create({
        orgId, projectId, supportingKeywordId: entry.supportingKeywordId, date: day, position, searchEngine: 'google',
      });
    }
    saved += 1;
  }
  return { date: day, saved };
}

/** Toggles the "show to client" flag — the only field a strategist edits directly on a supporting keyword row. */
async function updateSupportingKeyword(id, updates, orgId) {
  const sk = await SupportingKeyword.findOne({
    where: { id },
    include: [{ model: Project, as: 'project', where: { orgId }, attributes: [] }],
  });
  if (!sk) throw Object.assign(new Error('Supporting keyword not found'), { status: 404 });
  if (!Object.prototype.hasOwnProperty.call(updates, 'showToClient')) {
    throw Object.assign(new Error('Nothing to update.'), { status: 400 });
  }
  await sk.update({ showToClient: !!updates.showToClient });
  return sk;
}

/**
 * Imports a report date's positions from a sheet. Matches rows to keywords by
 * the "Keyword" column (case/spacing-insensitive); the report date comes either
 * from a "Date" column per row or from the `date` argument for the whole file.
 */
async function bulkImportRankings(projectId, orgId, fileBuffer, fallbackDate) {
  await assertProjectAccess(projectId, orgId);
  const wb = xlsx.read(fileBuffer, { type: 'buffer', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json(ws, { defval: null });
  if (!rows.length) {
    throw Object.assign(new Error('The file has no data rows.'), { status: 400 });
  }

  const keywords = await Keyword.findAll({ where: { projectId }, attributes: ['id', 'primaryKeyword'] });
  const byName = new Map();
  for (const k of keywords) {
    const key = normName(k.primaryKeyword);
    if (key && !byName.has(key)) byName.set(key, k.id);
  }

  const errors = [];
  const writes = [];
  const unmatched = [];

  rows.forEach((row, index) => {
    const rowNum = index + 2;
    const name = cell(row, 'Keyword', 'Primary Keyword', 'keyword');
    if (!name) {
      if (rowHasData(row)) errors.push(`Row ${rowNum}: "Keyword" is required.`);
      return;
    }
    const keywordId = byName.get(normName(name));
    if (!keywordId) { unmatched.push(String(name).trim()); return; }

    const dateCell = cell(row, 'Date', 'Report Date', 'date');
    let day = toDateOnlyString(fallbackDate);
    if (dateCell != null) {
      const parsed = parseSheetDate(dateCell);
      if (parsed.error) { errors.push(`Row ${rowNum}: Date — ${parsed.error}.`); return; }
      day = parsed.value || day;
    }
    if (!day) { errors.push(`Row ${rowNum}: no report date — add a "Date" column or pick one above.`); return; }

    const posRaw = cell(row, 'Position', 'Rank', 'position', 'rank');
    const position = posRaw == null ? null : sheetNumber(posRaw);
    writes.push({ keywordId, date: day, position, url: cell(row, 'URL', 'Ranking URL', 'url') || undefined });
  });

  if (errors.length) throw importValidationError(errors);
  if (!writes.length) {
    throw Object.assign(new Error(
      'No rows matched a keyword on this project. Make sure the sheet has a "Keyword" column whose values match the project\'s keywords.'
    ), { status: 400 });
  }

  for (const w of writes) {
    await upsertRankSnapshot({ orgId, projectId, ...w });
  }
  return { imported: writes.length, unmatchedCount: unmatched.length, unmatched: unmatched.slice(0, 20) };
}

// ─── Backlinks ────────────────────────────────────────────────────────────────

async function listBacklinks(projectId, orgId, { includeInactive = false } = {}) {
  await assertProjectAccess(projectId, orgId);
  return Backlink.findAll({
    where: { projectId, ...(includeInactive ? {} : { isActive: true }) },
    include: [{ association: 'assignedWriter', attributes: ['id', 'name'] }],
    order: BACKLINK_ORDER,
  });
}

async function createBacklink(data, orgId) {
  await assertProjectAccess(data.projectId, orgId);
  const sortOrder = data.sortOrder != null ? data.sortOrder : await nextSortOrder(Backlink, data.projectId);
  return Backlink.create({ ...data, sortOrder });
}

async function updateBacklink(id, updates, orgId) {
  const bl = await Backlink.findOne({
    where: { id },
    include: [{ model: Project, as: 'project', where: { orgId }, attributes: [] }],
  });
  if (!bl) throw Object.assign(new Error('Backlink not found'), { status: 404 });
  return bl.update(updates);
}

// Permanently deletes — real removal, not a status flip. Indexed backlinks
// are protected because de-indexing them for real takes time at the search
// engine; deleting the row here doesn't undo that.
async function deleteBacklink(id, orgId) {
  const bl = await Backlink.findOne({
    where: { id },
    include: [{ model: Project, as: 'project', where: { orgId }, attributes: [] }],
  });
  if (!bl) throw Object.assign(new Error('Backlink not found'), { status: 404 });
  if (bl.isIndexed) {
    throw Object.assign(new Error('Indexed backlinks cannot be deleted.'), { status: 400 });
  }
  await bl.destroy();
  return bl;
}

/** Non-destructive: sets every non-indexed backlink to Inactive — indexed rows are kept as-is. */
async function clearBacklinks(projectId, orgId) {
  await assertProjectAccess(projectId, orgId);
  const [deleted] = await Backlink.update(
    { isActive: false },
    { where: { projectId, isIndexed: false, isActive: true } },
  );
  const kept = await Backlink.count({ where: { projectId, isIndexed: true } });
  return { deleted, deactivated: deleted, kept };
}

/**
 * Non-destructive: sets selected backlinks to Inactive (a status flip, not a
 * delete) — a separate action from bulkDeleteBacklinks now that "delete"
 * really deletes. Same indexed-backlink guard as delete.
 */
async function bulkDeactivateBacklinks(projectId, orgId, ids) {
  await assertProjectAccess(projectId, orgId);
  const idList = Array.isArray(ids) ? [...new Set(ids.filter(Boolean))] : [];
  if (!idList.length) {
    throw Object.assign(new Error('No backlink IDs provided.'), { status: 400 });
  }
  if (idList.length > 200) {
    throw Object.assign(new Error('You can change at most 200 backlinks at a time.'), { status: 400 });
  }

  const rows = await Backlink.findAll({ where: { id: idList, projectId }, attributes: ['id', 'isIndexed'] });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const deactivated = [];
  const skipped = [];

  for (const id of idList) {
    const row = byId.get(id);
    if (!row) { skipped.push({ id, reason: 'not_found' }); continue; }
    if (row.isIndexed) { skipped.push({ id, reason: 'indexed' }); continue; }
    deactivated.push(id);
  }

  if (deactivated.length) {
    await Backlink.update({ isActive: false }, { where: { id: deactivated, projectId } });
  }
  return { deactivated: deactivated.length, skipped };
}

async function bulkDeleteBacklinks(projectId, orgId, ids) {
  await assertProjectAccess(projectId, orgId);
  const idList = Array.isArray(ids) ? [...new Set(ids.filter(Boolean))] : [];
  if (!idList.length) {
    throw Object.assign(new Error('No backlink IDs provided.'), { status: 400 });
  }
  if (idList.length > 200) {
    throw Object.assign(new Error('You can change at most 200 backlinks at a time.'), { status: 400 });
  }

  const rows = await Backlink.findAll({
    where: { id: idList, projectId },
    attributes: ['id', 'isIndexed'],
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const deleted = [];
  const skipped = [];

  for (const id of idList) {
    const row = byId.get(id);
    if (!row) {
      skipped.push({ id, reason: 'not_found' });
      continue;
    }
    if (row.isIndexed) {
      skipped.push({ id, reason: 'indexed' });
      continue;
    }
    deleted.push(id);
  }

  if (deleted.length) {
    await Backlink.destroy({ where: { id: deleted, projectId } });
  }
  return { deleted: deleted.length, deactivated: deleted.length, skipped };
}

const LINK_TYPE_VALUES = ['dofollow', 'nofollow', 'other'];
function normalizeLinkType(raw) {
  const v = String(raw || '').trim().toLowerCase();
  return LINK_TYPE_VALUES.includes(v) ? v : 'other';
}
function normalizeIndexed(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  return ['yes', 'y', 'true', '1', 'indexed'].includes(v);
}

/** Convert Excel serials / Date objects / common strings into YYYY-MM-DD, or an error string. */
function parseSheetDate(raw) {
  if (raw == null || raw === '') return { value: null };
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    return { value: localDateParts(raw) };
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const parsed = xlsx.SSF?.parse_date_code?.(raw);
    if (parsed?.y) {
      return {
        value: `${parsed.y}-${String(parsed.m).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`,
      };
    }
    return { error: `invalid Excel date value "${raw}"` };
  }
  const s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return { value: s.slice(0, 10) };
  // DD/MM/YYYY or DD-MM-YYYY
  const dmy = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (dmy) {
    const day = Number(dmy[1]);
    const month = Number(dmy[2]);
    const year = Number(dmy[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return { value: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` };
    }
  }
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return { value: localDateParts(d) };
  return { error: `invalid date "${s}" — use YYYY-MM-DD or DD/MM/YYYY` };
}

function parseOptionalInt(raw, fieldLabel) {
  if (raw == null || raw === '') return { value: null };
  const n = parseInt(String(raw).replace(/[^\d-]/g, ''), 10);
  if (Number.isNaN(n)) return { error: `${fieldLabel} must be a number (got "${raw}")` };
  return { value: n };
}

function rowHasData(row) {
  return Object.values(row || {}).some((v) => v != null && String(v).trim() !== '');
}

function importValidationError(messages) {
  const preview = messages.slice(0, 6).join(' · ');
  const extra = messages.length > 6 ? ` · …and ${messages.length - 6} more` : '';
  return Object.assign(new Error(preview + extra), {
    status: 422,
    errors: { import: messages },
  });
}

// Column set matches the client's real tracking sheet: Date, Domain, Published
// URL, DA, S.S (spam score), Anchor text, Target URL, Status, Type, Index Status.
// "Published URL" maps to sourceUrl — the field this codebase already treats as
// the backlink's own URL.
async function bulkImportBacklinks(projectId, orgId, fileBuffer, addedBy) {
  await assertProjectAccess(projectId, orgId);
  const wb = xlsx.read(fileBuffer, { type: 'buffer', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json(ws, { defval: null });

  if (!rows.length) {
    throw Object.assign(new Error('The file has no data rows. Add at least one backlink under the header row.'), { status: 400 });
  }

  // Link builders and content writers both place links in practice, so both
  // role pools resolve from the sheet's "Writer" column.
  const writerByName = await buildWriterLookup(orgId, ['link_builder', 'content_writer']);

  const errors = [];
  const records = [];

  rows.forEach((row, index) => {
    const rowNum = index + 2; // sheet row 1 is headers
    const sourceUrl = String(
      cell(row, 'Published URL', 'published_url', 'Published Url', 'URL', 'Source URL', 'source_url') || ''
    ).trim();

    if (!sourceUrl) {
      if (rowHasData(row)) {
        errors.push(`Row ${rowNum}: "Published URL" is required.`);
      }
      return;
    }

    const dateParsed = parseSheetDate(cell(row, 'Date', 'date', 'Published Date'));
    if (dateParsed.error) errors.push(`Row ${rowNum}: Date — ${dateParsed.error}.`);

    const daParsed = parseOptionalInt(cell(row, 'DA', 'da', 'Domain Authority'), 'DA');
    if (daParsed.error) errors.push(`Row ${rowNum}: ${daParsed.error}.`);

    const spamParsed = parseOptionalInt(cell(row, 'S.S', 'SS', 'Spam Score', 'spam_score'), 'Spam Score (S.S)');
    if (spamParsed.error) errors.push(`Row ${rowNum}: ${spamParsed.error}.`);

    const statusRaw = cell(row, 'Status', 'status');
    const status = statusRaw == null ? 'live' : String(statusRaw).trim().slice(0, 50);
    if (statusRaw != null && String(statusRaw).trim().length > 50) {
      errors.push(`Row ${rowNum}: Status is too long (max 50 characters).`);
    }

    const domainRaw = cell(row, 'Domain', 'domain');
    const domain = domainRaw == null ? null : String(domainRaw).trim().slice(0, 255);
    if (domainRaw != null && String(domainRaw).trim().length > 255) {
      errors.push(`Row ${rowNum}: Domain is too long (max 255 characters).`);
    }

    const anchorRaw = cell(row, 'Anchor text', 'Anchor Text', 'anchor_text', 'Anchor');
    const anchorText = anchorRaw == null ? null : String(anchorRaw).trim().slice(0, 255);
    if (anchorRaw != null && String(anchorRaw).trim().length > 255) {
      errors.push(`Row ${rowNum}: Anchor text is too long (max 255 characters).`);
    }

    const linkTypeRaw = cell(row, 'Type', 'type', 'Link Type', 'link_type');
    if (linkTypeRaw != null && String(linkTypeRaw).trim() !== '') {
      const normalized = String(linkTypeRaw).trim().toLowerCase();
      if (!LINK_TYPE_VALUES.includes(normalized)) {
        errors.push(`Row ${rowNum}: Type must be dofollow, nofollow, or other (got "${linkTypeRaw}").`);
      }
    }

    const writerName = cell(row, 'Writer', 'Assigned Writer', 'Assigned To', 'Link Builder', 'Assignee');
    if (writerName && !writerByName.has(normName(writerName))) {
      errors.push(`Row ${rowNum}: no active link builder or content writer named "${String(writerName).trim()}".`);
    }

    records.push({
      projectId,
      sourceUrl,
      domain,
      assignedWriterId: writerName ? (writerByName.get(normName(writerName)) || null) : null,
      date: dateParsed.value ?? null,
      da: daParsed.value ?? null,
      spamScore: spamParsed.value ?? null,
      anchorText,
      targetUrl: cell(row, 'Target URL', 'target_url', 'Target Url') != null
        ? String(cell(row, 'Target URL', 'target_url', 'Target Url')).trim()
        : null,
      status,
      linkType: normalizeLinkType(linkTypeRaw),
      isIndexed: normalizeIndexed(cell(row, 'Index Status', 'index_status', 'Indexed', 'indexed')),
      addedBy,
      _rowNum: rowNum,
    });
  });

  if (errors.length) throw importValidationError(errors);

  if (!records.length) {
    throw Object.assign(new Error(
      'No valid backlinks found. Make sure the sheet has a "Published URL" column and at least one data row.'
    ), { status: 400 });
  }

  try {
    let sortOrder = await nextSortOrder(Backlink, projectId);
    const cleaned = records.map(({ _rowNum, ...rest }) => {
      const row = { ...rest, sortOrder };
      sortOrder += 1;
      return row;
    });
    return await Backlink.bulkCreate(cleaned, { validate: true });
  } catch (err) {
    if (err.name === 'SequelizeValidationError' || err.name === 'SequelizeDatabaseError') {
      const detail = err.errors?.map((e) => `${e.path}: ${e.message}`).join('; ')
        || err.parent?.sqlMessage
        || err.message;
      throw Object.assign(new Error(`Import failed — ${detail}`), { status: 422 });
    }
    throw err;
  }
}

// Second import mode: updates status/isIndexed on EXISTING backlinks by matching
// "Published URL" — never creates new rows. Rows with no matching backlink in
// this project are reported as skipped rather than silently ignored.
async function bulkUpdateBacklinkStatus(projectId, orgId, fileBuffer) {
  await assertProjectAccess(projectId, orgId);
  const wb = xlsx.read(fileBuffer, { type: 'buffer', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json(ws, { defval: null });

  if (!rows.length) {
    throw Object.assign(new Error('The file has no data rows.'), { status: 400 });
  }

  let updated = 0;
  const skipped = [];
  const errors = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const rowNum = i + 2;
    const sourceUrl = String(
      cell(row, 'Published URL', 'published_url', 'Published Url', 'URL', 'Source URL', 'source_url') || ''
    ).trim();
    if (!sourceUrl) {
      if (rowHasData(row)) errors.push(`Row ${rowNum}: "Published URL" is required to match an existing backlink.`);
      continue;
    }
    const bl = await Backlink.findOne({ where: { projectId, sourceUrl } });
    if (!bl) { skipped.push(sourceUrl); continue; }
    const updates = {};
    if (cell(row, 'Status', 'status') != null) {
      const status = String(cell(row, 'Status', 'status')).trim().slice(0, 50);
      if (!status) errors.push(`Row ${rowNum}: Status cannot be empty.`);
      else updates.status = status;
    }
    if (cell(row, 'Index Status', 'index_status', 'Indexed', 'indexed') !== null) {
      updates.isIndexed = normalizeIndexed(cell(row, 'Index Status', 'index_status', 'Indexed', 'indexed'));
    }
    if (Object.keys(updates).length) {
      await bl.update(updates);
      updated += 1;
    }
  }
  if (errors.length) throw importValidationError(errors);
  return { updated, skippedCount: skipped.length, skipped };
}

// ─── Content Submissions ──────────────────────────────────────────────────────

async function listContent(projectId, orgId) {
  await assertProjectAccess(projectId, orgId);
  return ContentSubmission.findAll({
    where: { projectId },
    include: [
      { association: 'submitter', attributes: ['id', 'name'] },
      { association: 'reviewer', attributes: ['id', 'name'] },
    ],
    order: [['createdAt', 'DESC']],
  });
}

async function createContent(data, orgId, caller) {
  await assertProjectAccess(data.projectId, orgId);

  // Non-managers can only submit content for keywords assigned to them — the
  // frontend picker already only shows their own assigned keywords, this is the
  // server-side backstop against a crafted request bypassing that.
  const isManager = ['super_admin', 'admin'].includes(caller?.role?.key) || !!caller?.role?.permissions?.['projects.manage'];
  if (Array.isArray(data.keywordIds) && data.keywordIds.length) {
    const kws = await Keyword.findAll({
      where: { id: data.keywordIds, projectId: data.projectId },
      attributes: ['id', 'assignedWriterId', 'status', 'approvalStatus'],
    });
    if (kws.some((k) => k.status === 'inactive')) {
      const err = new Error('Inactive keywords cannot be used for content submissions.');
      err.status = 400;
      throw err;
    }
    if (kws.some((k) => k.approvalStatus !== 'approved')) {
      const err = new Error('Keywords still pending upload approval cannot be used for content submissions.');
      err.status = 400;
      throw err;
    }
    if (!isManager) {
      const notMine = kws.some((k) => k.assignedWriterId !== data.submittedBy);
      if (notMine) {
        const err = new Error('You can only submit content for keywords assigned to you.');
        err.status = 403;
        throw err;
      }
    }
  }

  const latestRevision = await ContentSubmission.findOne({
    where: {
      projectId: data.projectId,
      pageName: data.pageName,
      submittedBy: data.submittedBy,
    },
    order: [['createdAt', 'DESC']],
    attributes: ['id', 'revisionOfId', 'revisionNumber'],
  });
  const revisionOfId = latestRevision?.revisionOfId || latestRevision?.id || null;
  const revisionNumber = latestRevision?.revisionNumber ? latestRevision.revisionNumber + 1 : 1;

  const submission = await ContentSubmission.create({
    ...data,
    revisionOfId,
    revisionNumber,
  });

  // Submitting content moves the writer's open "write this page" task to
  // "submitted" so it shows under Submitted until a strategist approves/rejects.
  if (data.submittedBy && data.pageName) {
    const openTasks = await Task.findAll({
      where: {
        projectId: data.projectId,
        type: 'content',
        pageName: data.pageName,
        assigneeId: data.submittedBy,
        status: { [Op.in]: ['todo', 'in_progress', 'rejected'] },
      },
    });
    for (const task of openTasks) {
      try {
        if (task.status === 'rejected') {
          await TaskService.transition(task.id, orgId, 'in_progress', { id: data.submittedBy }, null, 'Content resubmitted.');
        }
        await TaskService.transition(task.id, orgId, 'submitted', { id: data.submittedBy }, null, 'Content submitted.');
      } catch (err) {
        console.error('[SeoService] Failed to mark content task submitted:', err.message);
      }
    }
  }
  return submission;
}

// A strategist approves or rejects a submitted page. Approving takes its
// keywords out of the "remaining" pool (see the Keywords tab stat calc, which
// only counts keywords covered by an *approved* submission); once every keyword
// is covered, the project auto-advances past this stage. Rejecting requires a
// reason and reopens a task for the original writer so they see it's back in
// their queue — this can happen any number of times across resubmissions.
async function reviewContent(id, updates, orgId, reviewer) {
  const reviewerId = reviewer?.id;
  const cs = await ContentSubmission.findOne({
    where: { id },
    include: [{ model: Project, as: 'project', where: { orgId } }],
  });
  if (!cs) throw Object.assign(new Error('Content submission not found'), { status: 404 });

  const status = updates.status;
  if (!['approved', 'rejected'].includes(status)) {
    throw Object.assign(new Error('Status must be "approved" or "rejected".'), { status: 400 });
  }
  const reason = String(updates.rejectionReason || '').trim();
  if (status === 'rejected' && !reason) {
    throw Object.assign(new Error('A rejection reason is required.'), { status: 400 });
  }
  if (cs.submittedBy && cs.submittedBy === reviewerId) {
    throw Object.assign(new Error('You cannot review your own submission.'), { status: 400 });
  }
  const canManageProjects = ['super_admin', 'admin'].includes(reviewer?.role?.key)
    || !!reviewer?.role?.permissions?.['projects.manage'];
  if (status === 'rejected' && cs.status === 'approved' && !canManageProjects) {
    throw Object.assign(new Error('Only Project Manager or Super Admin can request revisions after approval.'), { status: 403 });
  }

  // Revisions after approval: keep the approved file as history (`superseded`)
  // and open a new rejected revise row so keywords unlock for a rewrite.
  const wasApproved = cs.status === 'approved';
  let target = cs;
  if (status === 'rejected' && wasApproved) {
    const rootId = cs.revisionOfId || cs.id;
    const revisionNumber = (cs.revisionNumber || 1) + 1;
    await cs.update({
      status: 'superseded',
      rejectionReason: reason,
      reviewedBy: reviewerId,
      reviewedAt: new Date(),
    });
    target = await ContentSubmission.create({
      projectId: cs.projectId,
      pageName: cs.pageName,
      keywordIds: cs.keywordIds,
      fileUrl: cs.fileUrl,
      fileName: cs.fileName,
      submittedBy: cs.submittedBy,
      wordCount: cs.wordCount,
      status: 'rejected',
      rejectionReason: reason,
      reviewedBy: reviewerId,
      reviewedAt: new Date(),
      revisionOfId: rootId,
      revisionNumber,
    });
  } else {
    await cs.update({
      status,
      rejectionReason: status === 'rejected' ? reason : null,
      reviewedBy: reviewerId,
      reviewedAt: new Date(),
    });
  }

  if (status === 'rejected') {
    if (target.submittedBy && target.pageName) {
      // Mark the submitted/in-review task as rejected so it leaves the review queue.
      const reviewTasks = await Task.findAll({
        where: {
          projectId: target.projectId,
          type: 'content',
          pageName: target.pageName,
          assigneeId: target.submittedBy,
          status: { [Op.in]: ['submitted', 'in_review'] },
        },
      });
      for (const task of reviewTasks) {
        try {
          await TaskService.transition(task.id, orgId, 'rejected', { id: reviewerId }, null, reason);
        } catch (err) {
          console.error('[SeoService] Failed to mark content task rejected:', err.message);
        }
      }

      const existingOpen = await Task.findOne({
        where: {
          projectId: target.projectId,
          type: 'content',
          pageName: target.pageName,
          assigneeId: target.submittedBy,
          status: { [Op.in]: ['todo', 'in_progress'] },
        },
      });
      if (!existingOpen) {
        // Prefer reopening a just-rejected task as the revise work item.
        const rejectedTask = await Task.findOne({
          where: {
            projectId: target.projectId,
            type: 'content',
            pageName: target.pageName,
            assigneeId: target.submittedBy,
            status: 'rejected',
          },
          order: [['updatedAt', 'DESC']],
        });
        if (rejectedTask) {
          try {
            await TaskService.transition(rejectedTask.id, orgId, 'in_progress', { id: reviewerId }, null, reason);
            await rejectedTask.update({ title: `Revise content — ${target.pageName}` });
          } catch (err) {
            console.error('[SeoService] Failed to reopen rejected content task:', err.message);
            await TaskService.create(orgId, target.projectId, {
              type: 'content',
              title: `Revise content — ${target.pageName}`,
              assigneeId: target.submittedBy,
              pageName: target.pageName,
              stageKey: cs.project.currentStageKey,
            }, reviewerId);
          }
        } else {
          await TaskService.create(orgId, target.projectId, {
            type: 'content',
            title: `Revise content — ${target.pageName}`,
            assigneeId: target.submittedBy,
            pageName: target.pageName,
            stageKey: cs.project.currentStageKey,
          }, reviewerId);
        }
      }
      NotificationService.notify(target.submittedBy, orgId, {
        type: 'content_rejected',
        title: wasApproved
          ? `Revision requested: "${target.pageName}"`
          : `Content rejected: "${target.pageName}"`,
        body: reason,
        refTable: 'projects',
        refId: target.projectId,
      });
    }
    return target;
  }

  // Approved — mirror onto matching content Tasks for this page. Don't require
  // assigneeId === submittedBy (admin may submit on a writer's behalf) and
  // include open statuses so a leftover todo/in_progress row can't block Mark Complete.
  if (cs.pageName) {
    const matchTasks = await Task.findAll({
      where: {
        projectId: cs.projectId,
        type: 'content',
        pageName: cs.pageName,
        status: { [Op.in]: ['todo', 'in_progress', 'submitted', 'in_review', 'rejected', 'done'] },
      },
    });
    for (const task of matchTasks) {
      try {
        await Task.update(
          { status: 'approved', completedAt: new Date() },
          { where: { id: task.id } }
        );
      } catch (err) {
        console.error('[SeoService] Failed to mark content task approved:', err.message);
      }
    }
  }

  // If every *active* keyword now has an approved submission covering it,
  // the pool is empty; try to auto-advance the project. Inactive keywords are
  // ignored so a focus change doesn't block stage completion — pending/rejected
  // upload-approval keywords are ignored the same way, since they aren't live yet.
  const [keywords, approvedSubmissions] = await Promise.all([
    Keyword.findAll({ where: { projectId: cs.projectId, status: 'active', approvalStatus: 'approved' }, attributes: ['id'] }),
    ContentSubmission.findAll({ where: { projectId: cs.projectId, status: 'approved' }, attributes: ['keywordIds'] }),
  ]);
  const coveredIds = new Set();
  for (const s of approvedSubmissions) (s.keywordIds || []).forEach((kid) => coveredIds.add(kid));
  const remaining = keywords.filter((k) => !coveredIds.has(k.id));

  if (keywords.length > 0 && remaining.length === 0) {
    try {
      const reviewer = await User.findByPk(reviewerId, { include: [{ association: 'role' }] });
      await performAction({ user: reviewer, project: cs.project, action: 'complete', note: 'All content approved — pool cleared.' });
    } catch (err) {
      console.error('[SeoService] Auto-advance on content pool clear failed:', err.message);
    }
  }
  return cs;
}

async function deleteContent(id, orgId, actor) {
  const cs = await ContentSubmission.findOne({
    where: { id },
    include: [{ model: Project, as: 'project', where: { orgId }, attributes: ['id'] }],
  });
  if (!cs) throw Object.assign(new Error('Content submission not found.'), { status: 404 });

  const isManager = ['super_admin', 'admin'].includes(actor?.role?.key)
    || !!actor?.role?.permissions?.['projects.manage'];
  if (!isManager && cs.submittedBy !== actor.id) {
    throw Object.assign(new Error('Only the submitter can delete this content item.'), { status: 403 });
  }
  if (cs.status === 'approved' && !isManager) {
    throw Object.assign(new Error('Approved content cannot be deleted by the submitter. Ask a reviewer to reopen it first.'), { status: 400 });
  }
  if (cs.status === 'superseded' && !isManager) {
    throw Object.assign(new Error('Prior versions are kept for history and cannot be deleted by the submitter.'), { status: 400 });
  }

  const idsToDestroy = new Set([cs.id]);

  // Heal older "reopen kept Approved + created Rejected" rows: converting the
  // live approved sibling to superseded unlocks keywords while preserving the
  // prior file in history (instead of deleting it).
  if (cs.status === 'rejected' && cs.pageName && cs.submittedBy) {
    await ContentSubmission.update(
      {
        status: 'superseded',
        rejectionReason: cs.rejectionReason || 'Superseded by revision request.',
        reviewedAt: new Date(),
      },
      {
        where: {
          projectId: cs.projectId,
          pageName: cs.pageName,
          submittedBy: cs.submittedBy,
          status: 'approved',
          id: { [Op.ne]: cs.id },
        },
      },
    );
  }

  await ContentSubmission.destroy({ where: { id: [...idsToDestroy] } });
  return { ok: true };
}

/**
 * Bulk-delete content submissions — permanently removes them (see
 * deleteContent: ContentSubmission isn't soft-deletable, it's a review-
 * workflow artifact, not a core record). Only ever touches unapproved rows —
 * approved and superseded submissions are always skipped here, regardless of
 * role, so a bulk action can't accidentally wipe out approval history.
 */
async function bulkDeleteContent(projectId, orgId, ids, actor) {
  await assertProjectAccess(projectId, orgId);
  const idList = Array.isArray(ids) ? [...new Set(ids.filter(Boolean))] : [];
  if (!idList.length) {
    throw Object.assign(new Error('No content IDs provided.'), { status: 400 });
  }
  if (idList.length > 200) {
    throw Object.assign(new Error('You can change at most 200 items at a time.'), { status: 400 });
  }

  const isManager = ['super_admin', 'admin'].includes(actor?.role?.key)
    || !!actor?.role?.permissions?.['projects.manage'];

  const rows = await ContentSubmission.findAll({
    where: { id: idList, projectId },
    attributes: ['id', 'status', 'submittedBy'],
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const deleted = [];
  const skipped = [];

  for (const id of idList) {
    const cs = byId.get(id);
    if (!cs) { skipped.push({ id, reason: 'not_found' }); continue; }
    if (['approved', 'superseded'].includes(cs.status)) { skipped.push({ id, reason: 'approved' }); continue; }
    if (!isManager && cs.submittedBy !== actor?.id) { skipped.push({ id, reason: 'not_owner' }); continue; }
    deleted.push(id);
  }

  if (deleted.length) {
    await ContentSubmission.destroy({ where: { id: deleted } });
  }
  return { deleted: deleted.length, skipped };
}

/** Heal older content tasks left as "done" after the submission was approved. */
async function syncApprovedContentTasks(orgId, userId) {
  const submissions = await ContentSubmission.findAll({
    where: {
      status: 'approved',
      ...(userId ? { submittedBy: userId } : {}),
    },
    include: [{
      model: Project,
      as: 'project',
      where: { orgId },
      attributes: ['id'],
      required: true,
    }],
    attributes: ['projectId', 'pageName', 'submittedBy'],
  });

  for (const cs of submissions) {
    if (!cs.submittedBy || !cs.pageName) continue;
    await Task.update(
      { status: 'approved', completedAt: new Date() },
      {
        where: {
          projectId: cs.projectId,
          type: 'content',
          pageName: cs.pageName,
          assigneeId: cs.submittedBy,
          status: { [Op.in]: ['done', 'submitted', 'in_review'] },
        },
      },
    );
  }
}

// ─── Blog Tasks ───────────────────────────────────────────────────────────────

async function listBlogSheet(projectId, orgId, { includeInactive = false } = {}) {
  await assertProjectAccess(projectId, orgId);
  return BlogTask.findAll({
    where: { projectId, ...(includeInactive ? {} : { isActive: true }) },
    include: [
      { association: 'submitter', attributes: ['id', 'name'] },
      { association: 'assignedWriter', attributes: ['id', 'name'] },
      { association: 'assignedDesigner', attributes: ['id', 'name'] },
      { association: 'reviewer', attributes: ['id', 'name'] },
    ],
    order: SHEET_ORDER,
  });
}

async function listBlogTasks(projectId, orgId) {
  await assertProjectAccess(projectId, orgId);
  return BlogTask.findAll({ where: { projectId }, order: [['createdAt', 'DESC']] });
}

/**
 * Manual single-row add for the Blog Sheet plan (like adding a Keyword).
 * Creates a draft row + writer Task in todo — deliverable submit is separate.
 */
async function createBlogSheetRow(projectId, data, orgId, actorUserId) {
  const project = await assertProjectAccess(projectId, orgId);
  const title = String(data.title || '').trim();
  if (!title) {
    throw Object.assign(new Error('Blog Title is required.'), { status: 400 });
  }
  const sortOrder = await nextSortOrder(BlogTask, projectId);
  const volume = sheetNumber(data.volume);
  const kd = sheetNumber(data.kd);
  const assignedWriterId = data.assignedWriterId || null;

  const bt = await BlogTask.create({
    projectId,
    title,
    contentType: data.contentType || null,
    mainKeyword: data.mainKeyword || null,
    volume,
    kd,
    supportingKeywords: data.supportingKeywords || null,
    urlSlug: data.urlSlug || null,
    targetServicePage: data.targetServicePage || null,
    proof: data.proof || null,
    fileUrl: null,
    status: 'draft',
    submittedBy: null,
    assignedWriterId,
    createdBy: actorUserId,
    sortOrder,
  });

  // Mirror keyword assign: open a write task; do not mark submitted until deliverable.
  if (assignedWriterId) {
    await ensureBlogTask(orgId, project, title, assignedWriterId, actorUserId);
  }

  return bt;
}

/**
 * Content-parity submit: writer uploads the blog deliverable (existing draft/
 * rejected row, or a new title). Moves sheet to pending + Task to submitted.
 */
async function submitBlogDeliverable(projectId, data, orgId, caller) {
  const project = await assertProjectAccess(projectId, orgId);
  const title = String(data.title || '').trim();
  const blogId = data.blogId || null;
  if (!title && !blogId) {
    throw Object.assign(new Error('Blog title or blogId is required.'), { status: 400 });
  }

  let bt = null;
  if (blogId) {
    bt = await BlogTask.findOne({ where: { id: blogId, projectId } });
    if (!bt) throw Object.assign(new Error('Blog row not found.'), { status: 404 });
    if (!['draft', 'rejected', 'pending'].includes(bt.status)) {
      throw Object.assign(new Error('This blog is already approved and cannot be resubmitted.'), { status: 400 });
    }
  }

  const resolvedTitle = title || bt.title;
  const isManager = ['super_admin', 'admin'].includes(caller?.role?.key)
    || !!caller?.role?.permissions?.['projects.manage'];
  const writerId = data.assignedWriterId || bt?.assignedWriterId || caller.id;

  // Writers can only submit sheet rows assigned to them — unassigned drafts stay
  // on the plan until a strategist/PM picks a writer (keyword content parity).
  if (!isManager) {
    if (!bt || bt.assignedWriterId !== caller.id) {
      throw Object.assign(new Error('You can only submit blogs assigned to you.'), { status: 403 });
    }
  }

  let fileUrl = String(data.fileUrl || '').trim() || null;
  if (fileUrl && !/^https?:\/\//i.test(fileUrl) && !fileUrl.startsWith('/')) {
    fileUrl = `https://${fileUrl}`;
  }
  const resolvedFileUrl = fileUrl || bt?.fileUrl || null;
  if (!resolvedFileUrl) {
    throw Object.assign(new Error('Attach a file or paste a deliverable link.'), { status: 400 });
  }
  const resolvedFileName = fileUrl ? (data.fileName || null) : (bt?.fileName || null);

  if (bt) {
    await bt.update({
      status: 'pending',
      rejectionReason: null,
      reviewedBy: null,
      reviewedAt: null,
      submittedBy: caller.id,
      assignedWriterId: writerId,
      fileUrl: resolvedFileUrl,
      fileName: resolvedFileName,
      title: resolvedTitle,
      ...(data.mainKeyword != null ? { mainKeyword: data.mainKeyword } : {}),
      ...(data.contentType != null ? { contentType: data.contentType } : {}),
    });
  } else {
    const sortOrder = await nextSortOrder(BlogTask, projectId);
    bt = await BlogTask.create({
      projectId,
      title: resolvedTitle,
      contentType: data.contentType || null,
      mainKeyword: data.mainKeyword || null,
      volume: sheetNumber(data.volume),
      kd: sheetNumber(data.kd),
      supportingKeywords: data.supportingKeywords || null,
      urlSlug: data.urlSlug || null,
      targetServicePage: data.targetServicePage || null,
      fileUrl: resolvedFileUrl,
      fileName: resolvedFileName,
      status: 'pending',
      submittedBy: caller.id,
      assignedWriterId: writerId,
      createdBy: caller.id,
      sortOrder,
    });
  }

  const writerTask = await ensureBlogTask(orgId, project, resolvedTitle, writerId, caller.id);
  // The file submitted here goes through MediaService directly, so it was never
  // recorded as an Artifact against the writer's Task. That mattered: markBlogTasks-
  // Submitted below drives the Task through TaskService.transition, which refuses
  // to submit a blog_post with an empty Deliverable panel (DELIVERABLE_TASK_TYPES)
  // — so the sheet row went to "In review" while the writer's task silently stayed
  // in To do, and the Task Detail page showed no file at all. Recording it keeps
  // both surfaces showing the same deliverable.
  if (writerTask?.id) {
    await ensureTaskDeliverableArtifact(writerTask, resolvedFileUrl, resolvedFileName, caller.id);
  }
  await markBlogTasksSubmitted(orgId, projectId, resolvedTitle, writerId, caller.id);

  for (const slot of ['project_strategist', 'project_manager']) {
    const assignment = await ProjectAssignment.findOne({ where: { projectId, roleSlot: slot } });
    if (assignment?.userId && assignment.userId !== caller.id) {
      NotificationService.notify(assignment.userId, orgId, {
        type: 'blog_submitted',
        title: `Blog submitted for review: "${bt.title}"`,
        body: `${project.name} — waiting on your approval.`,
        refTable: 'projects',
        refId: projectId,
      });
      break;
    }
  }

  return bt;
}

async function createBlogTask(data, orgId) {
  await assertProjectAccess(data.projectId, orgId);
  return BlogTask.create(data);
}

async function updateBlogTask(id, updates, orgId, actorUserId) {
  const bt = await BlogTask.findOne({
    where: { id },
    include: [{ model: Project, as: 'project', where: { orgId }, attributes: ['id', 'currentStageKey', 'name'] }],
  });
  if (!bt) throw Object.assign(new Error('Blog task not found'), { status: 404 });

  if (bt.status === 'approved' && Object.prototype.hasOwnProperty.call(updates, 'assignedWriterId')) {
    throw Object.assign(new Error('Cannot reassign writer on an approved blog.'), { status: 400 });
  }
  // Mirror image: nothing to illustrate until the copy itself is approved, so a
  // designer can't be assigned any earlier.
  if (bt.status !== 'approved' && Object.prototype.hasOwnProperty.call(updates, 'assignedDesignerId')) {
    throw Object.assign(new Error('A designer can only be assigned once the blog is approved.'), { status: 400 });
  }

  const patch = { ...updates };
  const assigningWriter = patch.assignedWriterId && patch.assignedWriterId !== bt.assignedWriterId;
  const assigningDesigner = patch.assignedDesignerId && patch.assignedDesignerId !== bt.assignedDesignerId;
  await bt.update(patch);

  if (assigningWriter) {
    await ensureBlogTask(orgId, bt.project, bt.title, patch.assignedWriterId, actorUserId);
  }
  if (assigningDesigner) {
    await ensureBlogImageTask(orgId, bt.project, bt.title, patch.assignedDesignerId, actorUserId);
  }
  return bt;
}

/**
 * CSV/XLSX import for the Blog content-plan sheet (pillar/cluster rows). Mirrors
 * bulkImportKeywords's permissive style, not bulkImportBacklinks's strict one — the
 * only required cell is Blog Title; every other column is optional, and a
 * missing/unparseable value is just stored as null rather than rejecting the row
 * or the import (per product requirement: never throw for null/invalid optional
 * cells, but never show a literal "null" for a cell that did have data either —
 * that half is a display concern, handled on the frontend).
 */
async function bulkImportBlogTasks(projectId, orgId, fileBuffer, submittedBy) {
  const project = await assertProjectAccess(projectId, orgId);
  const wb = xlsx.read(fileBuffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json(ws, { defval: null });
  const writerByName = await buildWriterLookup(orgId, ['blog_writer', 'content_writer']);
  const unmatchedWriters = new Set();

  let sortOrder = await nextSortOrder(BlogTask, projectId);
  const records = rows.map((row) => {
    const title = String(cell(row, 'Blog Title', 'Title') || '').trim();
    if (!title) return null;

    const writerName = cell(row, 'Writer', 'Assigned Writer', 'Blog Writer', 'Assignee');
    let assignedWriterId = null;
    if (writerName) {
      const trimmed = String(writerName).trim();
      assignedWriterId = writerByName.get(normName(trimmed)) || null;
      if (trimmed && !assignedWriterId) unmatchedWriters.add(trimmed);
    }

    const record = {
      projectId,
      title,
      contentType: cell(row, 'Type', 'Content Type') || null,
      mainKeyword: cell(row, 'Main Keyword', 'main_keyword') || null,
      volume: sheetNumber(cell(row, 'Volume', 'volume', 'Search Volume', 'Vol')),
      kd: sheetNumber(cell(row, 'KD', 'kd')),
      supportingKeywords: cell(row, 'Supporting Keywords', 'supporting_keywords') || null,
      urlSlug: cell(row, 'URL Slug', 'url_slug', 'Slug') || null,
      targetServicePage: cell(row, 'Target Service Page', 'target_service_page') || null,
      // "Approve" is a manual-only Yes/No field set on the sheet after review —
      // never read from an imported file, even if the sheet happens to have a
      // column with that name.
      proof: null,
      status: 'draft',
      submittedBy: null,
      assignedWriterId,
      createdBy: submittedBy,
      sortOrder,
    };
    sortOrder += 1;
    return record;
  }).filter(Boolean);

  if (!records.length) {
    throw Object.assign(new Error('No rows with a Blog Title were found in this file.'), { status: 400 });
  }

  const created = await BlogTask.bulkCreate(records, { validate: true });

  // Content-parity with keyword import: open write Tasks; deliverable submit is separate.
  const seen = new Set();
  for (const rec of records) {
    if (!rec.assignedWriterId) continue;
    const key = `${rec.assignedWriterId}::${rec.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await ensureBlogTask(orgId, project, rec.title, rec.assignedWriterId, submittedBy);
  }

  return { rows: created, unmatchedWriters: [...unmatchedWriters] };
}

/** A Project Strategist / Project Manager / Super Admin approves or rejects one blog row. */
async function reviewBlogTask(id, updates, orgId, reviewer) {
  const bt = await BlogTask.findOne({
    where: { id },
    include: [{ model: Project, as: 'project', where: { orgId }, attributes: ['id', 'name'] }],
  });
  if (!bt) throw Object.assign(new Error('Blog task not found'), { status: 404 });

  if (bt.status !== 'pending') {
    throw Object.assign(new Error('Only blogs awaiting review can be approved or rejected.'), { status: 400 });
  }

  const status = updates.status;
  if (!['approved', 'rejected'].includes(status)) {
    throw Object.assign(new Error('Status must be "approved" or "rejected".'), { status: 400 });
  }
  const reason = String(updates.rejectionReason || '').trim();
  if (status === 'rejected' && !reason) {
    throw Object.assign(new Error('A rejection reason is required.'), { status: 400 });
  }
  if (bt.submittedBy && bt.submittedBy === reviewer.id) {
    throw Object.assign(new Error('You cannot review your own submission.'), { status: 400 });
  }

  const isManager = ['super_admin', 'admin'].includes(reviewer?.role?.key) || !!reviewer?.role?.permissions?.['projects.manage'];
  if (!isManager) {
    const assignment = await ProjectAssignment.findOne({
      where: {
        projectId: bt.projectId,
        userId: reviewer.id,
        roleSlot: { [Op.in]: ['project_strategist', 'project_manager'] },
      },
    });
    if (!assignment) {
      throw Object.assign(new Error('Only an admin, project manager, or project strategist can review blog submissions.'), { status: 403 });
    }
  }

  await bt.update({
    status,
    rejectionReason: status === 'rejected' ? reason : null,
    reviewedBy: reviewer.id,
    reviewedAt: new Date(),
  });

  const writerId = bt.assignedWriterId || bt.submittedBy;
  const project = await Project.findByPk(bt.projectId);

  if (status === 'rejected' && writerId) {
    // Mirror reviewContent: reject open review tasks and reopen a revise task.
    const reviewTasks = await Task.findAll({
      where: {
        projectId: bt.projectId,
        type: 'blog_post',
        pageName: bt.title,
        assigneeId: writerId,
        status: { [Op.in]: ['submitted', 'in_review'] },
      },
    });
    for (const task of reviewTasks) {
      try {
        await TaskService.transition(task.id, orgId, 'rejected', { id: reviewer.id }, null, reason);
      } catch (err) {
        console.error('[SeoService] Failed to mark blog task rejected:', err.message);
      }
    }

    const existingOpen = await Task.findOne({
      where: {
        projectId: bt.projectId,
        type: 'blog_post',
        pageName: bt.title,
        assigneeId: writerId,
        status: { [Op.in]: ['todo', 'in_progress'] },
      },
    });
    if (!existingOpen) {
      const rejectedTask = await Task.findOne({
        where: {
          projectId: bt.projectId,
          type: 'blog_post',
          pageName: bt.title,
          assigneeId: writerId,
          status: 'rejected',
        },
        order: [['updatedAt', 'DESC']],
      });
      if (rejectedTask) {
        try {
          await TaskService.transition(rejectedTask.id, orgId, 'in_progress', { id: reviewer.id }, null, reason);
          await rejectedTask.update({ title: `Revise blog — ${bt.title}` });
        } catch (err) {
          console.error('[SeoService] Failed to reopen rejected blog task:', err.message);
          await TaskService.create(orgId, bt.projectId, {
            type: 'blog_post',
            title: `Revise blog — ${bt.title}`,
            assigneeId: writerId,
            pageName: bt.title,
            stageKey: project?.currentStageKey,
          }, reviewer.id);
        }
      } else {
        await TaskService.create(orgId, bt.projectId, {
          type: 'blog_post',
          title: `Revise blog — ${bt.title}`,
          assigneeId: writerId,
          pageName: bt.title,
          stageKey: project?.currentStageKey,
        }, reviewer.id);
      }
    }
  }

  if (status === 'approved') {
    const matchTasks = await Task.findAll({
      where: {
        projectId: bt.projectId,
        type: 'blog_post',
        pageName: bt.title,
        status: { [Op.in]: ['todo', 'in_progress', 'submitted', 'in_review', 'rejected', 'done'] },
      },
    });
    for (const task of matchTasks) {
      try {
        await Task.update(
          { status: 'approved', completedAt: new Date() },
          { where: { id: task.id } }
        );
      } catch (err) {
        console.error('[SeoService] Failed to mark blog task approved:', err.message);
      }
    }
  }

  if (writerId || bt.submittedBy) {
    const notifyUserId = bt.submittedBy || writerId;
    NotificationService.notify(notifyUserId, orgId, {
      type: status === 'approved' ? 'blog_approved' : 'blog_rejected',
      title: status === 'approved' ? `Blog approved: "${bt.title}"` : `Blog rejected: "${bt.title}"`,
      body: status === 'rejected' ? reason : `${bt.project.name} — approved.`,
      refTable: 'projects',
      refId: bt.projectId,
    });
  }

  return bt;
}

/** Heal blog Tasks left as done/submitted after the sheet row was approved. */
async function syncApprovedBlogTasks(orgId, userId) {
  const rows = await BlogTask.findAll({
    where: {
      status: 'approved',
      ...(userId ? { [Op.or]: [{ submittedBy: userId }, { assignedWriterId: userId }] } : {}),
    },
    include: [{
      model: Project,
      as: 'project',
      where: { orgId },
      attributes: ['id'],
      required: true,
    }],
    attributes: ['projectId', 'title', 'submittedBy', 'assignedWriterId'],
  });

  for (const bt of rows) {
    if (!bt.title) continue;
    const matchTasks = await Task.findAll({
      where: {
        projectId: bt.projectId,
        type: 'blog_post',
        pageName: bt.title,
        status: { [Op.in]: ['submitted', 'in_review', 'done'] },
        ...(userId ? { assigneeId: userId } : {}),
      },
    });
    for (const task of matchTasks) {
      try {
        await Task.update(
          { status: 'approved', completedAt: new Date() },
          { where: { id: task.id } }
        );
      } catch (err) {
        console.error('[SeoService] Failed to sync approved blog task:', err.message);
      }
    }
  }
}

/**
 * Shared owner/approved guard for the single-row delete and deactivate paths.
 * Not admin-only: the person who added the row can act on it themselves too,
 * but only while it's still theirs to take back — once it's been approved,
 * only an admin/manager (via SoftDeleteService-style checks elsewhere) can
 * touch it. Mirrors deleteKeyword's guard.
 */
function assertBlogTaskActionable(bt, actor, verb) {
  const isManager = ['super_admin', 'admin'].includes(actor?.role?.key)
    || !!actor?.role?.permissions?.['projects.manage'];
  if (!isManager && bt.createdBy !== actor?.id) {
    throw Object.assign(new Error(`Only the person who added this blog (or an admin) can ${verb} it.`), { status: 403 });
  }
  if (bt.status === 'approved') {
    throw Object.assign(new Error(`This blog has approved content and cannot be ${verb === 'delete' ? 'deleted' : 'set to Inactive'}.`), { status: 400 });
  }
}

/**
 * Permanently deletes a single blog row — real removal, not a status flip.
 * Same guard as deleteKeyword: not admin-only, blocked once approved.
 */
async function deleteBlogTask(id, orgId, actor) {
  const bt = await BlogTask.findOne({
    where: { id },
    include: [{ model: Project, as: 'project', where: { orgId }, attributes: [] }],
  });
  if (!bt) throw Object.assign(new Error('Blog task not found'), { status: 404 });

  assertBlogTaskActionable(bt, actor, 'delete');
  await bt.destroy();
  return bt;
}

/**
 * Non-destructive: sets a single row to Inactive — see models/softDeletable.js.
 * Same owner/approved guard as deleteBlogTask, kept as a separate action now
 * that delete really deletes. Reversible via setBlogTaskActive.
 */
async function deactivateBlogTask(id, orgId, actor) {
  const bt = await BlogTask.findOne({
    where: { id },
    include: [{ model: Project, as: 'project', where: { orgId }, attributes: [] }],
  });
  if (!bt) throw Object.assign(new Error('Blog task not found'), { status: 404 });

  assertBlogTaskActionable(bt, actor, 'set it to Inactive');
  await bt.update({ isActive: false });
  return bt;
}

/** Plain status flip, no guard — used by the admin-only /activate route to reactivate a row. */
async function setBlogTaskActive(id, orgId, active) {
  const bt = await BlogTask.findOne({
    where: { id },
    include: [{ model: Project, as: 'project', where: { orgId }, attributes: [] }],
  });
  if (!bt) throw Object.assign(new Error('Blog task not found'), { status: 404 });
  await bt.update({ isActive: active });
  return bt;
}

/**
 * Bulk permanently deletes blog rows — real removal, not a status flip.
 * Route-gated adminOnly (same as bulkDeleteKeywords), so no owner check here:
 * approved rows are still skipped since they're a record of accepted work.
 */
async function bulkDeleteBlogTasks(projectId, orgId, ids) {
  await assertProjectAccess(projectId, orgId);
  const idList = Array.isArray(ids) ? [...new Set(ids.filter(Boolean))] : [];
  if (!idList.length) {
    throw Object.assign(new Error('No blog IDs provided.'), { status: 400 });
  }
  if (idList.length > 200) {
    throw Object.assign(new Error('You can change at most 200 blogs at a time.'), { status: 400 });
  }

  const rows = await BlogTask.findAll({
    where: { id: idList, projectId },
    attributes: ['id', 'status'],
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const deleted = [];
  const skipped = [];

  for (const id of idList) {
    const bt = byId.get(id);
    if (!bt) { skipped.push({ id, reason: 'not_found' }); continue; }
    if (bt.status === 'approved') { skipped.push({ id, reason: 'approved' }); continue; }
    deleted.push(id);
  }

  if (deleted.length) {
    await BlogTask.destroy({ where: { id: deleted, projectId } });
  }
  return { deleted: deleted.length, skipped };
}

/**
 * Non-destructive counterpart to bulkDeleteBlogTasks (which really deletes
 * now) — same adminOnly gate, same approved-row skip, but flips isActive
 * instead of destroying the row.
 */
async function bulkDeactivateBlogTasks(projectId, orgId, ids) {
  await assertProjectAccess(projectId, orgId);
  const idList = Array.isArray(ids) ? [...new Set(ids.filter(Boolean))] : [];
  if (!idList.length) {
    throw Object.assign(new Error('No blog IDs provided.'), { status: 400 });
  }
  if (idList.length > 200) {
    throw Object.assign(new Error('You can change at most 200 blogs at a time.'), { status: 400 });
  }

  const rows = await BlogTask.findAll({
    where: { id: idList, projectId },
    attributes: ['id', 'status'],
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const deactivated = [];
  const skipped = [];

  for (const id of idList) {
    const bt = byId.get(id);
    if (!bt) { skipped.push({ id, reason: 'not_found' }); continue; }
    if (bt.status === 'approved') { skipped.push({ id, reason: 'approved' }); continue; }
    deactivated.push(id);
  }

  if (deactivated.length) {
    await BlogTask.update({ isActive: false }, { where: { id: deactivated, projectId } });
  }
  return { deactivated: deactivated.length, skipped };
}

/** Bulk reactivate blog rows — no restriction, same as bulkActivateKeywords. */
async function bulkActivateBlogTasks(projectId, orgId, ids) {
  await assertProjectAccess(projectId, orgId);
  const idList = Array.isArray(ids) ? [...new Set(ids.filter(Boolean))] : [];
  if (!idList.length) {
    throw Object.assign(new Error('No blog IDs provided.'), { status: 400 });
  }
  if (idList.length > 200) {
    throw Object.assign(new Error('You can change at most 200 blogs at a time.'), { status: 400 });
  }
  const rows = await BlogTask.findAll({ where: { id: idList, projectId }, attributes: ['id'] });
  const found = rows.map((r) => r.id);
  if (found.length) {
    await BlogTask.update({ isActive: true }, { where: { id: found, projectId } });
  }
  const skipped = idList.filter((id) => !found.includes(id)).map((id) => ({ id, reason: 'not_found' }));
  return { activated: found.length, skipped };
}

/** Same row set as the Blog Sheet tab (every row, active or inactive) — spreadsheet-friendly. */
async function generateBlogCsv(projectId, orgId) {
  const project = await assertProjectAccess(projectId, orgId);
  const rows = await BlogTask.findAll({
    where: { projectId },
    include: [{ association: 'assignedWriter', attributes: ['id', 'name'] }],
    order: SHEET_ORDER,
  });

  const headers = [
    'Type', 'Blog Title', 'Main Keyword', 'Volume', 'KD', 'Supporting Keywords',
    'URL Slug', 'Target Service Page', 'Status', 'Writer', 'Published URL',
  ];
  const csvRows = rows.map((b) => [
    b.contentType || '',
    b.title,
    b.mainKeyword || '',
    b.volume ?? '',
    b.kd ?? '',
    b.supportingKeywords || '',
    b.urlSlug || '',
    b.targetServicePage || '',
    b.status.charAt(0).toUpperCase() + b.status.slice(1),
    b.assignedWriter?.name || '',
    b.publishedUrl || '',
  ]);
  const csv = [headers, ...csvRows]
    .map((row) => row.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))
    .join('\n');
  return { csv, project };
}

// ─── Keyword / Backlink Report PDFs ───────────────────────────────────────────

// Standard SEO difficulty banding — used to color-code the Difficulty column
// on the keyword report instead of a bare number.
function keywordDifficultyTier(kd) {
  if (kd == null) return { label: '—', bg: '#F3F4F6', color: '#6B7280' };
  if (kd <= 30) return { label: `${kd} · Easy`, bg: '#ECFDF5', color: '#047857' };
  if (kd <= 60) return { label: `${kd} · Medium`, bg: '#FFFBEB', color: '#B45309' };
  return { label: `${kd} · Hard`, bg: '#FEF2F2', color: '#B91C1C' };
}

function keywordStatusTier(status) {
  return status === 'Inactive'
    ? { bg: '#F3F4F6', color: '#6B7280' }
    : { bg: '#ECFDF5', color: '#047857' };
}

/**
 * @param {string[]|null} [letterheadFields] Which company detail fields (logo,
 *   address, tax number, email, phone, website — see services/letterhead.js)
 *   print on this export's letterhead. Set from a `?fields=` query override;
 *   null means "not specified" — fall back to the org's configured default
 *   (Admin → Branding → seoReportLetterheadFields), which itself defaults to
 *   logo-only for orgs that never configured it.
 */
async function _loadSeoReportContext(projectId, orgId, letterheadFields) {
  const project = await Project.findOne({
    where: { id: projectId, orgId },
    include: [{ model: Client, as: 'client', attributes: ['name'] }],
  });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });
  const brandConfig = await WhiteLabelConfig.findOne({ where: { orgId } });
  const brandName = brandConfig?.brandName || 'Mohsin Designs Project Management';
  const brandColor = brandConfig?.primaryColor || BRAND_COLOR;
  // SEO reports go to the client, so they carry the billing entity's letterhead
  // (the same one that appears on their invoices and quotations) rather than the
  // HR entity — see services/letterhead.js.
  const requestedFields = letterheadFields != null
    ? letterheadFields
    : (brandConfig?.seoReportLetterheadFields
      ? brandConfig.seoReportLetterheadFields.split(',').map((s) => s.trim()).filter(Boolean)
      : ['logo']);
  const fields = normalizeLetterheadFields(requestedFields);
  const letterhead = filterLetterheadFields(await letterheadForOrg(orgId, 'billing'), fields);
  // drawPdfKitLetterhead treats an explicit `null` logo as "draw nothing" but
  // `undefined` as "use the bundled default" — loadLetterheadLogo itself falls
  // back to the bundled default for a blank URL, so unticking the box has to
  // skip calling it rather than pass it an empty string.
  const logo = letterheadShowsLogo(fields) ? await loadLetterheadLogo(letterhead.logoUrl) : null;
  return { project, brandName, brandColor, letterhead, logo };
}

/** Same row set as the PDF report (every keyword, active or inactive) — spreadsheet-friendly. */
async function generateKeywordCsv(projectId, orgId) {
  const project = await assertProjectAccess(projectId, orgId);
  const keywords = await Keyword.findAll({
    where: { projectId },
    include: [{ association: 'assignedWriter', attributes: ['id', 'name'] }],
    order: SHEET_ORDER,
  });

  const headers = [
    'Main Keyword', 'Supporting Keywords', 'Volume', 'KD', 'Status',
    'Target Location', 'Target Page', 'Target URL', 'Assigned Writer',
  ];
  const rows = keywords.map((k) => [
    k.primaryKeyword,
    normalizeKeywordList(k.secondaryKeywords) || '',
    k.volume ?? '',
    k.kd ?? '',
    k.status === 'inactive' ? 'Inactive' : 'Active',
    k.targetLocation || '',
    k.pageName || '',
    k.targetUrl || '',
    k.assignedWriter?.name || '',
  ]);
  const csv = [headers, ...rows]
    .map((row) => row.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))
    .join('\n');
  return { csv, project };
}

async function generateKeywordReportBuffer(projectId, orgId, letterheadFields) {
  const { project, brandName, brandColor, letterhead, logo } = await _loadSeoReportContext(projectId, orgId, letterheadFields);
  const keywords = await Keyword.findAll({ where: { projectId }, order: SHEET_ORDER });

  const activeCount = keywords.filter((k) => k.status !== 'inactive').length;
  const withVolume = keywords.filter((k) => k.volume != null);
  const avgVolume = withVolume.length
    ? Math.round(withVolume.reduce((sum, k) => sum + k.volume, 0) / withVolume.length)
    : null;
  const withKd = keywords.filter((k) => k.kd != null);
  const avgKd = withKd.length
    ? Math.round(withKd.reduce((sum, k) => sum + k.kd, 0) / withKd.length)
    : null;

  const buffer = await createPdfBuffer((doc) => {
    drawPdfKitLetterhead(doc, letterhead, {
      title: 'KEYWORDS REPORT',
      subtitle: `${project.client?.name || ''} — ${project.name} · Generated ${new Date().toLocaleDateString()}`,
      color: brandColor,
      logo,
    });

    if (keywords.length > 0) {
      // At-a-glance summary before the raw table — what a client-facing agency
      // report leads with, instead of dropping straight into a data dump.
      drawStatCards(doc, [
        { label: 'Total Keywords', value: keywords.length },
        { label: 'Active', value: activeCount },
        { label: 'Avg Search Volume', value: avgVolume != null ? avgVolume.toLocaleString() : '—' },
        { label: 'Avg Difficulty', value: avgKd ?? '—' },
      ], { color: brandColor });
    }

    doc.font('Helvetica-Bold').fontSize(13).fillColor('#111111').text('Keyword Details');
    doc.moveDown(0.5);
    if (keywords.length === 0) {
      doc.font('Helvetica-Oblique').fontSize(10).fillColor('#999999').text('No keywords recorded yet.');
    } else {
      drawTable(doc, {
        headerBg: brandColor,
        headerTextColor: '#FFFFFF',
        columns: [
          { label: 'Sr', key: 'sr', width: 4, align: 'left' },
          { label: 'Main Keyword', key: 'main', width: 15 },
          { label: 'Supporting Keywords', key: 'support', width: 19 },
          { label: 'Volume', key: 'volume', width: 8, align: 'right' },
          {
            label: 'Difficulty', key: 'kd', width: 9, align: 'center',
            render: (d, value, box) => {
              const tier = keywordDifficultyTier(value);
              drawPill(d, tier.label, box, { bg: tier.bg, color: tier.color });
            },
          },
          {
            label: 'Status', key: 'status', width: 8, align: 'center',
            render: (d, value, box) => {
              const tier = keywordStatusTier(value);
              drawPill(d, value, box, { bg: tier.bg, color: tier.color });
            },
          },
          { label: 'Target Location', key: 'location', width: 12 },
          { label: 'Target Page', key: 'page', width: 10 },
        ],
        rows: keywords.map((k, i) => ({
          sr: i + 1,
          main: k.primaryKeyword,
          support: normalizeKeywordList(k.secondaryKeywords) || '—',
          volume: k.volume != null ? k.volume.toLocaleString() : '—',
          kd: k.kd ?? null,
          status: k.status === 'inactive' ? 'Inactive' : 'Active',
          location: k.targetLocation || '—',
          page: k.pageName || '—',
        })),
      });
    }

    drawReportFooter(doc, { leftText: `Generated by ${brandName}` });
  }, {
    layout: 'landscape',
    margin: 40,
    info: {
      Title: `Keywords Report — ${[project.client?.name, project.name].filter(Boolean).join(' — ')}`,
      Author: brandName,
    },
  });

  return { buffer, project };
}

async function generateBacklinkReportBuffer(projectId, orgId, letterheadFields) {
  const { project, brandName, brandColor, letterhead, logo } = await _loadSeoReportContext(projectId, orgId, letterheadFields);
  const backlinks = await Backlink.findAll({
    where: { projectId },
    include: [{ association: 'assignedWriter', attributes: ['id', 'name'] }],
    order: SHEET_ORDER,
  });

  const buffer = await createPdfBuffer((doc) => {
    drawPdfKitLetterhead(doc, letterhead, {
      title: 'BACKLINKS REPORT',
      subtitle: `${project.client?.name || ''} — ${project.name} · Generated ${new Date().toLocaleDateString()}`,
      color: brandColor,
      logo,
    });

    doc.font('Helvetica-Bold').fontSize(13).fillColor('#111111').text(`Backlinks (${backlinks.length})`);
    doc.moveDown(0.5);
    if (backlinks.length === 0) {
      doc.font('Helvetica-Oblique').fontSize(10).fillColor('#999999').text('No backlinks recorded yet.');
    } else {
      drawTable(doc, {
        columns: [
          { label: 'Source URL', key: 'source', width: 14 },
          { label: 'Date', key: 'date', width: 7 },
          { label: 'Anchor', key: 'anchor', width: 8 },
          { label: 'DA', key: 'da', width: 4, align: 'right' },
          { label: 'Type', key: 'type', width: 7 },
          { label: 'Writer', key: 'writer', width: 8 },
          { label: 'Indexed', key: 'indexed', width: 5 },
        ],
        rows: backlinks.map((b) => ({
          source: b.sourceUrl,
          date: b.date || '—',
          anchor: b.anchorText || '—',
          da: b.da ?? '—',
          type: b.linkType,
          writer: b.assignedWriter?.name || '—',
          indexed: b.isIndexed ? 'Yes' : 'No',
        })),
      });
    }

    drawFooter(doc, `Generated by ${brandName}`);
  }, {
    layout: 'landscape',
    margin: 40,
    info: {
      Title: `Backlinks Report — ${[project.client?.name, project.name].filter(Boolean).join(' — ')}`,
      Author: brandName,
    },
  });

  return { buffer, project };
}

module.exports = {
  listKeywords, createKeyword, bulkImportKeywords, reviewKeywordBatch, updateKeyword, deleteKeyword, clearKeywords, bulkDeleteKeywords, bulkActivateKeywords, bulkDeactivateKeywords,
  addRankSnapshot, listRankings, recordRankings, deleteRankingDate, bulkImportRankings,
  listSupportingKeywordRankings, recordSupportingKeywordRankings, updateSupportingKeyword,
  listBacklinks, createBacklink, updateBacklink, deleteBacklink, clearBacklinks, bulkDeleteBacklinks, bulkDeactivateBacklinks, bulkImportBacklinks, bulkUpdateBacklinkStatus,
  listContent, createContent, reviewContent, deleteContent, bulkDeleteContent, syncApprovedContentTasks,
  listBlogTasks, createBlogTask, updateBlogTask,
  listBlogSheet, createBlogSheetRow, submitBlogDeliverable, bulkImportBlogTasks,
  reviewBlogTask, deleteBlogTask, deactivateBlogTask, setBlogTaskActive, bulkDeleteBlogTasks, bulkDeactivateBlogTasks, bulkActivateBlogTasks, syncApprovedBlogTasks,
  generateKeywordReportBuffer, generateBacklinkReportBuffer, generateKeywordCsv, generateBlogCsv,
};
