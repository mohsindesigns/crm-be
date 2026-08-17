const { body, param } = require('express-validator');
const RoleService = require('../services/RoleService');
const validate = require('../middleware/validate');
const { isTruthy } = require('../services/SoftDeleteService');

class RoleController {
  createValidators() {
    return [
      body('name').trim().notEmpty(),
      body('key').trim().notEmpty().matches(/^[a-z0-9_]+$/),
      body('permissions').optional().isObject(),
      body('color').optional().matches(/^#[0-9A-Fa-f]{6}$/),
    ];
  }

  async list(req, res, next) {
    try {
      res.json(await RoleService.list(req.orgId, { includeInactive: isTruthy(req.query.includeInactive) }));
    } catch (err) { next(err); }
  }

  async getOne(req, res, next) {
    try {
      res.json(await RoleService.findById(req.params.id, req.orgId));
    } catch (err) { next(err); }
  }

  async create(req, res, next) {
    try {
      const role = await RoleService.create(req.orgId, req.body);
      res.status(201).json(role);
    } catch (err) { next(err); }
  }

  async update(req, res, next) {
    try {
      res.json(await RoleService.update(req.params.id, req.orgId, req.body));
    } catch (err) { next(err); }
  }

  // Deactivates, never destroys — see services/SoftDeleteService.js.
  async destroy(req, res, next) {
    try {
      const role = await RoleService.destroy(req.params.id, req.orgId, false);
      res.json({ message: 'Role set to Inactive.', role });
    } catch (err) { next(err); }
  }

  async activate(req, res, next) {
    try {
      const role = await RoleService.destroy(req.params.id, req.orgId, true);
      res.json({ message: 'Role set to Active.', role });
    } catch (err) { next(err); }
  }
}

module.exports = new RoleController();
