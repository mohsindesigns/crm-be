/**
 * Deletion gate — admins only.
 *
 * Usage:
 *   router.delete('/keywords/:id', adminOnly, rbac('projects.act'), handler)
 *
 * Destructive removal is org-policy restricted to the two system roles
 * (super_admin / admin) regardless of what a custom role's permission map says.
 * Feature permissions like `projects.act` or `hr.manage` still gate *who can
 * work on* a thing; this gates who can make it disappear. Both are applied —
 * this middleware only ever narrows access, never widens it.
 *
 * Non-admins should be given a deactivate/void/cancel path instead of delete
 * wherever one exists (invoice void, user isActive, keyword archive, …).
 */

const ADMIN_ROLE_KEYS = ['super_admin', 'admin'];

const adminOnly = (req, res, next) => {
  const roleKey = req.user?.role?.key;
  if (ADMIN_ROLE_KEYS.includes(roleKey)) return next();
  return res.status(403).json({
    message: 'Only an administrator can change a record’s Active/Inactive status. Ask an admin to do it — records are never deleted.',
  });
};

adminOnly.ADMIN_ROLE_KEYS = ADMIN_ROLE_KEYS;

module.exports = adminOnly;
