const { v4: uuidv4 } = require('uuid');
const { Op } = require('sequelize');
const db = require('../models');
const { PROJECT_STATUS } = require('../config/constants');
const { buildProjectName } = require('../utils/projectName');

class ProjectService {
  async list(orgId, filters = {}, caller = null) {
    const page  = Math.max(1, parseInt(filters.page)  || 1);
    const limit = Math.min(100, parseInt(filters.limit) || 25);
    const offset = (page - 1) * limit;

    // Admins see all projects; everyone else sees only projects they're assigned to
    const isAdmin = caller?.role?.key === 'super_admin' || caller?.role?.key === 'admin';
    const callerId = caller?.id;

    const where = { orgId };
    if (filters.clientId) where.clientId = filters.clientId;
    if (filters.status) where.status = filters.status;
    // "Hide cancelled" checkbox — only applies when no explicit status was picked,
    // so choosing "Cancelled" in the status dropdown still works as expected.
    else if (filters.excludeCancelled === 'true' || filters.excludeCancelled === true) where.status = { [Op.ne]: 'cancelled' };
    if (filters.serviceTypeKey) where.serviceTypeKey = filters.serviceTypeKey;
    if (filters.currentStageKey) where.currentStageKey = filters.currentStageKey;
    if (filters.isRecurring !== undefined) where.isRecurring = filters.isRecurring === 'true' || filters.isRecurring === true;
    // Overdue: has a delivery date in the past. If no explicit status filter was also
    // given, default to excluding completed/cancelled (an overdue-but-finished
    // project isn't useful to surface) — but don't clobber an explicit status choice.
    if (filters.overdue === 'true' || filters.overdue === true) {
      where.deliveryDate = { [Op.lt]: new Date().toISOString().split('T')[0] };
      if (!filters.status) where.status = { [Op.notIn]: ['completed', 'cancelled'] };
    }

    if (filters.search) {
      const matchingClients = await db.Client.findAll({
        where: { orgId, name: { [Op.like]: `%${filters.search}%` } },
        attributes: ['id'],
      });
      const clientIds = matchingClients.map((c) => c.id);
      where[Op.or] = [
        { name: { [Op.like]: `%${filters.search}%` } },
        ...(clientIds.length ? [{ clientId: { [Op.in]: clientIds } }] : []),
      ];
    }

    // Independent "project id must be in this set" constraints, intersected below —
    // lets non-admin scoping, the role-slot picker (e.g. Project Strategist), and the
    // team-member picker (any role) all combine instead of overwriting each other.
    const idConstraints = [];

    // Non-admins: only projects they're assigned to (any role) OR have a task on —
    // e.g. a content writer given a keyword-level "write this page" task never
    // gets a Team-section ProjectAssignment row (that slot is one-person-per-
    // project, but several writers can each have their own page on the same
    // project), so ProjectAssignment alone would wrongly hide the project from them.
    if (!isAdmin && callerId) {
      const [myAssignments, myTasks] = await Promise.all([
        db.ProjectAssignment.findAll({ where: { userId: callerId }, attributes: ['projectId'] }),
        db.Task.findAll({ where: { assigneeId: callerId }, attributes: ['projectId'] }),
      ]);
      const myProjectIds = new Set([
        ...myAssignments.map((a) => a.projectId),
        ...myTasks.map((t) => t.projectId),
      ]);
      idConstraints.push(Array.from(myProjectIds));
    }

    // "Assigned to this person in this role slot" — the Project Strategist picker.
    // roleSlot may be a comma-separated list (the strategist role varies by service —
    // project_strategist for every service type, social_manager for Social, etc.) so any one match counts.
    if (filters.assignedUserId) {
      const assignWhere = { userId: filters.assignedUserId };
      if (filters.roleSlot) {
        const slots = String(filters.roleSlot).split(',').map((s) => s.trim()).filter(Boolean);
        assignWhere.roleSlot = slots.length > 1 ? { [Op.in]: slots } : slots[0];
      }
      const matches = await db.ProjectAssignment.findAll({ where: assignWhere, attributes: ['projectId'] });
      idConstraints.push(matches.map((a) => a.projectId));
    }

    // "Assigned to this person in any role" — the generic team-member picker.
    if (filters.teamMemberId) {
      const matches = await db.ProjectAssignment.findAll({
        where: { userId: filters.teamMemberId },
        attributes: ['projectId'],
      });
      idConstraints.push(matches.map((a) => a.projectId));
    }

    if (idConstraints.length) {
      let ids = idConstraints[0];
      for (let i = 1; i < idConstraints.length; i++) {
        const set = new Set(idConstraints[i]);
        ids = ids.filter((id) => set.has(id));
      }
      if (ids.length === 0) {
        // Nothing satisfies every constraint at once — return empty immediately.
        return { data: [], total: 0, page, totalPages: 0, limit };
      }
      where.id = { [Op.in]: ids };
    }

    const { count, rows } = await db.Project.findAndCountAll({
      where,
      include: [
        { model: db.Client, as: 'client', attributes: ['id', 'name'] },
        { model: db.WorkflowTemplate, as: 'template', attributes: ['id', 'name'] },
        { model: db.ProjectAssignment, as: 'assignments', separate: true, include: [{ model: db.User, as: 'user', attributes: ['id', 'name', 'avatarUrl'] }] },
      ],
      order: [['createdAt', 'DESC']],
      limit,
      offset,
      distinct: true,
    });

    return { data: rows, total: count, page, totalPages: Math.ceil(count / limit) || 1, limit };
  }

  async findById(id, orgId, caller = null) {
    const isAdmin = caller?.role?.key === 'super_admin' || caller?.role?.key === 'admin';
    const callerId = caller?.id;

    // Non-admins must be assigned to the project OR have a task on it to view it —
    // see the matching comment in list() for why a task alone must also count.
    if (!isAdmin && callerId) {
      const assigned = await db.ProjectAssignment.findOne({ where: { projectId: id, userId: callerId } });
      if (!assigned) {
        const hasTask = await db.Task.findOne({ where: { projectId: id, assigneeId: callerId } });
        if (!hasTask) {
          const err = new Error('Project not found.');
          err.status = 404;
          throw err;
        }
      }
    }

    const project = await db.Project.findOne({
      where: { id, orgId },
      include: [
        { model: db.Client, as: 'client' },
        { model: db.WorkflowTemplate, as: 'template', include: [{ model: db.Stage, as: 'stages', separate: true, order: [['orderIndex', 'ASC']] }] },
        { model: db.ProjectAssignment, as: 'assignments', include: [{ model: db.User, as: 'user', attributes: ['id', 'name', 'avatarUrl'] }] },
      ],
    });
    if (!project) {
      const err = new Error('Project not found.');
      err.status = 404;
      throw err;
    }
    return project;
  }

  async create(orgId, data, createdBy) {
    const template = await db.WorkflowTemplate.findOne({
      where: { id: data.workflowTemplateId, orgId, isActive: true },
    });

    if (!template) {
      const err = new Error('Workflow template not found or inactive.');
      err.status = 404;
      throw err;
    }

    const firstStage = await db.Stage.findOne({
      where: { templateId: template.id },
      order: [['orderIndex', 'ASC']],
    });
    if (!firstStage) {
      const err = new Error('Workflow template has no stages.');
      err.status = 400;
      throw err;
    }

    const [client, serviceType, pkg] = await Promise.all([
      db.Client.findOne({ where: { id: data.clientId, orgId }, attributes: ['id', 'name'] }),
      db.ServiceType.findOne({ where: { key: data.serviceTypeKey, orgId }, attributes: ['name'] }),
      data.packageId ? db.Package.findOne({ where: { id: data.packageId, orgId }, attributes: ['tier', 'name'] }) : null,
    ]);
    if (!client) {
      const err = new Error('Client not found.');
      err.status = 404;
      throw err;
    }
    // Canonical name is always "Client - Service - Package" (package omitted if
    // none attached) so it reads correctly in lists, headers, and email
    // notifications; an optional free-text label can still be appended.
    const name = buildProjectName(client.name, serviceType?.name || data.serviceTypeKey, pkg ? (pkg.tier || pkg.name) : null, data.name);

    const project = await db.Project.create({
      id: uuidv4(),
      orgId,
      clientId: data.clientId,
      name,
      serviceTypeKey: data.serviceTypeKey,
      workflowTemplateId: template.id,
      packageId: data.packageId || null,
      clientPackageId: data.clientPackageId || null,
      currentStageKey: firstStage.key,
      status: PROJECT_STATUS.ACTIVE,
      startDate: data.startDate || new Date(),
      deliveryDate: data.deliveryDate || null,
      // Derived from the chosen workflow template, not the request body — the "New
      // Project" form never sends isRecurring, so trusting data.isRecurring here
      // silently left every GMB/SEO project non-recurring and made the recurring
      // auto-task engine (and its terminal-stage prompt) never activate for them.
      // ClientService#sellPackage already gets this right the same way.
      isRecurring: !!template.isRecurring,
      description: data.description,
      createdBy,
    });

    if (data.assignments && Array.isArray(data.assignments)) {
      const assignments = data.assignments.map((a) => ({
        id: uuidv4(),
        projectId: project.id,
        roleSlot: a.roleSlot,
        userId: a.userId,
      }));
      await db.ProjectAssignment.bulkCreate(assignments, { ignoreDuplicates: true });
    }

    await db.ProjectEvent.create({
      projectId: project.id,
      fromStageKey: null,
      toStageKey: firstStage.key,
      action: 'created',
      actorUserId: createdBy,
      note: 'Project created',
    });

    try {
      const ChatService = require('./ChatService');
      await ChatService.ensureClientRoom(orgId, data.clientId, createdBy);
      await ChatService.syncProjectAssignees(orgId, data.clientId);
    } catch (err) {
      console.error('[ProjectService] Failed to sync Messages room after project create:', err.message);
    }

    return this.findById(project.id, orgId);
  }

  async update(id, orgId, data) {
    const project = await db.Project.findOne({ where: { id, orgId } });
    if (!project) {
      const err = new Error('Project not found.');
      err.status = 404;
      throw err;
    }
    await project.update({
      name: data.name ?? project.name,
      description: data.description ?? project.description,
      deliveryDate: data.deliveryDate ?? project.deliveryDate,
      packageId: data.packageId ?? project.packageId,
    });
    return project;
  }

  // Cancels a project directly — for ad-hoc/standalone projects that never went
  // through a package sale (ClientService#cancelClientPackage already handles
  // cancelling everything spawned from a package, this covers the rest). Only
  // scoped to this one project: cancelling it does not touch a package,
  // retainer, or any sibling project from the same sale.
  async cancel(id, orgId, userId, note) {
    const project = await db.Project.findOne({ where: { id, orgId } });
    if (!project) {
      const err = new Error('Project not found.');
      err.status = 404;
      throw err;
    }
    if ([PROJECT_STATUS.CANCELLED, PROJECT_STATUS.COMPLETED].includes(project.status)) {
      const err = new Error(`Project is already ${project.status}.`);
      err.status = 409;
      throw err;
    }
    await project.update({ status: PROJECT_STATUS.CANCELLED });
    await db.ProjectEvent.create({
      projectId: project.id,
      fromStageKey: project.currentStageKey,
      toStageKey: project.currentStageKey,
      action: 'cancelled',
      actorUserId: userId,
      note: note || null,
    });
    return project;
  }

  async setAssignment(projectId, orgId, roleSlot, userId) {
    const project = await db.Project.findOne({ where: { id: projectId, orgId } });
    if (!project) {
      const err = new Error('Project not found.');
      err.status = 404;
      throw err;
    }

    // "Unassign" (userId cleared from the dropdown) has no valid ProjectAssignment
    // row to upsert into — userId is NOT NULL on that table, a slot with nobody in
    // it just doesn't have a row. Remove it instead of upserting a null, which
    // would otherwise throw a raw SequelizeValidationError.
    if (!userId) {
      await db.ProjectAssignment.destroy({ where: { projectId, roleSlot } });
      return { projectId, roleSlot, userId: null };
    }

    const [assignment] = await db.ProjectAssignment.upsert({
      id: uuidv4(),
      projectId,
      roleSlot,
      userId,
    });

    try {
      const ChatService = require('./ChatService');
      await ChatService.ensureClientRoom(orgId, project.clientId, userId);
      await ChatService.syncProjectAssignees(orgId, project.clientId);
    } catch (err) {
      console.error('[ProjectService] Failed to sync Messages room after assignment:', err.message);
    }

    return assignment;
  }

  async getTimeline(projectId, orgId) {
    const project = await db.Project.findOne({
      where: { id: projectId, orgId },
      include: [{ model: db.Client, as: 'client', attributes: ['name'] }],
    });
    if (!project) {
      const err = new Error('Project not found.');
      err.status = 404;
      throw err;
    }

    const [events, stages] = await Promise.all([
      db.ProjectEvent.findAll({
        where: { projectId },
        include: [{ model: db.User, as: 'actor', attributes: ['id', 'name', 'avatarUrl'] }],
        order: [['createdAt', 'ASC']],
      }),
      db.Stage.findAll({
        where: { templateId: project.workflowTemplateId },
        order: [['orderIndex', 'ASC']],
      }),
    ]);

    // Portal approve/reject events have no actorUserId — label them with the client name
    const clientName = project.client?.name || 'Client';
    const enrichedEvents = events.map((ev) => {
      const plain = ev.toJSON();
      if (!plain.actorUserId) {
        plain.actor = { id: null, name: clientName };
      }
      return plain;
    });

    return { stages, events: enrichedEvents };
  }
}

module.exports = new ProjectService();
