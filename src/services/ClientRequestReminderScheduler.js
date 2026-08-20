const { Op } = require('sequelize');
const db = require('../models');
const ClientRequestService = require('./ClientRequestService');

// Nudges clients who were emailed a requirements form and haven't replied.
// Deliberately conservative: a client gets at most MAX_REMINDERS nudges, never
// more than one per REMINDER_INTERVAL_DAYS, and the first only once the form
// has been sitting unanswered for that same interval. Staff can still send a
// manual reminder at any time (ClientRequestService#remind).

const REMINDER_INTERVAL_DAYS = 3;
const MAX_REMINDERS = 2;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6h, same cadence as DocumentExpiryScheduler

function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

async function runClientRequestReminders() {
  const cutoff = daysAgo(REMINDER_INTERVAL_DAYS);

  const due = await db.ClientRequest.findAll({
    where: {
      status: 'sent',
      isActive: true,
      remindersSent: { [Op.lt]: MAX_REMINDERS },
      // Not nudged in the last interval — for a request never nudged, fall back
      // to how long ago it was sent.
      [Op.or]: [
        { lastReminderAt: { [Op.lt]: cutoff } },
        { lastReminderAt: null, sentAt: { [Op.lt]: cutoff } },
      ],
    },
    attributes: ['id', 'orgId'],
    limit: 200,
  });

  let sent = 0;
  for (const request of due) {
    try {
      const result = await ClientRequestService.remind(request.id, request.orgId, { automated: true });
      if (result.emailSent) sent += 1;
    } catch (err) {
      // One bad row (cancelled mid-run, missing recipient) must not stop the batch.
      console.error(`[ClientRequestReminderScheduler] request ${request.id} failed:`, err.message);
    }
  }

  if (sent > 0) console.log(`[ClientRequestReminderScheduler] Sent ${sent} reminder(s).`);
}

function startScheduler() {
  runClientRequestReminders().catch(console.error);
  setInterval(() => runClientRequestReminders().catch(console.error), CHECK_INTERVAL_MS);
}

module.exports = { startScheduler, runClientRequestReminders };
