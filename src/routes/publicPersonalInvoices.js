const express = require('express');
const router = express.Router();
const PublicPersonalInvoiceService = require('../services/PublicPersonalInvoiceService');

// Fully public — no auth/tenancy/rbac. Mirrors routes/publicInvoices.js; the
// publicToken in the URL is the only credential.

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
  if (payHits.size > 500) {
    for (const [k, v] of payHits) {
      if (!v.some((t) => now - t < PAY_WINDOW_MS)) payHits.delete(k);
    }
  }
  return next();
}

router.get('/:token', async (req, res, next) => {
  try { res.json(await PublicPersonalInvoiceService.getByToken(req.params.token)); }
  catch (err) { next(err); }
});

router.post('/:token/pay', throttlePay, async (req, res, next) => {
  try {
    res.json(await PublicPersonalInvoiceService.startPayment(req.params.token, {
      amount: req.body?.amount ?? null,
    }));
  } catch (err) { next(err); }
});

router.get('/:token/pdf', async (req, res, next) => {
  try {
    const { buffer, invoice } = await PublicPersonalInvoiceService.getPdfBuffer(req.params.token);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${invoice.number}.pdf"`);
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.removeHeader('X-Frame-Options');
    res.send(buffer);
  } catch (err) { next(err); }
});

module.exports = router;
