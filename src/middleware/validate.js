const { validationResult } = require('express-validator');

/**
 * Runs after express-validator chains.
 * Returns 422 with a structured error map if any field fails.
 */
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const list = errors.array();
    const mapped = list.reduce((acc, e) => {
      acc[e.path] = e.msg;
      return acc;
    }, {});
    // Surface the first field-specific message as the top-level `message` too —
    // every frontend error toast in this app reads `response.data.message` only
    // (no consumer reads the `errors` map), so without this every validation
    // failure showed the same generic "Validation failed." regardless of which
    // field or why. The `errors` map stays available for any consumer that
    // wants per-field detail.
    return res.status(422).json({ message: list[0]?.msg || 'Validation failed.', errors: mapped });
  }
  next();
};

module.exports = validate;
