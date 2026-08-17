const { User, Role, Worker, NotificationPref } = require('../models');
const { Op } = require('sequelize');
const { v4: uuidv4 } = require('uuid');
const { isTruthy } = require('./SoftDeleteService');

class UserService {
  async list(orgId, query = {}) {
    const page  = Math.max(1, parseInt(query.page)  || 1);
    const limit = Math.min(100, parseInt(query.limit) || 25);
    const offset = (page - 1) * limit;

    const where = { orgId };
    // Deactivated members are hidden unless explicitly asked for.
    if (!isTruthy(query.includeInactive)) where.isActive = true;
    if (query.roleId) where.roleId = query.roleId;
    if (query.search) {
      where[Op.or] = [
        { name:  { [Op.like]: `%${query.search}%` } },
        { email: { [Op.like]: `%${query.search}%` } },
      ];
    }

    const { count, rows } = await User.findAndCountAll({
      where,
      include: [
        {
          model: Role, as: 'role', attributes: ['id', 'name', 'key', 'color'],
          where: { key: { [Op.notIn]: ['client'] } },
        },
        { model: Worker, as: 'worker', attributes: ['id', 'status', 'department', 'designation'], required: false },
      ],
      attributes: { exclude: ['passwordHash'] },
      order: [['name', 'ASC']],
      limit,
      offset,
      distinct: true,
    });

    return { data: rows, total: count, page, totalPages: Math.ceil(count / limit) || 1, limit };
  }

  // Minimal, permission-light directory for assignee pickers (e.g. the task "Assign
  // to" dropdown) — any authenticated org member can see who else exists by name, not
  // just users.read holders. Deliberately excludes email/role/permissions.
  // Optional `roleKey` (e.g. content_writer) returns ONLY users with that CRM role.
  // If the role doesn't exist in the org, returns [] (not everyone).
  // `roleKey` accepts a comma-separated list ("link_builder,content_writer") —
  // the Backlinks tab's Writer picker draws from both role pools, since either
  // discipline may place a link.
  async listAssignable(orgId, roleKey) {
    if (roleKey) {
      const keys = String(roleKey).split(',').map((k) => k.trim()).filter(Boolean);
      if (!keys.length) return [];
      const roles = await Role.findAll({ where: { orgId, key: keys }, attributes: ['id'] });
      if (!roles.length) return [];
      return User.findAll({
        where: { orgId, isActive: true, roleId: roles.map((r) => r.id) },
        attributes: ['id', 'name', 'avatarUrl', 'email'],
        order: [['name', 'ASC']],
      });
    }

    return User.findAll({
      where: { orgId, isActive: true },
      include: [{ model: Role, as: 'role', attributes: [], where: { key: { [Op.notIn]: ['client'] } } }],
      attributes: ['id', 'name', 'avatarUrl', 'email'],
      order: [['name', 'ASC']],
    });
  }

  async findById(id, orgId) {
    const user = await User.findOne({
      where: { id, orgId },
      include: [{ model: Role, as: 'role' }],
      attributes: { exclude: ['passwordHash'] },
    });
    if (!user) {
      const err = new Error('User not found.');
      err.status = 404;
      throw err;
    }
    return user;
  }

  /**
   * Org-directory card for Messages / @mentions — any authenticated teammate.
   * Deliberately omits HR/payroll/secrets (salary, bank, CNIC, address, DOB, etc.).
   */
  async getPublicProfile(id, orgId) {
    const user = await User.findOne({
      where: { id, orgId, isActive: true },
      include: [
        { model: Role, as: 'role', attributes: ['name', 'key', 'color'] },
        {
          model: Worker,
          as: 'worker',
          required: false,
          attributes: ['designation', 'department', 'workerType', 'profilePictureUrl'],
        },
      ],
      attributes: ['id', 'name', 'email', 'phone', 'avatarUrl'],
    });
    if (!user) {
      const err = new Error('User not found.');
      err.status = 404;
      throw err;
    }
    const plain = user.toJSON();
    return {
      id: plain.id,
      name: plain.name,
      email: plain.email,
      phone: plain.phone || null,
      avatarUrl: plain.avatarUrl || plain.worker?.profilePictureUrl || null,
      role: plain.role
        ? { name: plain.role.name, key: plain.role.key, color: plain.role.color }
        : null,
      department: plain.worker?.department || null,
      designation: plain.worker?.designation || null,
      workerType: plain.worker?.workerType || null,
    };
  }

  async create(orgId, data, createdByRole) {
    const role = await Role.findOne({ where: { id: data.roleId, orgId } });
    if (!role) {
      const err = new Error('Role not found.');
      err.status = 404;
      throw err;
    }

    if (role.key === 'super_admin' && createdByRole?.key !== 'super_admin') {
      const err = new Error('Only super admin can create another super admin.');
      err.status = 403;
      throw err;
    }

    const user = await User.create({
      id: uuidv4(),
      orgId,
      roleId: data.roleId,
      name: data.name,
      email: data.email.toLowerCase(),
      passwordHash: data.password,
      phone: data.phone,
      mustChangePassword: true,
    });

    await NotificationPref.create({ userId: user.id });

    // Auto-enroll internal staff in HR — clients are external and never need a Worker record.
    // New members start as 'invited' and must complete their profile after first login.
    if (role.key !== 'client') {
      const existing = await Worker.findOne({ where: { userId: user.id, orgId } });
      if (!existing) {
        await Worker.create({ orgId, userId: user.id, workerType: 'employee', status: 'invited' });
      }
    }

    return user.toSafeJSON();
  }

  async update(id, orgId, data, actorRole) {
    const user = await this.findById(id, orgId);

    if (data.roleId) {
      const role = await Role.findOne({ where: { id: data.roleId, orgId } });
      if (!role) {
        const err = new Error('Role not found.');
        err.status = 404;
        throw err;
      }
      if (role.key === 'super_admin' && actorRole?.key !== 'super_admin') {
        const err = new Error('Cannot assign super_admin role.');
        err.status = 403;
        throw err;
      }
    }

    await user.update({
      name: data.name ?? user.name,
      roleId: data.roleId ?? user.roleId,
      phone: data.phone ?? user.phone,
      isActive: data.isActive ?? user.isActive,
      avatarUrl: data.avatarUrl ?? user.avatarUrl,
    });

    return user.toSafeJSON();
  }

  async changePassword(id, orgId, currentPassword, newPassword) {
    const user = await User.findOne({ where: { id, orgId } });
    if (!user) {
      const err = new Error('User not found.');
      err.status = 404;
      throw err;
    }
    const valid = await user.verifyPassword(currentPassword);
    if (!valid) {
      const err = new Error('Current password is incorrect.');
      err.status = 400;
      throw err;
    }
    await user.update({ passwordHash: newPassword, mustChangePassword: false });
  }

  async resetPassword(id, orgId, newPassword) {
    const user = await User.findOne({ where: { id, orgId } });
    if (!user) {
      const err = new Error('User not found.');
      err.status = 404;
      throw err;
    }
    // Admin-set passwords are temporary — force the employee to pick their own on
    // next login, same as a fresh invite.
    await user.update({ passwordHash: newPassword, mustChangePassword: true });
    return user;
  }

  // Deactivates rather than destroys — see services/SoftDeleteService.js.
  //
  // This used to cascade-delete the entire employment record: worker row, every
  // attendance day, leave request, HR document, payroll item and salary slip.
  // That is payroll history the business is required to keep (and which every
  // past payroll run still reports on), so offboarding now just flips the user
  // and their worker record inactive. They can no longer log in (auth checks
  // isActive), drop out of assignee pickers, and everything they did stays intact.
  async remove(id, orgId, actorRole, active = false) {
    const user = await User.findOne({ where: { id, orgId } });
    if (!user) {
      const err = new Error('User not found.');
      err.status = 404;
      throw err;
    }
    const role = await Role.findByPk(user.roleId);
    if (!active && role?.key === 'super_admin') {
      const err = new Error('Cannot set a super admin account to Inactive.');
      err.status = 403;
      throw err;
    }

    await user.update({ isActive: active });

    const worker = await Worker.findOne({ where: { userId: id, orgId } });
    if (worker) await worker.update({ status: active ? 'active' : 'inactive' });

    return user;
  }
}

module.exports = new UserService();
