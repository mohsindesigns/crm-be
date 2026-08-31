const express = require('express');
const router = express.Router();
const PublicPersonalInvoiceService = require('../services/PublicPersonalInvoiceService');

// Fully public — no auth/tenancy/rbac. Mirrors routes/publicInvoices.js; the
// publicToken in the URL is the only credential. No card-payment endpoint —
// personal invoices never route through Stripe.

router.get('/:token', async (req, res, next) => {
  try { res.json(await PublicPersonalInvoiceService.getByToken(req.params.token)); }
  catch (err) { next(err); }
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
