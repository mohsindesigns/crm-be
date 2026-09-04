/**
 * Tiny in-process record of which background schedulers actually started.
 *
 * The schedulers themselves are plain `setInterval` loops (no cron library, no
 * job table), so there is nothing to query about them after boot — "is the
 * retainer invoicer running?" was previously only answerable by reading the
 * server's stdout. The System tab of the Overview page needs to answer it in
 * the UI, so server.js starts each one *through* `register()` here and this
 * module keeps the resulting {startedAt, ok, error} for the process's lifetime.
 *
 * Deliberately not persisted: it describes this Node process, not the org's
 * data, and a restart is exactly when it should reset. It is also process-local
 * — behind a multi-instance deployment it reports the instance that served the
 * request, which is the honest answer to "is this server healthy?".
 */

const schedulers = new Map();

/**
 * Start a scheduler and record the outcome.
 * @param {string} key      stable id, e.g. 'retainer_invoicing'
 * @param {string} label    human name for the UI
 * @param {number} everyMs  its polling cadence, for display only
 * @param {Function} start  the scheduler's own start function
 */
function register(key, label, everyMs, start) {
  const entry = { key, label, everyMs, startedAt: new Date().toISOString(), ok: true, error: null };
  try {
    start();
  } catch (err) {
    entry.ok = false;
    entry.error = err.message;
    // A scheduler that throws on start must not take the whole boot down — the
    // API is still fully usable without it, and now the failure is visible in
    // the UI instead of only in the log.
    console.error(`[scheduler:${key}] failed to start: ${err.message}`);
  }
  schedulers.set(key, entry);
  return entry;
}

/** Everything registered so far, in registration order. */
function list() {
  return [...schedulers.values()];
}

module.exports = { register, list };
