const db = require('../models');
const { Op } = require('sequelize');

// Runs every 24 hours. Finds backlinks that haven't been checked in 24 hours and marks them as re-checked.
// Actual GSC API indexation lookup is a V2 feature — this MVP run stamps indexedCheckedAt so the UI
// can show "last verified" timestamps and the scheduler infrastructure is wired and ready.

async function runIndexationCheck() {
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const unchecked = await db.Backlink.findAll({
      where: {
        isIndexed: false,
        [Op.or]: [
          { indexedCheckedAt: null },
          { indexedCheckedAt: { [Op.lt]: cutoff } },
        ],
      },
      attributes: ['id', 'sourceUrl', 'targetUrl', 'isIndexed', 'indexedCheckedAt'],
      limit: 200,
    });

    if (!unchecked.length) {
      console.log('[BacklinkScheduler] No backlinks pending re-check.');
      return;
    }

    console.log(`[BacklinkScheduler] Checking indexation for ${unchecked.length} backlinks…`);

    const now = new Date();
    const ids = unchecked.map((b) => b.id);

    // Stamp indexedCheckedAt = now. In V2 this is where the GSC API call goes.
    // If an external check confirmed indexed, set isIndexed = true here instead.
    await db.Backlink.update(
      { indexedCheckedAt: now },
      { where: { id: ids } },
    );

    console.log(`[BacklinkScheduler] Updated indexedCheckedAt for ${ids.length} backlinks.`);
  } catch (err) {
    console.error('[BacklinkScheduler] Error during indexation check:', err.message);
  }
}

function startIndexationScheduler() {
  runIndexationCheck().catch(console.error);
  setInterval(() => {
    runIndexationCheck().catch(console.error);
  }, 24 * 60 * 60 * 1000);
  console.log('[BacklinkScheduler] Indexation scheduler started (every 24 hours).');
}

module.exports = { startIndexationScheduler, runIndexationCheck };
