const { UniqueConstraintError, ValidationError, ForeignKeyConstraintError, DatabaseError } = require('sequelize');
const multer = require('multer');

// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
  if (process.env.NODE_ENV !== 'production') {
    // Expected client errors (404 "not found", 400 bad input, etc.) are normal traffic —
    // log a short line instead of a scary full stack trace. Only log unexpected/5xx
    // errors verbosely, since those are the ones that actually need investigating.
    if (err.status && err.status < 500) {
      console.warn(`[${err.status}] ${req.method} ${req.originalUrl} — ${err.message}`);
    } else {
      console.error(err);
    }
  }

  if (err instanceof UniqueConstraintError) {
    return res.status(409).json({
      message: 'A record with this value already exists.',
      fields: err.fields,
    });
  }

  if (err instanceof ValidationError) {
    const errors = err.errors.reduce((acc, e) => {
      acc[e.path] = e.message;
      return acc;
    }, {});
    return res.status(422).json({ message: 'Validation failed.', errors });
  }

  if (err instanceof ForeignKeyConstraintError) {
    return res.status(409).json({
      message: 'This record is still linked to other data and cannot be deleted.',
    });
  }

  // Multer (file upload) errors don't set .status, so without this they'd fall
  // through to a bare 500 — the exact "not even a proper error message" complaint.
  // Note: if a reverse proxy in front of this app (nginx, etc.) has its own
  // client_max_body_size lower than MAX_FILE_SIZE_MB, oversized uploads never
  // reach this handler at all — the proxy rejects them before the app sees the
  // request, and the browser reports that as a misleading CORS error instead of
  // a real HTTP status, since the proxy's rejection response has no CORS headers.
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      const maxMB = parseInt(process.env.MAX_FILE_SIZE_MB || '50', 10);
      return res.status(413).json({ message: `File is too large — the limit is ${maxMB}MB.`, error: `File is too large — the limit is ${maxMB}MB.` });
    }
    return res.status(400).json({ message: `File upload failed: ${err.message}`, error: `File upload failed: ${err.message}` });
  }

  if (err.status) {
    const payload = { message: err.message, error: err.message };
    if (err.errors && typeof err.errors === 'object') payload.errors = err.errors;
    return res.status(err.status).json(payload);
  }

  // Any other unexpected database error (bad date, wrong type, truncated value, etc.) —
  // prefer the DB's own message when it names a column, otherwise fall back to a
  // readable generic. Callers that can validate beforehand (CSV import) should.
  if (err instanceof DatabaseError) {
    const sqlMsg = err.parent?.sqlMessage || err.original?.sqlMessage || '';
    const detail = sqlMsg
      ? `Database rejected a value: ${sqlMsg}`
      : 'One of the values you entered is invalid or in the wrong format. Please check your entries and try again.';
    return res.status(400).json({ message: detail });
  }

  return res.status(500).json({ message: 'Something went wrong on our end. Please try again, and contact support if it keeps happening.' });
};

module.exports = errorHandler;
