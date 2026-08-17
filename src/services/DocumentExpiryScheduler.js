const { Op } = require('sequelize');
const db = require('../models');

async function runDocumentExpiry() {
  const today = new Date().toISOString().split('T')[0];

  const [count] = await db.CustomerDocument.update(
    { status: 'expired' },
    {
      where: {
        status: { [Op.in]: ['sent', 'viewed'] },
        validUntil: { [Op.lt]: today },
      },
    }
  );

  if (count > 0) console.log(`[DocumentExpiryScheduler] Expired ${count} document(s).`);
}

function startScheduler() {
  runDocumentExpiry().catch(console.error);
  setInterval(() => runDocumentExpiry().catch(console.error), 6 * 60 * 60 * 1000);
}

module.exports = { startScheduler, runDocumentExpiry };
