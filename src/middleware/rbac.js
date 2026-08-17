/**
 * Feature-level RBAC gate.
 *
 * Usage:
 *   router.post('/users', auth, rbac('users.create'), handler)
 *
 * The role's permissions column is a JSON object where keys are
 * permission strings and values are true/false.
 * System roles (super_admin, admin) bypass all checks.
 */

const BYPASS_KEYS = ['super_admin', 'admin'];

const rbac = (...requiredPermissions) => (req, res, next) => {
  const role = req.user?.role;

  if (!role) {
    return res.status(403).json({ message: 'No role assigned.' });
  }

  if (BYPASS_KEYS.includes(role.key)) {
    return next();
  }

  const perms = role.permissions || {};
  const denied = requiredPermissions.find((p) => !perms[p]);

  if (denied) {
    return res.status(403).json({
      message: `Permission denied: ${denied}`,
    });
  }

  next();
};

module.exports = rbac;
