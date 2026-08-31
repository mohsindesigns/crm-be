const { Op } = require('sequelize');
const db = require('../models');
const { TASK_STATUS } = require('../config/constants');
const TaskService = require('./TaskService');
const ClientRequestService = require('./ClientRequestService');
const HrService = require('./HrService');
const SeoService = require('./SeoService');

/**
 * ApprovalService — the org-wide approval inbox behind `/api/approvals`.
 *
 * There is no `approvals` table and there deliberately isn't one. "Awaiting
 * approval" is a *state* that a dozen unrelated records pass through — a task's
 * technical audit, a requirements email queued for an admin to release, a leave
 * request, an SEO deliverable, a quotation sitting with the client — and each of
 * those already owns its own status column, its own guard rules and its own
 * notification/email side-effects.
 *
 * So this file is two thin things and nothing else:
 *   1. a read-side fan-out that normalizes those rows into one shape, and
 *   2. a `decide()` dispatcher that forwards the decision straight back to the
 *      service that already owns the rules — TaskService.transition/approveAudit,
 *      ClientRequestService.approve/reject, HrService.reviewLeave, and so on.
 *
 * Adding a newly-approvable record means adding one SOURCES entry. Do NOT put
 * approve/reject logic in here: it belongs on the owning service, and this page
 * must go through it or it will silently skip the emails, notifications and
 * cascades that service performs.
 */

const STATUSES = ['pending', 'approved', 'rejected'];

// Per-source ceiling before the merge. The three tabs are review queues, not
// archives — the counts are exact (separate COUNT queries), the rows are the
// most recent N per source.
const PER_SOURCE_LIMIT = 200;

const userAttrs = ['id', 'name', 'email', 'avatarUrl'];

/** Sequelize `include` for a User association, tolerant of a null FK. */
function userInclude(as) {
  return { model: db.User, as, attributes: userAttrs, required: false };
}

function personFrom(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name || row.email || 'Unknown',
    email: row.email || null,
    avatarUrl: row.avatarUrl || null,
  };
}

function badRequest(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function titleCase(s) {
  return String(s || '').replace(/[_-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatDay(d) {
  if (!d) return '—';
  return String(d).slice(0, 10);
}

// ─── Source registry ─────────────────────────────────────────────────────────
//
// Every entry: `label`/`group` for the UI, `canView(ctx)` for whether the queue
// is offered to this user at all, `build(ctx, status)` returning a Sequelize
// query fragment (or null to skip this source for that tab), `map(row, ctx)`
// normalizing one row, and an optional `decide` — omit `decide` for approvals
// this app's staff cannot make from here (a quotation is the client's call; a
// worker's onboarding approval needs a whole salary/designation form on the HR
// page), which renders the row read-only with a deep link instead.

const SOURCES = {
  // ── Tasks flagged "Technical Audit": held unassigned until an admin releases
  // them. Decided via TaskService.approveAudit/rejectAudit, which is what
  // actually promotes pendingAssigneeId → assigneeId on approval.
  task_audit: {
    label: 'Technical audit',
    group: 'Tasks',
    canView: (ctx) => ctx.can('projects.read'),
    build(ctx, status) {
      const where = {
        orgId: ctx.orgId,
        requiresTechnicalAudit: true,
        auditStatus: status,
      };
      // Everyone else only sees audits they raised or are queued to receive —
      // the same pair myTasks' `approvals` scope uses.
      if (!ctx.canSeeAllProjects) {
        where[Op.or] = [{ createdBy: ctx.user.id }, { pendingAssigneeId: ctx.user.id }];
      }
      return {
        where,
        include: [
          { model: db.Project, as: 'project', attributes: ['id', 'name'], required: false },
          userInclude('creator'), userInclude('pendingAssignee'), userInclude('assignee'),
        ],
        order: [['updatedAt', 'DESC']],
      };
    },
    map(t, ctx) {
      return {
        title: t.title,
        subtitle: t.project?.name ? `Task on ${t.project.name}` : 'Task',
        detail: t.remarks || null,
        requester: personFrom(t.creator),
        counterparty: personFrom(t.pendingAssignee || t.assignee),
        counterpartyLabel: 'Proposed assignee',
        submittedAt: t.createdAt,
        decidedAt: t.auditStatus === 'pending' ? null : t.updatedAt,
        href: t.projectId ? `/tasks/${t.projectId}/${t.id}` : null,
        // Mirrors TaskController.approveAudit's own 403 — admins only, and not
        // grantable through a custom role's permission map.
        canAct: ctx.isAdmin,
        actionHint: ctx.isAdmin ? null : 'Only an administrator can decide a technical audit.',
      };
    },
    decide(ctx, id, decision, reason) {
      if (!ctx.isAdmin) {
        throw badRequest('Only an administrator can decide a technical audit.', 403);
      }
      return decision === 'approve'
        ? TaskService.approveAudit(id, ctx.orgId, ctx.user)
        : TaskService.rejectAudit(id, ctx.orgId, ctx.user, reason);
    },
  },

  // ── Work submitted for review by its assignee. Delegates to the normal status
  // transition so the review pipeline, workflow advance rules and task events
  // all fire exactly as they do from the task page.
  task_review: {
    label: 'Task review',
    group: 'Tasks',
    canView: (ctx) => ctx.can('projects.read'),
    build(ctx, status) {
      const statusWhere = {
        pending: { [Op.in]: [TASK_STATUS.SUBMITTED, TASK_STATUS.IN_REVIEW] },
        approved: TASK_STATUS.APPROVED,
        rejected: TASK_STATUS.REJECTED,
      }[status];
      // Always scoped to the requesting user, admins included: a review is
      // owed to a specific reviewer (or the assignee/creator tracking their own
      // submission), not to "whichever admin happens to open this page" — with
      // multiple admins, each should only see reviews actually theirs to make.
      const where = {
        orgId: ctx.orgId,
        status: statusWhere,
        [Op.or]: [
          { assigneeId: ctx.user.id },
          { reviewerId: ctx.user.id },
          { createdBy: ctx.user.id },
        ],
      };
      return {
        where,
        include: [
          { model: db.Project, as: 'project', attributes: ['id', 'name'], required: false },
          userInclude('assignee'), userInclude('reviewer'), userInclude('creator'),
        ],
        order: [['updatedAt', 'DESC']],
      };
    },
    map(t, ctx) {
      // Mirrors TaskService.transition's `effectiveReviewerId` — tasks created
      // before the reviewer column existed fall back to their creator.
      const reviewerId = t.reviewerId || t.createdBy || null;
      const isPending = [TASK_STATUS.SUBMITTED, TASK_STATUS.IN_REVIEW].includes(t.status);
      const isOwnWork = t.assigneeId === ctx.user.id;
      return {
        title: t.title,
        subtitle: t.project?.name ? `Submitted on ${t.project.name}` : 'Task submitted for review',
        detail: t.remarks || null,
        requester: personFrom(t.assignee),
        counterparty: personFrom(t.reviewer || t.creator),
        counterpartyLabel: 'Reviewer',
        submittedAt: t.createdAt,
        decidedAt: isPending ? null : (t.completedAt || t.updatedAt),
        href: t.projectId ? `/tasks/${t.projectId}/${t.id}` : null,
        // TaskService.transition re-checks all of this server-side (including
        // the strategist/PM carve-out it can only resolve with a query); this is
        // the optimistic version, purely so the buttons don't lie.
        canAct: !isOwnWork && (ctx.can('projects.manage') || reviewerId === ctx.user.id),
        actionHint: isOwnWork ? 'You cannot approve your own submission.' : null,
      };
    },
    decide(ctx, id, decision, reason) {
      return TaskService.transition(
        id, ctx.orgId,
        decision === 'approve' ? TASK_STATUS.APPROVED : TASK_STATUS.REJECTED,
        ctx.user,
        decision === 'approve' ? 'approved' : 'changes_requested',
        reason,
      );
    },
  },

  // ── The email approval: a requirements form composed by non-admin staff sits
  // at `pending_approval` and is NOT emailed to the client until an admin
  // releases it here. Approving is the thing that sends the email.
  client_request: {
    label: 'Client email',
    group: 'Clients',
    canView: (ctx) => ctx.can('projects.read'),
    build(ctx, status) {
      const statusWhere = {
        // `sent`/`responded` both mean an admin released it; a `sent` row with
        // no approvedAt predates the approval gate and isn't an outcome.
        pending: { status: 'pending_approval' },
        approved: { status: { [Op.in]: ['sent', 'responded'] }, approvedAt: { [Op.ne]: null } },
        rejected: { status: 'rejected' },
      }[status];
      const where = { orgId: ctx.orgId, ...statusWhere };
      if (!ctx.canSeeAllProjects) where.sentBy = ctx.user.id;
      return {
        where,
        include: [
          { model: db.Project, as: 'project', attributes: ['id', 'name'], required: false },
          { model: db.Client, as: 'client', attributes: ['id', 'name'], required: false },
          userInclude('sender'), userInclude('approver'),
        ],
        order: [['createdAt', 'DESC']],
      };
    },
    map(r, ctx) {
      return {
        title: r.subject || 'Client requirements form',
        subtitle: `To ${r.recipientName || r.recipientEmail}${r.client?.name ? ` · ${r.client.name}` : ''}`,
        detail: r.status === 'rejected' ? r.rejectionReason : (r.project?.name || null),
        requester: personFrom(r.sender),
        counterparty: personFrom(r.approver),
        counterpartyLabel: 'Decided by',
        submittedAt: r.createdAt,
        decidedAt: r.approvedAt || null,
        href: r.projectId ? `/projects/${r.projectId}?tab=client-requests` : null,
        // Same adminOnly gate the /approve route carries — this is the one
        // action in the app that puts mail in a client's inbox.
        canAct: ctx.isAdmin,
        actionHint: ctx.isAdmin
          ? 'Approving emails the form to the client.'
          : 'Only an administrator can release a client email.',
      };
    },
    decide(ctx, id, decision, reason) {
      if (!ctx.isAdmin) {
        throw badRequest('Only an administrator can approve or reject a client requirements form.', 403);
      }
      return decision === 'approve'
        ? ClientRequestService.approve(id, ctx.orgId, ctx.user)
        : ClientRequestService.reject(id, ctx.orgId, ctx.user, reason);
    },
  },

  // ── HR: leave.
  leave: {
    label: 'Leave request',
    group: 'HR',
    canView: (ctx) => ctx.can('hr.read') || !!ctx.workerId,
    build(ctx, status) {
      const where = {
        orgId: ctx.orgId,
        status: { pending: 'requested', approved: 'approved', rejected: 'rejected' }[status],
      };
      // Without hr.read an employee still gets this queue — scoped to the leave
      // they themselves requested, so the page is useful to everyone.
      if (!ctx.can('hr.read')) where.workerId = ctx.workerId;
      return {
        where,
        include: [
          {
            model: db.Worker,
            as: 'worker',
            attributes: ['id', 'designation'],
            required: false,
            include: [userInclude('user')],
          },
          userInclude('approver'),
        ],
        order: [['createdAt', 'DESC']],
      };
    },
    map(l, ctx) {
      const days = Number(l.days || 0);
      return {
        title: `${titleCase(l.type)} leave · ${days} day${days === 1 ? '' : 's'}${l.isHalfDay ? ' (half day)' : ''}`,
        subtitle: `${formatDay(l.fromDate)} → ${formatDay(l.toDate)}`,
        detail: l.status === 'requested' ? l.reason : (l.approverNote || l.reason),
        requester: personFrom(l.worker?.user),
        counterparty: personFrom(l.approver),
        counterpartyLabel: 'Decided by',
        submittedAt: l.createdAt,
        decidedAt: l.status === 'requested' ? null : l.updatedAt,
        href: '/hr?tab=leaves',
        canAct: ctx.can('hr.manage'),
        actionHint: ctx.can('hr.manage') ? null : 'Only HR can decide leave requests.',
      };
    },
    decide(ctx, id, decision, reason) {
      return HrService.reviewLeave(
        id,
        { status: decision === 'approve' ? 'approved' : 'rejected', approverNote: reason },
        ctx.user.id, ctx.orgId,
      );
    },
  },

  // ── HR: contractor invoices submitted for sign-off before payout.
  contractor_invoice: {
    label: 'Contractor invoice',
    group: 'HR',
    canView: (ctx) => ctx.can('hr.read') || !!ctx.workerId,
    build(ctx, status) {
      const statusWhere = {
        pending: 'submitted',
        // `paid` is downstream of approved — it never un-approves the invoice.
        approved: { [Op.in]: ['approved', 'paid'] },
        rejected: 'rejected',
      }[status];
      const where = { orgId: ctx.orgId, status: statusWhere };
      if (!ctx.can('hr.read')) where.workerId = ctx.workerId;
      return {
        where,
        include: [
          {
            model: db.Worker,
            as: 'worker',
            attributes: ['id', 'designation'],
            required: false,
            include: [userInclude('user')],
          },
          userInclude('approver'),
        ],
        order: [['createdAt', 'DESC']],
      };
    },
    map(i, ctx) {
      return {
        title: `${i.currency || ''} ${Number(i.amount || 0).toLocaleString()}`.trim(),
        subtitle: `Contractor invoice · ${i.period || 'no period'}`,
        detail: i.description || i.note || null,
        requester: personFrom(i.worker?.user),
        counterparty: personFrom(i.approver),
        counterpartyLabel: 'Decided by',
        submittedAt: i.createdAt,
        decidedAt: i.status === 'submitted' ? null : i.updatedAt,
        href: '/hr?tab=contractor-invoices',
        canAct: ctx.can('hr.manage'),
        actionHint: ctx.can('hr.manage') ? null : 'Only HR can decide contractor invoices.',
      };
    },
    decide(ctx, id, decision, reason) {
      return HrService.approveContractorInvoice(
        id,
        { status: decision === 'approve' ? 'approved' : 'rejected', note: reason },
        ctx.user.id, ctx.orgId,
      );
    },
  },

  // ── SEO content deliverables. No orgId column on the row itself — these are
  // tenant-scoped through their Project, hence the `required: true` join.
  content_submission: {
    label: 'Content submission',
    group: 'SEO',
    canView: (ctx) => ctx.can('projects.read'),
    build(ctx, status) {
      // `superseded` is history behind a re-opened revision, not an outcome, so
      // matching on the tab's own status is exactly right here. Always scoped
      // to the requesting user (admins included) — reviewed by whoever's
      // assigned to that project, or by whoever submitted it.
      const where = {
        status,
        [Op.or]: [
          { submittedBy: ctx.user.id },
          { projectId: { [Op.in]: ctx.assignedProjectIds } },
        ],
      };
      return {
        where,
        include: [
          {
            model: db.Project, as: 'project', attributes: ['id', 'name'],
            where: { orgId: ctx.orgId }, required: true,
          },
          userInclude('submitter'), userInclude('reviewer'),
        ],
        order: [['createdAt', 'DESC']],
      };
    },
    map(c, ctx) {
      return {
        title: c.pageName || c.fileName || 'Content submission',
        subtitle: `${c.project?.name || 'Project'}${c.revisionNumber > 1 ? ` · revision ${c.revisionNumber}` : ''}`,
        detail: c.rejectionReason || (c.wordCount ? `${c.wordCount} words` : null),
        requester: personFrom(c.submitter),
        counterparty: personFrom(c.reviewer),
        counterpartyLabel: 'Reviewed by',
        submittedAt: c.createdAt,
        decidedAt: c.reviewedAt || null,
        href: c.projectId ? `/projects/${c.projectId}?tab=content` : null,
        fileUrl: c.fileUrl || null,
        canAct: ctx.can('projects.act') && c.submittedBy !== ctx.user.id,
        actionHint: c.submittedBy === ctx.user.id ? 'You cannot review your own submission.' : null,
      };
    },
    decide(ctx, id, decision, reason) {
      return SeoService.reviewContent(
        id,
        { status: decision === 'approve' ? 'approved' : 'rejected', rejectionReason: reason },
        ctx.orgId, ctx.user,
      );
    },
  },

  // ── SEO blog deliverables. Same Project-scoped tenancy as content.
  blog_task: {
    label: 'Blog submission',
    group: 'SEO',
    canView: (ctx) => ctx.can('projects.read'),
    build(ctx, status) {
      // Always scoped to the requesting user (admins included) — see
      // content_submission above for why.
      const where = {
        status,
        isActive: true,
        [Op.or]: [
          { submittedBy: ctx.user.id },
          { assignedWriterId: ctx.user.id },
          { projectId: { [Op.in]: ctx.assignedProjectIds } },
        ],
      };
      return {
        where,
        include: [
          {
            model: db.Project, as: 'project', attributes: ['id', 'name'],
            where: { orgId: ctx.orgId }, required: true,
          },
          userInclude('submitter'), userInclude('reviewer'),
        ],
        order: [['createdAt', 'DESC']],
      };
    },
    map(b, ctx) {
      return {
        title: b.title || b.mainKeyword || 'Blog',
        subtitle: `${b.project?.name || 'Project'}${b.contentType ? ` · ${b.contentType}` : ''}`,
        detail: b.rejectionReason || b.mainKeyword || null,
        requester: personFrom(b.submitter),
        counterparty: personFrom(b.reviewer),
        counterpartyLabel: 'Reviewed by',
        submittedAt: b.createdAt,
        decidedAt: b.reviewedAt || null,
        href: b.projectId ? `/projects/${b.projectId}?tab=blogs` : null,
        fileUrl: b.fileUrl || null,
        canAct: ctx.can('projects.act') && b.submittedBy !== ctx.user.id,
        actionHint: b.submittedBy === ctx.user.id ? 'You cannot review your own submission.' : null,
      };
    },
    decide(ctx, id, decision, reason) {
      return SeoService.reviewBlogTask(
        id,
        { status: decision === 'approve' ? 'approved' : 'rejected', rejectionReason: reason },
        ctx.orgId, ctx.user,
      );
    },
  },

  // ── Bulk keyword-sheet uploads. One row per KeywordBatch, not per keyword —
  // approving/rejecting decides the whole sheet at once (SeoService.reviewKeywordBatch),
  // same "not your own" rule as content_submission/blog_task below.
  keyword_batch: {
    label: 'Keyword upload',
    group: 'SEO',
    canView: (ctx) => ctx.can('projects.read'),
    build(ctx, status) {
      const where = {
        status,
        [Op.or]: [
          { submittedBy: ctx.user.id },
          { projectId: { [Op.in]: ctx.assignedProjectIds } },
        ],
      };
      return {
        where,
        include: [
          {
            model: db.Project, as: 'project', attributes: ['id', 'name'],
            where: { orgId: ctx.orgId }, required: true,
          },
          userInclude('submitter'), userInclude('reviewer'),
        ],
        order: [['createdAt', 'DESC']],
      };
    },
    map(b, ctx) {
      const count = b.rowCount || 0;
      return {
        title: `${count} keyword${count === 1 ? '' : 's'} uploaded`,
        subtitle: `${b.project?.name || 'Project'}${b.fileName ? ` · ${b.fileName}` : ''}`,
        detail: b.rejectionReason || null,
        requester: personFrom(b.submitter),
        counterparty: personFrom(b.reviewer),
        counterpartyLabel: 'Reviewed by',
        submittedAt: b.createdAt,
        decidedAt: b.reviewedAt || null,
        href: b.projectId ? `/projects/${b.projectId}?tab=keywords` : null,
        canAct: ctx.can('projects.act') && b.submittedBy !== ctx.user.id,
        actionHint: b.submittedBy === ctx.user.id ? 'You cannot approve your own upload.' : null,
      };
    },
    decide(ctx, id, decision, reason) {
      return SeoService.reviewKeywordBatch(
        id,
        { status: decision === 'approve' ? 'approved' : 'rejected', rejectionReason: reason },
        ctx.orgId, ctx.user,
      );
    },
  },

  // ── Quotations/agreements out with a prospect. Read-only here on purpose: the
  // *client* approves these from their tokenized public link, so there is no
  // staff-side decide — only visibility into what is still outstanding.
  customer_document: {
    label: 'Quote / agreement',
    group: 'Clients',
    canView: (ctx) => ctx.can('admin.access') || ctx.can('billing.read'),
    build(ctx, status) {
      const statusWhere = {
        pending: { [Op.in]: ['sent', 'viewed'] },
        approved: 'approved',
        rejected: 'rejected',
      }[status];
      const where = { orgId: ctx.orgId, status: statusWhere, isActive: true };
      if (!ctx.can('admin.access')) where.createdBy = ctx.user.id;
      return {
        where,
        include: [
          { model: db.Client, as: 'client', attributes: ['id', 'name'], required: false },
          userInclude('creator'),
        ],
        order: [['createdAt', 'DESC']],
      };
    },
    map(d) {
      return {
        title: `${titleCase(d.type)} ${d.number || ''}`.trim(),
        subtitle: `${d.businessName || d.prospectName || d.client?.name || 'Prospect'} · ${d.currency || ''} ${Number(d.amount || 0).toLocaleString()}`.trim(),
        detail: d.responseNote || null,
        requester: personFrom(d.creator),
        counterparty: d.signerName ? { id: null, name: d.signerName, email: d.email || null, avatarUrl: null } : null,
        counterpartyLabel: 'Signed by',
        submittedAt: d.sentAt || d.createdAt,
        decidedAt: d.respondedAt || null,
        href: `/documents/${d.id}`,
        canAct: false,
        actionHint: 'The client approves this from their own link.',
      };
    },
  },

  // ── Worker onboarding / profile amendments awaiting an admin.
  //
  // Pending and rejected only, deliberately: approving one is not a yes/no click
  // — HrService.onboardWorker also writes designation, salary, pay model and
  // probation end date, which only the HR review form collects. And an approved
  // worker is just `status: 'active'`, indistinguishable from every other active
  // employee, so there is no honest "Approved" row to show. Rows therefore link
  // out to the worker's HR page rather than acting inline.
  worker_profile: {
    label: 'Employee profile',
    group: 'HR',
    canView: (ctx) => ctx.can('hr.read'),
    build(ctx, status) {
      if (status === 'approved') return null;
      // `rejectionReason` is the only durable rejection marker on a Worker.
      // HrService.submitProfile clears it on every resubmission, so the two
      // sets are already disjoint — the status exclusion keeps them provably
      // so even if some other path ever leaves a stale reason behind.
      const where = status === 'pending'
        ? { orgId: ctx.orgId, status: { [Op.in]: ['under_review', 'profile_amended'] } }
        : {
          orgId: ctx.orgId,
          rejectionReason: { [Op.ne]: null },
          status: { [Op.notIn]: ['under_review', 'profile_amended'] },
        };
      return {
        where,
        include: [userInclude('user')],
        order: [['updatedAt', 'DESC']],
      };
    },
    map(w) {
      const isAmendment = w.status === 'profile_amended';
      return {
        title: w.user?.name || 'Employee profile',
        subtitle: isAmendment ? 'Profile amendment submitted' : 'Onboarding profile submitted',
        detail: w.rejectionReason || w.designation || null,
        requester: personFrom(w.user),
        counterparty: null,
        counterpartyLabel: 'Decided by',
        submittedAt: w.createdAt,
        decidedAt: w.rejectionReason ? w.updatedAt : null,
        href: `/hr/workers/${w.id}`,
        canAct: false,
        actionHint: 'Approving also sets pay and designation — open the HR profile to review.',
      };
    },
  },
};

// Kept out of the SOURCES literal so the registry stays declarative and so the
// model lookup happens against a fully-associated `db`.
const MODEL_FOR = {
  task_audit: db.Task,
  task_review: db.Task,
  client_request: db.ClientRequest,
  leave: db.LeaveRequest,
  contractor_invoice: db.ContractorInvoice,
  content_submission: db.ContentSubmission,
  blog_task: db.BlogTask,
  keyword_batch: db.KeywordBatch,
  customer_document: db.CustomerDocument,
  worker_profile: db.Worker,
};

/**
 * Everything a source needs to know about the caller, resolved once per request
 * rather than once per source: role bypasses, the caller's own Worker row (so an
 * employee without hr.read still sees their own leave) and the projects they are
 * assigned to (so a specialist sees their own projects' SEO queues).
 */
async function buildContext(orgId, user) {
  const isAdmin = ['super_admin', 'admin'].includes(user?.role?.key);
  const perms = user?.role?.permissions || {};
  const can = (p) => isAdmin || !!perms[p];

  const [worker, assignments] = await Promise.all([
    db.Worker.findOne({ where: { orgId, userId: user.id }, attributes: ['id'] }),
    db.ProjectAssignment.findAll({ where: { userId: user.id }, attributes: ['projectId'] }),
  ]);

  return {
    orgId,
    user,
    isAdmin,
    can,
    canSeeAllProjects: can('projects.manage'),
    workerId: worker?.id || null,
    // A sentinel rather than `[]`: an empty array inside an Op.or branch makes
    // Sequelize emit `IN (NULL)`, whose NULL result silently swallows the whole
    // OR. A non-matching id keeps the branch a plain, predictable false.
    assignedProjectIds: assignments.length ? assignments.map((a) => a.projectId) : ['__none__'],
  };
}

/** Sources this caller may see at all, honouring an explicit ?type= filter. */
function visibleSourceKeys(ctx, type) {
  return Object.keys(SOURCES).filter((key) => {
    if (type && type !== key) return false;
    return SOURCES[key].canView(ctx);
  });
}

class ApprovalService {
  async buildContext(orgId, user) {
    return buildContext(orgId, user);
  }

  /** The type registry for the frontend's filter chips, minus what this caller can't see. */
  types(ctx) {
    return visibleSourceKeys(ctx, null).map((key) => ({
      key,
      label: SOURCES[key].label,
      group: SOURCES[key].group,
      decidable: !!SOURCES[key].decide,
    }));
  }

  /**
   * One tab's worth of approvals, merged across every source the caller can see
   * and sorted newest-decision-or-submission first.
   */
  async list(orgId, user, { status = 'pending', type = null, q = '' } = {}) {
    if (!STATUSES.includes(status)) throw badRequest('status must be pending, approved or rejected.');
    const ctx = await buildContext(orgId, user);
    // A source with no `decide` (customer_document, worker_profile — see their
    // SOURCES comments) is never actionable from this inbox, by anyone, ever;
    // the client or the HR page owns that decision instead. Surfacing those
    // rows under "Pending" turned the tab into a to-do list with items nobody
    // could ever check off, so they're excluded there — Approved/Rejected
    // still show them as history, which is genuinely useful.
    const keys = visibleSourceKeys(ctx, type).filter((key) => status !== 'pending' || !!SOURCES[key].decide);

    const batches = await Promise.all(keys.map(async (key) => {
      const source = SOURCES[key];
      const built = source.build(ctx, status);
      if (!built) return [];
      const rows = await MODEL_FOR[key].findAll({
        where: built.where,
        include: built.include,
        order: built.order,
        limit: PER_SOURCE_LIMIT,
        subQuery: false,
      });
      return rows.map((row) => ({
        id: row.id,
        type: key,
        typeLabel: source.label,
        group: source.group,
        status,
        decidable: !!source.decide,
        ...source.map(row, ctx),
      }));
    }));

    let items = batches.flat();

    const needle = String(q || '').trim().toLowerCase();
    if (needle) {
      items = items.filter((i) => [i.title, i.subtitle, i.detail, i.requester?.name, i.typeLabel]
        .some((v) => String(v || '').toLowerCase().includes(needle)));
    }

    items.sort((a, b) => {
      const at = new Date(a.decidedAt || a.submittedAt || 0).getTime();
      const bt = new Date(b.decidedAt || b.submittedAt || 0).getTime();
      return bt - at;
    });

    return items;
  }

  /** Exact per-tab and per-type totals — the tab badges must not lie. */
  async counts(orgId, user) {
    const ctx = await buildContext(orgId, user);
    const keys = visibleSourceKeys(ctx, null);

    const totals = { pending: 0, approved: 0, rejected: 0 };
    const byType = {};
    for (const key of keys) byType[key] = { pending: 0, approved: 0, rejected: 0 };

    await Promise.all(keys.flatMap((key) => STATUSES.map(async (status) => {
      // Mirrors list()'s exclusion — a source with no `decide` never belongs in
      // the "Pending" total/badge, since nothing here can ever check it off.
      if (status === 'pending' && !SOURCES[key].decide) return;
      const built = SOURCES[key].build(ctx, status);
      if (!built) return;
      const model = MODEL_FOR[key];
      // `order` is dropped: MySQL rejects ORDER BY on columns outside a COUNT
      // projection. `distinct` guards against the Project/Worker joins fanning
      // a row out (they're belongsTo, so they shouldn't, but a COUNT that's
      // quietly wrong is worse than a marginally slower one).
      const n = await model.count({
        where: built.where,
        include: built.include,
        distinct: true,
        col: 'id',
      });
      totals[status] += n;
      byType[key][status] = n;
    })));

    return { totals, byType };
  }

  /**
   * Record a decision. This never writes a status itself — it hands off to the
   * service that owns the record, so every email/notification/cascade that
   * decision normally triggers still fires, and every guard that service
   * enforces (reviewer identity, "not your own submission", stage rules) still
   * applies. `canAct` on a listed row is only the optimistic UI hint.
   */
  async decide(orgId, user, type, id, { decision, reason } = {}) {
    const source = SOURCES[type];
    if (!source) throw badRequest(`Unknown approval type "${type}".`, 404);
    if (!['approve', 'reject'].includes(decision)) {
      throw badRequest('decision must be "approve" or "reject".');
    }
    if (!source.decide) {
      throw badRequest(`${source.label} approvals can't be decided from here — open the record itself.`);
    }

    const ctx = await buildContext(orgId, user);
    if (!source.canView(ctx)) throw badRequest('You do not have access to this approval.', 403);

    const note = String(reason || '').trim();
    if (decision === 'reject' && !note) {
      throw badRequest('Tell the requester why it was rejected.');
    }

    await source.decide(ctx, id, decision, note || null);
    return {
      type,
      id,
      decision,
      message: `${source.label} ${decision === 'approve' ? 'approved' : 'rejected'}.`,
    };
  }
}

module.exports = new ApprovalService();
