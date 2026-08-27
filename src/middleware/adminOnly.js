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
 *
 * A handful of routes want the same admins-only rule for something that isn't
 * a deletion at all (the client-request approval gate, for one). Those use
 * `adminOnly.withMessage('…')` so the 403 the user reads describes what they
 * actually tried to do, instead of talking about Active/Inactive status:
 *
 *   router.post('/:id/approve', adminOnly.withMessage('Only an administrator can approve this.'), handler)
 */

const ADMIN_ROLE_KEYS = ['super_admin', 'admin'];

const DEFAULT_MESSAGE =
  'Only an administrator can change a record’s Active/Inactive status. Ask an admin to do it — records are never deleted.';

/** Builds the gate with a caller-supplied 403 message. The default export is
 *  just this bound to the deletion wording, so there is one rule, not two. */
function withMessage(message) {
  return (req, res, next) => {
    const roleKey = req.user?.role?.key;
    if (ADMIN_ROLE_KEYS.includes(roleKey)) return next();
    return res.status(403).json({ message });
  };
}

const adminOnly = withMessage(DEFAULT_MESSAGE);

adminOnly.ADMIN_ROLE_KEYS = ADMIN_ROLE_KEYS;
adminOnly.withMessage = withMessage;

module.exports = adminOnly;
