const { Op, fn, col } = require('sequelize');
const db = require('../models');

const {
  User, Role, Task, Project, Backlink, Keyword, ContentSubmission, ProjectAssignment, Client, Package, WhiteLabelConfig, sequelize,
} = db;

const { createPdfBuffer, drawTable, drawReportFooter, drawStatCards, drawPill, BRAND_COLOR } = require('./PdfService');
const { letterheadForOrg, loadLetterheadLogo, drawPdfKitLetterhead, normalizeLetterheadFields, filterLetterheadFields, letterheadShowsLogo } = require('./letterhead');

// Mirrors crm-fe's STRATEGIST_ROLE_PRIORITY (projects/page.tsx) — every project
// gets a Project Strategist slot, falling back to whichever service-specific
// lead is actually filled in when that slot is empty. Keep the two in sync.
const STRATEGIST_ROLE_SLOTS = ['project_strategist', 'social_manager', 'ads_manager', 'account_manager', 'project_manager'];

// Mirrors the workflow engine's own treatment of task completion (see
// workflow/engine.js's ADVANCE_RULE comment) — 'done' and 'approved' are the
// two terminal states a task can end in, depending on whether it went through
// a review pipeline.
const TASK_DONE_STATUSES = ['done', 'approved'];

// Defaults the range to "today" (local server time) when no from/to is given,
// and widens a from-only range to that single day rather than an open-ended
// range — matches how a date-picker with one date filled in reads to a user.
function resolveRange(fromStr, toStr) {
  const now = new Date();
  const from = fromStr
    ? new Date(`${fromStr}T00:00:00`)
    : new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const to = toStr
    ? new Date(`${toStr}T23:59:59.999`)
    : (fromStr
      ? new Date(`${fromStr}T23:59:59.999`)
      : new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999));
  return { from, to };
}

async function getOrgProjectIds(orgId) {
  const rows = await Project.findAll({ where: { orgId }, attributes: ['id'], raw: true });
  return rows.map((r) => r.id);
}

// Groups `model` rows by `userField` within `where`, returning { [userId]: count }.
async function countByUser(model, userField, where, userIds) {
  if (!userIds.length) return {};
  const rows = await model.findAll({
    where: { ...where, [userField]: { [Op.in]: userIds } },
    attributes: [userField, [fn('COUNT', col(model.primaryKeyAttribute)), 'count']],
    group: [userField],
    raw: true,
  });
  const map = {};
  for (const row of rows) map[row[userField]] = Number(row.count);
  return map;
}

async function getMembersOverview(orgId, { from: fromStr, to: toStr, search, roleId } = {}) {
  const { from, to } = resolveRange(fromStr, toStr);

  const userWhere = { orgId, isActive: true };
  if (roleId) userWhere.roleId = roleId;
  if (search) userWhere[Op.or] = [
    { name: { [Op.like]: `%${search}%` } },
    { email: { [Op.like]: `%${search}%` } },
  ];

  const users = await User.findAll({
    where: userWhere,
    include: [{ model: Role, as: 'role', attributes: ['id', 'name', 'key', 'color'] }],
    attributes: ['id', 'name', 'email', 'avatarUrl'],
    order: [['name', 'ASC']],
  });
  if (!users.length) return { from: from.toISOString(), to: to.toISOString(), members: [] };

  const userIds = users.map((u) => u.id);
  const projectIds = await getOrgProjectIds(orgId);

  const [tasksCompleted, tasksOpen, backlinksAdded, contentSubmitted, keywordsAssigned] = await Promise.all([
    countByUser(Task, 'assigneeId', {
      orgId, status: { [Op.in]: TASK_DONE_STATUSES }, completedAt: { [Op.between]: [from, to] },
    }, userIds),
    countByUser(Task, 'assigneeId', {
      orgId, status: { [Op.notIn]: TASK_DONE_STATUSES },
    }, userIds),
    countByUser(Backlink, 'assignedWriterId', {
      isActive: true, projectId: { [Op.in]: projectIds }, createdAt: { [Op.between]: [from, to] },
    }, userIds),
    countByUser(ContentSubmission, 'submittedBy', {
      projectId: { [Op.in]: projectIds }, createdAt: { [Op.between]: [from, to] },
    }, userIds),
    countByUser(Keyword, 'assignedWriterId', {
      projectId: { [Op.in]: projectIds }, status: 'active',
    }, userIds),
  ]);

  const members = users.map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    avatarUrl: u.avatarUrl,
    role: u.role ? { id: u.role.id, name: u.role.name, key: u.role.key, color: u.role.color } : null,
    tasksCompleted: tasksCompleted[u.id] || 0,
    tasksOpen: tasksOpen[u.id] || 0,
    backlinksAdded: backlinksAdded[u.id] || 0,
    contentSubmitted: contentSubmitted[u.id] || 0,
    keywordsAssigned: keywordsAssigned[u.id] || 0,
  }));

  return { from: from.toISOString(), to: to.toISOString(), members };
}

async function getMemberDetail(orgId, userId, { from: fromStr, to: toStr } = {}) {
  const { from, to } = resolveRange(fromStr, toStr);

  const user = await User.findOne({
    where: { id: userId, orgId },
    include: [{ model: Role, as: 'role', attributes: ['id', 'name', 'key', 'color'] }],
    attributes: ['id', 'name', 'email', 'avatarUrl', 'isActive'],
  });
  if (!user) return null;

  const projectIds = await getOrgProjectIds(orgId);
  const projectInclude = [{ model: Project, as: 'project', attributes: ['id', 'name'] }];

  const [
    tasksCompletedRows, tasksOpenCount, backlinkRows, contentRows, keywordRows,
  ] = await Promise.all([
    Task.findAll({
      where: {
        orgId, assigneeId: userId, status: { [Op.in]: TASK_DONE_STATUSES },
        completedAt: { [Op.between]: [from, to] },
      },
      include: projectInclude,
      attributes: ['id', 'title', 'type', 'status', 'stageKey', 'completedAt', 'projectId'],
      order: [['completedAt', 'DESC']],
      limit: 200,
    }),
    Task.count({ where: { orgId, assigneeId: userId, status: { [Op.notIn]: TASK_DONE_STATUSES } } }),
    Backlink.findAll({
      where: {
        isActive: true, projectId: { [Op.in]: projectIds }, assignedWriterId: userId,
        createdAt: { [Op.between]: [from, to] },
      },
      include: projectInclude,
      attributes: ['id', 'sourceUrl', 'domain', 'status', 'linkType', 'date', 'createdAt', 'projectId'],
      order: [['createdAt', 'DESC']],
      limit: 200,
    }),
    ContentSubmission.findAll({
      where: {
        projectId: { [Op.in]: projectIds }, submittedBy: userId,
        createdAt: { [Op.between]: [from, to] },
      },
      include: projectInclude,
      attributes: ['id', 'pageName', 'wordCount', 'status', 'revisionNumber', 'createdAt', 'projectId'],
      order: [['createdAt', 'DESC']],
      limit: 200,
    }),
    Keyword.findAll({
      where: { projectId: { [Op.in]: projectIds }, assignedWriterId: userId, status: 'active' },
      include: projectInclude,
      attributes: ['id', 'primaryKeyword', 'pageName', 'status', 'createdAt', 'projectId'],
      order: [['createdAt', 'DESC']],
      limit: 200,
    }),
  ]);

  const wordCount = contentRows.reduce((sum, c) => sum + (c.wordCount || 0), 0);

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    user: {
      id: user.id, name: user.name, email: user.email, avatarUrl: user.avatarUrl, isActive: user.isActive,
      role: user.role ? { id: user.role.id, name: user.role.name, key: user.role.key, color: user.role.color } : null,
    },
    summary: {
      tasksCompleted: tasksCompletedRows.length,
      tasksOpen: tasksOpenCount,
      backlinksAdded: backlinkRows.length,
      contentSubmitted: contentRows.length,
      wordCount,
      keywordsAssigned: keywordRows.length,
    },
    tasks: tasksCompletedRows,
    backlinks: backlinkRows,
    content: contentRows,
    keywords: keywordRows,
  };
}

// Cross-project keyword sheet, filterable by project, strategist and
// volume/difficulty ranges. Unlike SeoService#listKeywords (scoped to one
// project's sheet), this reads across the whole org, so filtering starts from
// a project-id set (same idConstraints-style narrowing ProjectService.list
// uses) rather than a single findAndCountAll with nested hasMany includes —
// joining Project -> ProjectAssignment there would multiply keyword rows per
// matching role slot and break LIMIT/OFFSET pagination.
async function getKeywordReport(orgId, filters = {}) {
  const page = Math.max(1, parseInt(filters.page, 10) || 1);
  const limit = Math.min(100, parseInt(filters.limit, 10) || 25);
  const offset = (page - 1) * limit;

  let projectIds;
  if (filters.projectId) {
    const project = await Project.findOne({ where: { id: filters.projectId, orgId }, attributes: ['id'] });
    projectIds = project ? [project.id] : [];
  } else {
    projectIds = await getOrgProjectIds(orgId);
  }

  if (filters.strategistId && projectIds.length) {
    const assigned = await ProjectAssignment.findAll({
      where: {
        userId: filters.strategistId,
        roleSlot: { [Op.in]: STRATEGIST_ROLE_SLOTS },
        projectId: { [Op.in]: projectIds },
      },
      attributes: ['projectId'],
      raw: true,
    });
    const allowed = new Set(assigned.map((a) => a.projectId));
    projectIds = projectIds.filter((id) => allowed.has(id));
  }

  if (!projectIds.length) {
    return { data: [], total: 0, page, totalPages: 1, limit };
  }

  const where = { projectId: { [Op.in]: projectIds } };
  const volumeMin = filters.volumeMin != null && filters.volumeMin !== '' ? parseInt(filters.volumeMin, 10) : null;
  const volumeMax = filters.volumeMax != null && filters.volumeMax !== '' ? parseInt(filters.volumeMax, 10) : null;
  if (volumeMin != null || volumeMax != null) {
    where.volume = {};
    if (volumeMin != null) where.volume[Op.gte] = volumeMin;
    if (volumeMax != null) where.volume[Op.lte] = volumeMax;
  }
  const difficultyMin = filters.difficultyMin != null && filters.difficultyMin !== '' ? parseInt(filters.difficultyMin, 10) : null;
  const difficultyMax = filters.difficultyMax != null && filters.difficultyMax !== '' ? parseInt(filters.difficultyMax, 10) : null;
  if (difficultyMin != null || difficultyMax != null) {
    where.kd = {};
    if (difficultyMin != null) where.kd[Op.gte] = difficultyMin;
    if (difficultyMax != null) where.kd[Op.lte] = difficultyMax;
  }
  if (filters.status === 'active' || filters.status === 'inactive') {
    where.status = filters.status;
  }
  if (filters.search) {
    const term = `%${filters.search}%`;
    where[Op.or] = [
      { primaryKeyword: { [Op.like]: term } },
      { secondaryKeywords: { [Op.like]: term } },
    ];
  }

  // Current rank = latest RankSnapshot per keyword (by date). Pulled as a
  // correlated subquery rather than a second query so it can also drive
  // ORDER BY when sorting by rank, and pagination stays correct — Keyword's
  // only include here is a belongsTo (Project), so Sequelize keeps `Keyword`
  // as the literal main-table alias instead of wrapping in a subquery.
  const currentRankLiteral = sequelize.literal(
    '(SELECT `rs`.`position` FROM `rank_snapshots` AS `rs` WHERE `rs`.`keywordId` = `Keyword`.`id` ORDER BY `rs`.`date` DESC LIMIT 1)',
  );

  const dir = String(filters.sortDir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  let order;
  if (filters.sortBy === 'volume') order = [['volume', dir]];
  else if (filters.sortBy === 'difficulty') order = [['kd', dir]];
  else if (filters.sortBy === 'rank') order = [[currentRankLiteral, dir]];
  else order = [['createdAt', 'DESC']];

  const { count, rows } = await Keyword.findAndCountAll({
    where,
    include: [{ 
      model: Project, 
      as: 'project', 
      attributes: ['id', 'name'],
      include: [
        { model: Client, as: 'client', attributes: ['name'] },
        { model: Package, as: 'package', attributes: ['name', 'tier'] },
      ],
    }],
    attributes: { include: [[currentRankLiteral, 'currentRank']] },
    order,
    limit,
    offset,
  });

  // Resolve strategist per project for just this page's rows, not the whole org.
  const pageProjectIds = [...new Set(rows.map((r) => r.projectId))];
  const assignments = pageProjectIds.length
    ? await ProjectAssignment.findAll({
      where: { projectId: { [Op.in]: pageProjectIds }, roleSlot: { [Op.in]: STRATEGIST_ROLE_SLOTS } },
      include: [{ model: User, as: 'user', attributes: ['id', 'name'] }],
    })
    : [];
  const strategistByProject = {};
  for (const slot of STRATEGIST_ROLE_SLOTS) {
    for (const a of assignments) {
      if (a.roleSlot === slot && !strategistByProject[a.projectId] && a.user) {
        strategistByProject[a.projectId] = { id: a.user.id, name: a.user.name };
      }
    }
  }

  const data = rows.map((kw) => ({
    id: kw.id,
    projectId: kw.projectId,
    projectName: kw.project?.name || '—',
    clientName: kw.project?.client?.name || '—',
    packageName: kw.project?.package ? (kw.project.package.tier || kw.project.package.name) : '—',
    strategist: strategistByProject[kw.projectId] || null,
    primaryKeyword: kw.primaryKeyword,
    secondaryKeywords: kw.secondaryKeywords,
    volume: kw.volume,
    kd: kw.kd,
    targetLocation: kw.targetLocation,
    pageName: kw.pageName,
    status: kw.status,
    currentRank: kw.get('currentRank'),
  }));

  return { data, total: count, page, totalPages: Math.ceil(count / limit) || 1, limit };
}

async function getKeywordSummary(orgId, filters = {}) {
  const page = Math.max(1, parseInt(filters.page, 10) || 1);
  const limit = Math.min(100, parseInt(filters.limit, 10) || 25);
  const offset = (page - 1) * limit;

  // Keyword Reports is an SEO-only screen — a project with no keyword sheet
  // at all (every non-SEO service type) has no business showing up here as a
  // "0 keywords" row.
  let projectIds;
  if (filters.projectId) {
    const project = await Project.findOne({ where: { id: filters.projectId, orgId, serviceTypeKey: 'seo' }, attributes: ['id'] });
    projectIds = project ? [project.id] : [];
  } else {
    const seoProjects = await Project.findAll({ where: { orgId, serviceTypeKey: 'seo' }, attributes: ['id'], raw: true });
    projectIds = seoProjects.map((p) => p.id);
  }

  if (filters.strategistId && projectIds.length) {
    const assigned = await ProjectAssignment.findAll({
      where: {
        userId: filters.strategistId,
        roleSlot: { [Op.in]: STRATEGIST_ROLE_SLOTS },
        projectId: { [Op.in]: projectIds },
      },
      attributes: ['projectId'],
      raw: true,
    });
    const allowed = new Set(assigned.map((a) => a.projectId));
    projectIds = projectIds.filter((id) => allowed.has(id));
  }

  if (!projectIds.length) {
    return { data: [], total: 0, page, totalPages: 1, limit };
  }

  const projects = await Project.findAndCountAll({
    where: { id: { [Op.in]: projectIds } },
    include: [
      { model: Client, as: 'client', attributes: ['name'] },
      { model: Package, as: 'package', attributes: ['name', 'tier'] },
    ],
    limit,
    offset,
    // `createdAt` alone isn't unique — rows sharing a timestamp (bulk
    // import/seed) sort in undefined order between requests, which lets the
    // same project land on two different pages (or get skipped) under
    // LIMIT/OFFSET. `id` as a tiebreaker makes the order — and therefore the
    // page split — deterministic, so a project appears exactly once.
    order: [['createdAt', 'DESC'], ['id', 'ASC']],
  });

  const pageProjectIds = projects.rows.map(p => p.id);

  const keywords = pageProjectIds.length ? await Keyword.findAll({
    where: { projectId: { [Op.in]: pageProjectIds }, status: 'active' },
    attributes: ['projectId', 'volume', 'kd'],
  }) : [];

  const assignments = pageProjectIds.length
    ? await ProjectAssignment.findAll({
      where: { projectId: { [Op.in]: pageProjectIds }, roleSlot: { [Op.in]: STRATEGIST_ROLE_SLOTS } },
      include: [{ model: User, as: 'user', attributes: ['id', 'name'] }],
    })
    : [];
  
  const strategistByProject = {};
  for (const slot of STRATEGIST_ROLE_SLOTS) {
    for (const a of assignments) {
      if (a.roleSlot === slot && !strategistByProject[a.projectId] && a.user) {
        strategistByProject[a.projectId] = { id: a.user.id, name: a.user.name };
      }
    }
  }

  // Aggregate keywords per project
  const statsByProject = {};
  for (const kw of keywords) {
    if (!statsByProject[kw.projectId]) {
      statsByProject[kw.projectId] = { total: 0, volSum: 0, volCount: 0, kdSum: 0, kdCount: 0 };
    }
    const st = statsByProject[kw.projectId];
    st.total += 1;
    if (kw.volume != null) { st.volSum += Number(kw.volume); st.volCount += 1; }
    if (kw.kd != null) { st.kdSum += Number(kw.kd); st.kdCount += 1; }
  }

  const data = projects.rows.map(p => {
    const st = statsByProject[p.id] || { total: 0, volSum: 0, volCount: 0, kdSum: 0, kdCount: 0 };
    return {
      projectId: p.id,
      projectName: p.name,
      clientName: p.client?.name || '—',
      packageName: p.package ? (p.package.tier || p.package.name) : '—',
      strategist: strategistByProject[p.id] || null,
      totalKeywords: st.total,
      avgVolume: st.volCount ? Math.round(st.volSum / st.volCount) : null,
      avgKd: st.kdCount ? Math.round(st.kdSum / st.kdCount) : null,
    };
  });

  return { data, total: projects.count, page, totalPages: Math.ceil(projects.count / limit) || 1, limit };
}

function keywordDifficultyTier(kd) {
  if (kd == null) return { label: '—', bg: '#F3F4F6', color: '#6B7280' };
  if (kd <= 14) return { label: 'Very easy', bg: '#DCFCE7', color: '#166534' };
  if (kd <= 29) return { label: 'Easy', bg: '#FEF08A', color: '#854D0E' };
  if (kd <= 49) return { label: 'Possible', bg: '#FED7AA', color: '#9A3412' };
  if (kd <= 69) return { label: 'Hard', bg: '#FECACA', color: '#991B1B' };
  if (kd <= 84) return { label: 'Very hard', bg: '#FCA5A5', color: '#7F1D1D' };
  return { label: 'Super hard', bg: '#EF4444', color: '#450A0A' };
}

async function _loadGlobalSeoReportContext(orgId, letterheadFields) {
  const brandConfig = await WhiteLabelConfig.findOne({ where: { orgId } });
  const brandName = brandConfig?.brandName || 'Mohsin Designs Project Management';
  const brandColor = brandConfig?.primaryColor || BRAND_COLOR;
  const requestedFields = letterheadFields != null
    ? letterheadFields
    : (brandConfig?.seoReportLetterheadFields
      ? brandConfig.seoReportLetterheadFields.split(',').map((s) => s.trim()).filter(Boolean)
      : ['logo']);
  const fields = normalizeLetterheadFields(requestedFields);
  const letterhead = filterLetterheadFields(await letterheadForOrg(orgId, 'billing'), fields);
  const logo = letterheadShowsLogo(fields) ? await loadLetterheadLogo(letterhead.logoUrl) : null;
  return { brandName, brandColor, letterhead, logo };
}

async function exportKeywords(orgId, format, ids, filters = {}, letterheadFields = null) {
  let data;
  if (ids && ids.length) {
    const page = await getKeywordReport(orgId, { ...filters, limit: 10000 });
    data = page.data.filter(r => ids.includes(r.id));
  } else {
    const page = await getKeywordReport(orgId, { ...filters, limit: 10000 });
    data = page.data;
  }

  if (format === 'csv') {
    const headers = ['Client', 'Package', 'Strategist', 'Main Keyword', 'Supporting Keywords', 'Volume', 'Difficulty', 'Rank', 'Location', 'Page'];
    const rows = data.map(k => [
      k.clientName || '', k.packageName || '', k.strategist?.name || '',
      k.primaryKeyword || '', k.secondaryKeywords || '', k.volume ?? '', k.kd ?? '',
      k.currentRank ?? '', k.targetLocation || '', k.pageName || ''
    ]);
    const csv = [headers, ...rows].map(r => r.map(v => '"' + String(v ?? '').replace(/"/g, '""') + '"').join(',')).join('\n');
    return { buffer: Buffer.from(csv, 'utf8'), ext: 'csv', mime: 'text/csv' };
  } else {
    const { brandColor, letterhead, logo } = await _loadGlobalSeoReportContext(orgId, letterheadFields);
    const buffer = await createPdfBuffer((doc) => {
      drawPdfKitLetterhead(doc, letterhead, {
        title: 'GLOBAL KEYWORDS REPORT',
        subtitle: `Generated ${new Date().toLocaleDateString()}`,
        color: brandColor,
        logo,
      });
      doc.font('Helvetica-Bold').fontSize(13).fillColor('#111111').text('Keyword Details');
      doc.moveDown(0.5);
      if (data.length === 0) {
        doc.font('Helvetica-Oblique').fontSize(10).fillColor('#999999').text('No keywords to export.');
      } else {
        drawTable(doc, {
          headerBg: brandColor,
          headerTextColor: '#FFFFFF',
          columns: [
            { label: 'Client', key: 'clientName', width: 12, align: 'left' },
            { label: 'Package', key: 'packageName', width: 12, align: 'left' },
            { label: 'Main Keyword', key: 'primaryKeyword', width: 15 },
            { label: 'Volume', key: 'volume', width: 8, align: 'right' },
            {
              label: 'Difficulty', key: 'kd', width: 9, align: 'center',
              render: (d, value, box) => {
                const tier = keywordDifficultyTier(value);
                drawPill(d, tier.label, box, { bg: tier.bg, color: tier.color });
              },
            },
            { label: 'Rank', key: 'currentRank', width: 6, align: 'right' },
          ],
          rows: data
        });
      }
      drawReportFooter(doc, brandColor);
    });
    return { buffer, ext: 'pdf', mime: 'application/pdf' };
  }
}

async function exportKeywordSummary(orgId, format, ids, filters = {}, letterheadFields = null) {
  let data;
  if (ids && ids.length) {
    const page = await getKeywordSummary(orgId, { ...filters, limit: 10000 });
    data = page.data.filter(r => ids.includes(r.projectId));
  } else {
    const page = await getKeywordSummary(orgId, { ...filters, limit: 10000 });
    data = page.data;
  }

  if (format === 'csv') {
    const headers = ['Client', 'Package', 'Strategist', 'Total Keywords', 'Avg Volume', 'Avg KD'];
    const rows = data.map(r => [
      r.clientName || '', r.packageName || '', r.strategist?.name || '',
      r.totalKeywords || 0, r.avgVolume ?? '', r.avgKd ?? ''
    ]);
    const csv = [headers, ...rows].map(row => row.map(v => '"' + String(v ?? '').replace(/"/g, '""') + '"').join(',')).join('\n');
    return { buffer: Buffer.from(csv, 'utf8'), ext: 'csv', mime: 'text/csv' };
  } else {
    const { brandColor, letterhead, logo } = await _loadGlobalSeoReportContext(orgId, letterheadFields);
    const buffer = await createPdfBuffer((doc) => {
      drawPdfKitLetterhead(doc, letterhead, {
        title: 'GLOBAL KEYWORDS SUMMARY',
        subtitle: `Generated ${new Date().toLocaleDateString()}`,
        color: brandColor,
        logo,
      });
      doc.font('Helvetica-Bold').fontSize(13).fillColor('#111111').text('Project Summaries');
      doc.moveDown(0.5);
      if (data.length === 0) {
        doc.font('Helvetica-Oblique').fontSize(10).fillColor('#999999').text('No summaries to export.');
      } else {
        drawTable(doc, {
          headerBg: brandColor,
          headerTextColor: '#FFFFFF',
          columns: [
            { label: 'Client', key: 'clientName', width: 15, align: 'left' },
            { label: 'Package', key: 'packageName', width: 15, align: 'left' },
            { label: 'Strategist', key: 'strategist', width: 15, render: (d, v) => v ? v.name : '—' },
            { label: 'Total Keywords', key: 'totalKeywords', width: 10, align: 'right' },
            { label: 'Avg Volume', key: 'avgVolume', width: 10, align: 'right' },
            { label: 'Avg KD', key: 'avgKd', width: 10, align: 'right' },
          ],
          rows: data
        });
      }
      drawReportFooter(doc, brandColor);
    });
    return { buffer, ext: 'pdf', mime: 'application/pdf' };
  }
}

// ─── Backlinks summary ──────────────────────────────────────────────────────
//
// One row per (project, link builder) pair: that builder's link count for the
// selected day next to the project's overall link health (total / indexed /
// non-indexed / duplicate), so a PM can see both "did today's quota get hit"
// and "how healthy is this project's link profile" without opening every
// project individually. Mirrors getKeywordSummary's project/client scoping
// (backlinks, like keywords, is an SEO-only sheet), plus a date filter —
// defaulting to today, same as getMembersOverview — since "links made in the
// day" is inherently date-scoped in a way a keyword count isn't.
async function getBacklinkSummary(orgId, filters = {}) {
  const page = Math.max(1, parseInt(filters.page, 10) || 1);
  const limit = Math.min(100, parseInt(filters.limit, 10) || 25);
  const offset = (page - 1) * limit;

  // No date filter by default — every project/builder pair with any backlink
  // activity shows up, not just today's. A day picked explicitly narrows
  // "links made" down to that one day; leaving it blank means "all time",
  // same as how the client/project filters read when left on "All".
  const targetDateStr = filters.date || null;
  const { from, to } = targetDateStr ? resolveRange(targetDateStr, targetDateStr) : { from: null, to: null };

  const projectWhere = { orgId, serviceTypeKey: 'seo' };
  if (filters.projectId) projectWhere.id = filters.projectId;
  if (filters.clientId) projectWhere.clientId = filters.clientId;

  const projects = await Project.findAll({
    where: projectWhere,
    include: [{ model: Client, as: 'client', attributes: ['id', 'name'] }],
    attributes: ['id', 'name', 'startDate', 'clientId'],
  });
  if (!projects.length) {
    return {
      data: [], total: 0, page, totalPages: 1, limit,
      from: from ? from.toISOString() : null,
      to: to ? to.toISOString() : null,
    };
  }
  const projectIds = projects.map((p) => p.id);
  const projectById = new Map(projects.map((p) => [p.id, p]));

  const backlinks = await Backlink.findAll({
    where: { projectId: { [Op.in]: projectIds }, isActive: true },
    attributes: ['id', 'projectId', 'assignedWriterId', 'sourceUrl', 'isIndexed', 'createdAt', 'date'],
  });

  // Project-wide totals — independent of link builder and of the date filter.
  // "Duplicate" mirrors the exact rule the project's own Backlinks tab uses
  // (projects/[id]/page.tsx): a link is a duplicate when its sourceUrl
  // (trimmed, lowercased) appears more than once within the project.
  const byProject = new Map();
  for (const bl of backlinks) {
    if (!byProject.has(bl.projectId)) byProject.set(bl.projectId, []);
    byProject.get(bl.projectId).push(bl);
  }
  const statsByProject = {};
  for (const [projectId, rows] of byProject) {
    const urlCounts = new Map();
    for (const bl of rows) {
      const key = (bl.sourceUrl || '').trim().toLowerCase();
      if (key) urlCounts.set(key, (urlCounts.get(key) || 0) + 1);
    }
    let indexed = 0;
    let duplicate = 0;
    for (const bl of rows) {
      if (bl.isIndexed) indexed += 1;
      const key = (bl.sourceUrl || '').trim().toLowerCase();
      if (key && urlCounts.get(key) > 1) duplicate += 1;
    }
    statsByProject[projectId] = { total: rows.length, indexed, nonIndexed: rows.length - indexed, duplicate };
  }

  // Activity per link builder — every builder who has ever added a link gets
  // a row by default; picking a day narrows that down to links whose own
  // publish date (`Backlink.date`, the "Publish date" column link builders
  // fill in on the project's Backlinks tab) falls on that day. createdAt
  // (when the row was typed into the CRM) is only used as a fallback for
  // older rows that predate the publish-date field, since it routinely
  // diverges from the real publish date — e.g. a builder backfilling a
  // week's worth of already-published links in one sitting.
  const countsByKey = new Map();
  for (const bl of backlinks) {
    if (!bl.assignedWriterId) continue;
    if (filters.linkBuilderId && bl.assignedWriterId !== filters.linkBuilderId) continue;
    if (targetDateStr) {
      const activityDateStr = bl.date || (bl.createdAt
        ? `${bl.createdAt.getFullYear()}-${String(bl.createdAt.getMonth() + 1).padStart(2, '0')}-${String(bl.createdAt.getDate()).padStart(2, '0')}`
        : null);
      if (activityDateStr !== targetDateStr) continue;
    }
    const key = `${bl.projectId}:${bl.assignedWriterId}`;
    countsByKey.set(key, (countsByKey.get(key) || 0) + 1);
  }

  const builderIds = [...new Set([...countsByKey.keys()].map((k) => k.split(':')[1]))];
  const builders = builderIds.length
    ? await User.findAll({ where: { id: { [Op.in]: builderIds } }, attributes: ['id', 'name'] })
    : [];
  const builderById = new Map(builders.map((u) => [u.id, u]));

  const allRows = [...countsByKey.entries()].map(([key, count]) => {
    const [projectId, builderId] = key.split(':');
    const project = projectById.get(projectId);
    const st = statsByProject[projectId] || { total: 0, indexed: 0, nonIndexed: 0, duplicate: 0 };
    return {
      linkBuilderId: builderId,
      linkBuilderName: builderById.get(builderId)?.name || 'Unknown',
      clientId: project?.clientId || null,
      clientName: project?.client?.name || '—',
      projectId,
      projectName: project?.name || '—',
      projectStartDate: project?.startDate || null,
      linksMadeInDay: count,
      projectTotalBacklinks: st.total,
      totalIndexed: st.indexed,
      totalNonIndexed: st.nonIndexed,
      totalDuplicate: st.duplicate,
    };
  }).sort((a, b) => b.linksMadeInDay - a.linksMadeInDay || a.linkBuilderName.localeCompare(b.linkBuilderName));

  const total = allRows.length;
  const data = allRows.slice(offset, offset + limit);

  return {
    data, total, page, totalPages: Math.ceil(total / limit) || 1, limit,
    from: from ? from.toISOString() : null,
    to: to ? to.toISOString() : null,
  };
}

async function exportBacklinkSummary(orgId, format, ids, filters = {}, letterheadFields = null) {
  const built = await getBacklinkSummary(orgId, { ...filters, limit: 10000 });
  const data = ids && ids.length
    ? built.data.filter((r) => ids.includes(`${r.projectId}:${r.linkBuilderId}`))
    : built.data;

  if (format === 'csv') {
    const headers = [
      'Link Builder', 'Client', 'Project', 'Project Start Date', filters.date ? 'Links Made' : 'Links Made (All Time)',
      'Project Total Backlinks', 'Total Indexed', 'Total Non-Indexed', 'Total Duplicate',
    ];
    const rows = data.map((r) => [
      r.linkBuilderName || '', r.clientName || '', r.projectName || '', r.projectStartDate || '',
      r.linksMadeInDay || 0, r.projectTotalBacklinks || 0, r.totalIndexed || 0, r.totalNonIndexed || 0, r.totalDuplicate || 0,
    ]);
    const csv = [headers, ...rows].map((row) => row.map((v) => '"' + String(v ?? '').replace(/"/g, '""') + '"').join(',')).join('\n');
    return { buffer: Buffer.from(csv, 'utf8'), ext: 'csv', mime: 'text/csv' };
  }

  const { brandColor, letterhead, logo } = await _loadGlobalSeoReportContext(orgId, letterheadFields);
  const buffer = await createPdfBuffer((doc) => {
    drawPdfKitLetterhead(doc, letterhead, {
      title: 'GLOBAL BACKLINKS SUMMARY',
      subtitle: `Generated ${new Date().toLocaleDateString()}`,
      color: brandColor,
      logo,
    });
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#111111').text('Link Builder Activity');
    doc.moveDown(0.5);
    if (data.length === 0) {
      doc.font('Helvetica-Oblique').fontSize(10).fillColor('#999999').text('No activity to export.');
    } else {
      drawTable(doc, {
        headerBg: brandColor,
        headerTextColor: '#FFFFFF',
        columns: [
          { label: 'Link Builder', key: 'linkBuilderName', width: 14, align: 'left' },
          { label: 'Client', key: 'clientName', width: 13, align: 'left' },
          { label: 'Project', key: 'projectName', width: 13, align: 'left' },
          { label: filters.date ? 'Made' : 'Made (All Time)', key: 'linksMadeInDay', width: 8, align: 'right' },
          { label: 'Total Links', key: 'projectTotalBacklinks', width: 8, align: 'right' },
          { label: 'Indexed', key: 'totalIndexed', width: 8, align: 'right' },
          { label: 'Non-Indexed', key: 'totalNonIndexed', width: 8, align: 'right' },
          { label: 'Duplicate', key: 'totalDuplicate', width: 8, align: 'right' },
        ],
        rows: data,
      });
    }
    drawReportFooter(doc, brandColor);
  });
  return { buffer, ext: 'pdf', mime: 'application/pdf' };
}

module.exports = {
  getMembersOverview, getMemberDetail, getKeywordReport, getKeywordSummary, exportKeywords, exportKeywordSummary,
  getBacklinkSummary, exportBacklinkSummary,
};
