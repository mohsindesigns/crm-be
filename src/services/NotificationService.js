const db = require('../models');

/**
 * Creates an in-app notification record. Fire-and-forget — never throws.
 * @param {string} recipientId  User ID of the recipient
 * @param {string} orgId
 * @param {{ type, title, body, refTable?, refId? }} data
 */
async function notify(recipientId, orgId, { type, title, body, refTable, refId } = {}) {
  if (!recipientId || !orgId) return;
  try {
    await db.Notification.create({
      recipientId,
      orgId,
      channel: 'in_app',
      type,
      title,
      body,
      refTable: refTable || null,
      refId: refId || null,
    });
  } catch (err) {
    console.error('[NotificationService] notify failed:', err.message);
  }
}

module.exports = { notify };
