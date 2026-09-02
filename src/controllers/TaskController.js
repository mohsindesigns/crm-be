const TaskService = require('../services/TaskService');
const ProjectService = require('../services/ProjectService');

class TaskController {
  async listForProject(req, res, next) {
    try {
      // Reuse project access guard — throws 404 if caller is not assigned
      await ProjectService.findById(req.params.projectId, req.orgId, req.user);
      res.json(await TaskService.listForProject(
        req.params.projectId,
        req.orgId,
        req.query.stageKey,
        req.query.type,
      ));
    } catch (err) { next(err); }
  }

  async getById(req, res, next) {
    try {
      const task = await TaskService.getById(req.params.taskId, req.orgId, req.params.projectId);
      res.json(task);
    } catch (err) { next(err); }
  }

  async create(req, res, next) {
    try {
      const type = String(req.body?.type || 'issue').trim().toLowerCase();
      const isManualTask = ['issue', 'custom'].includes(type);
      const isAdmin = req.user?.role?.key === 'super_admin' || req.user?.role?.key === 'admin';
      const canManageProjects = !!req.user?.role?.permissions?.['projects.manage'];

      // PMs may assign/create manual tasks on any org project, even if they are
      // not assigned to that project. Non-manual task creation keeps normal
      // project membership checks.
      if (!(isManualTask && (isAdmin || canManageProjects))) {
        await ProjectService.findById(req.params.projectId, req.orgId, req.user);
      }

      const task = await TaskService.create(req.orgId, req.params.projectId, req.body, req.user.id);
      res.status(201).json(task);
    } catch (err) { next(err); }
  }

  async transition(req, res, next) {
    try {
      const task = await TaskService.transition(
        req.params.taskId,
        req.orgId,
        req.body.status,
        req.user,
        req.body.reasonCategory,
        req.body.note,
        req.body.attachmentIds
      );
      res.json(task);
    } catch (err) { next(err); }
  }

  async reassign(req, res, next) {
    try {
      const task = await TaskService.reassign(req.params.taskId, req.orgId, req.body.assigneeId, req.user);
      res.json(task);
    } catch (err) { next(err); }
  }

  async approveAudit(req, res, next) {
    try {
      const isAdmin = req.user?.role?.key === 'super_admin' || req.user?.role?.key === 'admin';
      if (!isAdmin) {
        const err = new Error('Only an administrator can approve a technical audit.');
        err.status = 403;
        throw err;
      }
      const task = await TaskService.approveAudit(req.params.taskId, req.orgId, req.user);
      res.json(task);
    } catch (err) { next(err); }
  }

  async rejectAudit(req, res, next) {
    try {
      const isAdmin = req.user?.role?.key === 'super_admin' || req.user?.role?.key === 'admin';
      if (!isAdmin) {
        const err = new Error('Only an administrator can reject a technical audit.');
        err.status = 403;
        throw err;
      }
      const task = await TaskService.rejectAudit(req.params.taskId, req.orgId, req.user, req.body?.note);
      res.json(task);
    } catch (err) { next(err); }
  }
}

module.exports = new TaskController();
