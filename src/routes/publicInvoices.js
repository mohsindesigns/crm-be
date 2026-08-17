const express = require('express');
const router = express.Router();
const PublicInvoiceService = require('../services/PublicInvoiceService');

// Fully public — no auth/tenancy/rbac, exactly like routes/publicDocuments.js.
// The publicToken in the URL is the only credential, and every method on
// PublicInvoiceService is scoped by it alone.

/**
 * Throttle payment starts per token.
 *
 * Unauthenticated, and every call hits the Stripe API (void + create). Left
 * open, anyone holding the link could spin Stripe invoices in a loop, and each
 * churn widens the window where more than one payable page exists. Kept
 * in-memory and deliberately tiny — a real client clicks Pay once or twice.
 */
const PAY_WINDOW_MS = 60_000;
const PAY_MAX_PER_WINDOW = 6;
const payHits = new Map();

function throttlePay(req, res, next) {
  const key = req.params.token;
  const now = Date.now();
  const hits = (payHits.get(key) || []).filter((t) => now - t < PAY_WINDOW_MS);
  if (hits.length >= PAY_MAX_PER_WINDOW) {
    return res.status(429).json({ message: 'Too many payment attempts. Please wait a minute and try again.' });
  }
  hits.push(now);
  payHits.set(key, hits);
  // Opportunistic sweep so the map can't grow unbounded from random tokens.
  if (payHits.size > 500) {
    for (const [k, v] of payHits) {
      if (!v.some((t) => now - t < PAY_WINDOW_MS)) payHits.delete(k);
    }
  }
  return next();
}

router.get('/:token', async (req, res, next) => {
  try { res.json(await PublicInvoiceService.getByToken(req.params.token)); }
  catch (err) { next(err); }
});

// `amount` optional — omitted means the whole outstanding balance.
router.post('/:token/pay', throttlePay, async (req, res, next) => {
  try {
    res.json(await PublicInvoiceService.startPayment(req.params.token, {
      amount: req.body?.amount ?? null,
    }));
  } catch (err) { next(err); }
});

router.get('/:token/pdf', async (req, res, next) => {
  try {
    const { buffer, invoice } = await PublicInvoiceService.getPdfBuffer(req.params.token);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${invoice.number}.pdf"`);
    // Same reason as the document review page: the invoice page embeds this in
    // an iframe, and helmet's defaults would blank it across ports/hosts.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.removeHeader('X-Frame-Options');
    res.send(buffer);
  } catch (err) { next(err); }
});

module.exports = router;
