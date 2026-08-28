const { Role, User } = require('../models');
const { v4: uuidv4 } = require('uuid');

const PROTECTED_KEYS = ['super_admin', 'admin', 'client', 'employee'];

// Permissions that are silently required when another permission is granted.
// If role has any key in a group, it also gets all values in that group.
const PERMISSION_DEPS = [
  // billing.read implies create+update — a billing role can always create and update invoices
  { triggers: ['billing.read'],                                      requires: ['billing.create', 'billing.update', 'clients.read'] },
  { triggers: ['billing.create', 'billing.update'],                  requires: ['clients.read'] },
  // personalInvoices is deliberately its own permission, unrelated to billing.*
  // or clients.read — Personal invoices bill separate contacts, not Clients.
  { triggers: ['personalInvoices.read'],                              requires: ['personalInvoices.create', 'personalInvoices.update'] },
  { triggers: ['projects.create'],                                   requires: ['clients.read'] },
  { triggers: ['projects.manage'],                                   requires: ['clients.read', 'users.read'] },
];

function applyDeps(permissions) {
  const p = { ...permissions };
  for (const { triggers, requires } of PERMISSION_DEPS) {
    if (triggers.some((t) => p[t])) {
      for (const r of requires) { p[r] = true; }
    }
  }
  return p;
}

class RoleService {
  async list(orgId, { includeInactive = false } = {}) {
    return Role.findAll({
      where: { orgId, ...(includeInactive ? {} : { isActive: true }) },
      order: [['name', 'ASC']],
    });
  }

  async findById(id, orgId) {
    const role = await Role.findOne({ where: { id, orgId } });
    if (!role) {
      const err = new Error('Role not found.');
      err.status = 404;
      throw err;
    }
    return role;
  }

  async create(orgId, data) {
    if (PROTECTED_KEYS.includes(data.key)) {
      const err = new Error(`"${data.key}" is a reserved system role key.`);
      err.status = 400;
      throw err;
    }
    return Role.create({
      id: uuidv4(),
      orgId,
      name: data.name,
      key: data.key,
      permissions: applyDeps(data.permissions || {}),
      color: data.color,
    });
  }

  async update(id, orgId, data) {
    const role = await this.findById(id, orgId);
    if (role.isSystemRole && data.key && data.key !== role.key) {
      const err = new Error('Cannot change the key of a system role.');
      err.status = 400;
      throw err;
    }
    await role.update({
      name: data.name ?? role.name,
      permissions: data.permissions != null ? applyDeps(data.permissions) : role.permissions,
      color: data.color ?? role.color,
    });
    return role;
  }

  // Deactivates rather than destroys — see services/SoftDeleteService.js. Users
  // keep pointing at their role row (the header, RBAC checks and every audit trail
  // resolve through it), so a retired role has to stay resolvable.
  async destroy(id, orgId, active = false) {
    const role = await this.findById(id, orgId);
    if (role.isSystemRole) {
      const err = new Error('System roles cannot be set to Inactive.');
      err.status = 400;
      throw err;
    }
    if (!active) {
      const inUse = await User.count({ where: { orgId, roleId: id, isActive: true } });
      if (inUse) {
        const err = new Error(`Cannot set this role to Inactive — ${inUse} active member${inUse === 1 ? ' is' : 's are'} still assigned to it. Move them to another role first.`);
        err.status = 409;
        throw err;
      }
    }
    await role.update({ isActive: active });
    return role;
  }
}

module.exports = new RoleService();
