const db = require('../models');

async function notify(clientId, orgId, { type, title, body, refTable, refId } = {}) {
  if (!clientId || !orgId) return;
  try {
    await db.PortalNotification.create({ clientId, orgId, type, title, body, refTable, refId });
  } catch (err) {
    console.error('[PortalNotificationService] notify failed:', err.message);
  }
}

module.exports = { notify };
