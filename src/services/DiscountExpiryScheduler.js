const { Op } = require('sequelize');
const db = require('../models');

// Recurring packages/proposals can carry a discount that only lasts a set
// number of billing cycles (ClientPackage.discountCycles/discountEndsAt — see
// ClientService._computeDiscountEndsAt). Once discountEndsAt arrives, the sale
// reverts to its full basePrice automatically, on both the ClientPackage row
// and its linked Retainer — same fields updateClientPackagePrice touches for a
// manual override — so the next auto-invoice bills the full price without
// anyone having to remember to raise it by hand.
async function runDiscountExpiry() {
  const today = new Date().toISOString().split('T')[0];

  const expired = await db.ClientPackage.findAll({
    where: {
      status: 'active',
      discountEndsAt: { [Op.lte]: today },
    },
  });

  let count = 0;
  for (const clientPackage of expired) {
    try {
      const basePrice = Math.round((parseFloat(clientPackage.basePrice) || 0) * 100) / 100;
      await db.sequelize.transaction(async (t) => {
        await clientPackage.update({
          soldPrice: basePrice,
          discountType: null,
          discountValue: null,
          discountCycles: null,
          discountEndsAt: null,
        }, { transaction: t });
        await db.Retainer.update(
          { amount: basePrice },
          { where: { clientPackageId: clientPackage.id, status: { [Op.ne]: 'cancelled' } }, transaction: t }
        );
      });
      count += 1;
    } catch (err) {
      console.error(`[DiscountExpiryScheduler] Failed to revert discount for package ${clientPackage.id}:`, err.stack || err.message);
    }
  }

  if (count > 0) console.log(`[DiscountExpiryScheduler] Reverted ${count} expired discount(s) to full price.`);
}

function startScheduler() {
  runDiscountExpiry().catch(console.error);
  setInterval(() => runDiscountExpiry().catch(console.error), 6 * 60 * 60 * 1000);
}

module.exports = { startScheduler, runDiscountExpiry };
