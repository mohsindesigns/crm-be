const RequirementFormService = require('../services/RequirementFormService');
const { isTruthy } = require('../services/SoftDeleteService');

// Thin — parse the request, call the service, shape the response.
class RequirementFormController {
  async list(req, res, next) {
    try {
      res.json(await RequirementFormService.list(req.orgId, {
        includeInactive: isTruthy(req.query.includeInactive),
      }));
    } catch (err) { next(err); }
  }

  async get(req, res, next) {
    try {
      res.json(await RequirementFormService.findById(req.params.id, req.orgId));
    } catch (err) { next(err); }
  }

  async create(req, res, next) {
    try {
      const template = await RequirementFormService.create(req.orgId, req.body, req.user.id);
      res.status(201).json(template);
    } catch (err) { next(err); }
  }

  async update(req, res, next) {
    try {
      res.json(await RequirementFormService.update(req.params.id, req.orgId, req.body));
    } catch (err) { next(err); }
  }

  // Deactivates, never destroys — see services/SoftDeleteService.js.
  async remove(req, res, next) {
    try {
      const template = await RequirementFormService.setTemplateActive(req.params.id, req.orgId, false);
      res.json({ message: 'Requirement form set to Inactive', template });
    } catch (err) { next(err); }
  }

  async activate(req, res, next) {
    try {
      const template = await RequirementFormService.setTemplateActive(req.params.id, req.orgId, true);
      res.json({ message: 'Requirement form set to Active', template });
    } catch (err) { next(err); }
  }
}

module.exports = new RequirementFormController();
