const { ActivityLog } = require('../models');

const VERB_BY_METHOD = { POST: 'create', PUT: 'update', PATCH: 'update', DELETE: 'delete' };
const LABEL_BY_METHOD = { POST: 'Created', PUT: 'Updated', PATCH: 'Updated', DELETE: 'Deleted' };

// Routes/segments that are noisy or not meaningful as an audit trail entry —
// login/refresh happen before req.user exists anyway, and message read-receipts
// are effectively GETs-in-disguise (mutate a read flag, not user-visible state).
const SKIP_RESOURCES = new Set(['auth']);

const ID_SEGMENT = /^[0-9a-f-]{8,}$|^\d+$/i;

// Turns `/api/projects/:projectId/tasks/abc-123` into "task" rather than
// "projects" — the nested resource actually being acted on is the last
// non-id path segment, not the router's mount point.
function resourceFromPath(apiPath) {
  const segments = apiPath.split('/').filter((s) => s && s !== 'api' && !ID_SEGMENT.test(s));
  return segments[segments.length - 1] || null;
}

function humanizeResource(resource) {
  if (!resource) return 'record';
  const withSpaces = resource.replace(/-/g, ' ');
  // Simple pluralization heuristic (clients -> client) so the description
  // reads as a resource name, not the raw route segment.
  const singular = /s$/i.test(withSpaces) && !/ss$/i.test(withSpaces) ? withSpaces.slice(0, -1) : withSpaces;
  return singular.charAt(0).toUpperCase() + singular.slice(1);
}

function describe(method, resource) {
  const verbLabel = LABEL_BY_METHOD[method] || method;
  const noun = humanizeResource(resource);
  return `${verbLabel} ${noun}`;
}

/**
 * Admin → Export Data posts to `/api/exports/<dataset>/csv` (a POST precisely so
 * that pulling everyone's bank details lands here — see routes/exports.js). The
 * generic rules above would file that as "Created Csv", which tells a reader
 * nothing; this names the dataset instead. Left as action 'other' rather than a
 * new ENUM member — widening the ENUM would need an ensureColumnType pass for
 * one cosmetic value.
 */
function exportEntry(apiPath) {
  const match = apiPath.match(/^\/api\/exports\/([^/]+)\/csv$/);
  if (!match) return null;
  const dataset = match[1];
  return {
    resource: dataset,
    action: 'other',
    description: `Exported ${dataset.replace(/-/g, ' ')} to CSV`,
  };
}

/**
 * Generic, best-effort audit trail: records every mutating (POST/PUT/PATCH/
 * DELETE) authenticated API call after it completes. Mounted once at the top
 * of the middleware chain (before the routers), it relies on `res.on('finish')`
 * firing only after the full chain — including auth/tenancy further down —
 * has run, so `req.user`/`req.orgId` are populated by the time this reads them
 * even though this middleware itself runs first.
 *
 * Deliberately shallow (HTTP-level, not a hook into each service) so it covers
 * every route uniformly without touching dozens of existing controllers —
 * consistent with this app's additive, don't-touch-what-works approach to
 * cross-cutting infrastructure (see schemaSync.js).
 */
function activityLogger(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();

  res.on('finish', () => {
    try {
      if (!req.user || !req.orgId) return; // unauthenticated (login, public tokens, portal) — skip
      if (res.statusCode >= 400) return; // failed operations aren't useful audit noise here

      const apiPath = req.originalUrl.split('?')[0];
      const mountMatch = apiPath.match(/^\/api\/([^/]+)/);
      const mountResource = mountMatch ? mountMatch[1] : null;
      if (!mountResource || SKIP_RESOURCES.has(mountResource)) return;
      const resource = resourceFromPath(apiPath) || mountResource;
      const special = exportEntry(apiPath);

      ActivityLog.create({
        orgId: req.orgId,
        actorUserId: req.user.id,
        actorName: req.user.name,
        method: req.method,
        path: apiPath,
        resource: special ? special.resource : resource,
        action: special ? special.action : (VERB_BY_METHOD[req.method] || 'other'),
        description: special ? special.description : describe(req.method, resource),
        statusCode: res.statusCode,
        ip: req.ip,
      }).catch(() => {});
    } catch {
      // Never let audit logging affect the actual request/response cycle.
    }
  });

  next();
}

module.exports = activityLogger;
