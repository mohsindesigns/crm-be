const { body, param } = require('express-validator');
const UserService = require('../services/UserService');
const EmailService = require('../services/EmailService');
const validate = require('../middleware/validate');

class UserController {
  createValidators() {
    return [
      body('name').trim().notEmpty().withMessage('Full name is required.'),
      // Deliberately no .normalizeEmail() — its default Gmail rule strips dots from
      // the local part ("daniyalahmad.dev" -> "daniyalahmaddev"), silently changing
      // the address the user actually owns and breaking their login. isEmail() alone
      // is enough validation; UserService.create() lowercases for consistent lookups.
      body('email').isEmail().withMessage('A valid email address is required.'),
      body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters.'),
      body('roleId').isUUID().withMessage('A role must be selected.'),
    ];
  }

  updateValidators() {
    return [
      param('id').isUUID(),
      body('name').optional().trim().notEmpty(),
      body('roleId').optional().isUUID(),
      body('isActive').optional().isBoolean(),
    ];
  }

  async list(req, res, next) {
    try {
      const users = await UserService.list(req.orgId, req.query);
      res.json(users);
    } catch (err) {
      next(err);
    }
  }

  async listAssignable(req, res, next) {
    try {
      const roleKey = typeof req.query.role === 'string' ? req.query.role.trim() : '';
      const users = await UserService.listAssignable(req.orgId, roleKey || undefined);
      res.json(users);
    } catch (err) {
      next(err);
    }
  }

  async getOne(req, res, next) {
    try {
      const user = await UserService.findById(req.params.id, req.orgId);
      res.json(user);
    } catch (err) {
      next(err);
    }
  }

  /** Public org-directory profile (no HR/payroll secrets). */
  async getPublicProfile(req, res, next) {
    try {
      const profile = await UserService.getPublicProfile(req.params.id, req.orgId);
      res.json(profile);
    } catch (err) {
      next(err);
    }
  }

  async create(req, res, next) {
    try {
      const user = await UserService.create(req.orgId, req.body, req.user.role);
      // Fire-and-forget invite email with temporary credentials
      EmailService.sendUserInvite(
        user.email, user.name, req.body.password,
        process.env.FRONTEND_URL || 'http://localhost:3000'
      ).catch(() => {});
      res.status(201).json(user);
    } catch (err) {
      next(err);
    }
  }

  async update(req, res, next) {
    try {
      const user = await UserService.update(req.params.id, req.orgId, req.body, req.user.role);
      res.json(user);
    } catch (err) {
      next(err);
    }
  }

  async changePassword(req, res, next) {
    try {
      await UserService.changePassword(req.params.id, req.orgId, req.body.currentPassword, req.body.newPassword);
      res.json({ message: 'Password updated.' });
    } catch (err) {
      next(err);
    }
  }

  async resetPassword(req, res, next) {
    try {
      const user = await UserService.resetPassword(req.params.id, req.orgId, req.body.newPassword);
      // Fire-and-forget — the response shouldn't wait on (or fail because of) SMTP.
      EmailService.sendAdminPasswordReset(
        user.email, user.name, req.body.newPassword,
        process.env.FRONTEND_URL || 'http://localhost:3000'
      ).catch(() => {});
      res.json({ message: 'Password reset.' });
    } catch (err) {
      next(err);
    }
  }

  // Deactivates, never destroys — see services/SoftDeleteService.js.
  async remove(req, res, next) {
    try {
      const user = await UserService.remove(req.params.id, req.orgId, req.user.role, false);
      res.json({ message: 'Member set to Inactive.', user });
    } catch (err) {
      next(err);
    }
  }

  async activate(req, res, next) {
    try {
      const user = await UserService.remove(req.params.id, req.orgId, req.user.role, true);
      res.json({ message: 'Member set to Active.', user });
    } catch (err) {
      next(err);
    }
  }
}

module.exports = new UserController();
