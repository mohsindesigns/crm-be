/**
 * Stripe's server-to-server callback — the half of the card flow that actually
 * moves the invoice to `paid`.
 *
 * Mounted in app.js BEFORE `express.json()`, with `express.raw()`, because
 * signature verification hashes the exact bytes Stripe sent. Once a JSON body
 * parser has run, `req.body` is a re-serialised object whose bytes no longer
 * match the signature and every event fails verification.
 *
 * Unauthenticated by necessity (Stripe has no bearer token) — the webhook
 * signature IS the authentication, so an unverified request is rejected before
 * anything is read out of it.
 */
const express = require('express');
const StripeService = require('../services/StripeService');

const router = express.Router();

router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['stripe-signature'];
  if (!signature) return res.status(400).send('Missing stripe-signature header.');

  let event;
  try {
    event = StripeService.constructEvent(req.body, signature);
  } catch (err) {
    // Never echo the reason back — a caller probing signature failures should
    // learn nothing beyond "rejected".
    console.error('[StripeWebhook] signature verification failed:', err.message);
    return res.status(400).send('Invalid signature.');
  }

  // Acknowledge before doing the work. Stripe times out at 20s and retries on a
  // non-2xx, and a retry of an event we already processed is harmless (handlers
  // are idempotent) but a retry storm caused by slow processing is not.
  res.json({ received: true });

  try {
    const result = await StripeService.handleEvent(event);
    if (result?.ignored) {
      console.log(`[StripeWebhook] ${event.type} ignored (${result.ignored})`);
    } else {
      console.log(`[StripeWebhook] ${event.type} handled`);
    }
  } catch (err) {
    console.error(`[StripeWebhook] handler failed for ${event.type}:`, err.message);
  }
});

module.exports = router;
