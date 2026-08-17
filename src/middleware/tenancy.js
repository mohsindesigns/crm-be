/**
 * Ensures every request is scoped to the authenticated user's org.
 * Must run after auth middleware. Attaches req.orgId and a scoped
 * query helper so controllers never need to remember org filtering.
 */
const tenancy = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  // Prevent cross-org access: if a caller supplies an org override header, reject it.
  if (req.headers['x-org-id'] && req.headers['x-org-id'] !== req.user.orgId) {
    return res.status(403).json({ message: 'Org mismatch.' });
  }

  req.orgId = req.user.orgId;

  /**
   * Convenience: merge orgId into a Sequelize where clause.
   * Usage: const where = req.orgScope({ status: 'active' });
   */
  req.orgScope = (extra = {}) => ({ orgId: req.orgId, ...extra });

  next();
};

module.exports = tenancy;
