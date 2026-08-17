/**
 * Applies per-room message retention.
 *
 * Only rooms where an admin explicitly set a retention window are touched —
 * everything else is kept indefinitely, which stays the default. See
 * ChatService.purgeExpiredMessages, the one place chat messages are ever really
 * deleted.
 *
 * Runs daily rather than hourly: retention is measured in days, so a sweep that
 * lands within 24 hours of the cutoff is precise enough, and a quieter schedule
 * keeps this off the critical path.
 */
const ChatService = require('./ChatService');

const DAY_MS = 24 * 60 * 60 * 1000;

function startChatRetentionScheduler() {
  const run = async () => {
    try {
      await ChatService.purgeExpiredMessages();
    } catch (err) {
      console.error('[ChatRetention] sweep failed:', err.message);
    }
  };

  // Deliberately delayed on boot: a restart shouldn't fire a purge at the same
  // moment the schema sync is still bringing columns into line.
  setTimeout(run, 5 * 60 * 1000);
  setInterval(run, DAY_MS);
  console.log('[ChatRetention] scheduler started (daily).');
}

module.exports = { startChatRetentionScheduler };
