const { Op } = require('sequelize');
const db = require('../models');

const { ActivityLog, User } = db;

async function list(orgId, { page: pageStr, limit: limitStr, actorUserId, resource, action, search, from, to } = {}) {
  const page = Math.max(1, parseInt(pageStr) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(limitStr) || 25));
  const offset = (page - 1) * limit;

  const where = { orgId };
  if (actorUserId) where.actorUserId = actorUserId;
  if (resource) where.resource = resource;
  if (action) where.action = action;
  if (search) {
    where[Op.or] = [
      { description: { [Op.like]: `%${search}%` } },
      { path: { [Op.like]: `%${search}%` } },
      { actorName: { [Op.like]: `%${search}%` } },
    ];
  }
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt[Op.gte] = new Date(`${from}T00:00:00`);
    if (to) where.createdAt[Op.lte] = new Date(`${to}T23:59:59.999`);
  }

  const { rows, count } = await ActivityLog.findAndCountAll({
    where,
    include: [{ model: User, as: 'actor', attributes: ['id', 'name', 'email', 'avatarUrl'] }],
    order: [['createdAt', 'DESC']],
    limit,
    offset,
  });

  return {
    data: rows,
    total: count,
    page,
    totalPages: Math.ceil(count / limit) || 1,
    limit,
  };
}

// Distinct resource values seen for this org, so the frontend filter dropdown
// only ever shows options that actually have data instead of a hardcoded list
// that drifts as routes are added/removed.
async function listResources(orgId) {
  const rows = await ActivityLog.findAll({
    where: { orgId },
    attributes: ['resource'],
    group: ['resource'],
    raw: true,
  });
  return rows.map((r) => r.resource).filter(Boolean).sort();
}

module.exports = { list, listResources };
