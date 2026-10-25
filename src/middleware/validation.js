const { body, validationResult } = require('express-validator');

const validateRequest = (validations = []) => {
  const list = Array.isArray(validations) ? validations : [validations].filter(Boolean);

  return async (req, res, next) => {
    for (const validation of list) {
      if (!validation) continue;

      const result = await validation.run(req);
      if (result.errors.length > 0) {
        return res.status(400).json({
          message: 'Validation error',
          errors: result.errors.map(e => e.msg)
        });
      }
    }

    next();
  };
};

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (errors.isEmpty()) {
    return next();
  }
  return res.status(400).json({ errors: errors.array() });
};

// Route params that address a Postgres uuid must be validated before they reach
// PostgREST: an invalid uuid used to bubble up as a database 22P02 and surface as
// an opaque 500 instead of a client error.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value) => typeof value === 'string' && UUID_RE.test(value);

// Shared pagination parser with strict bounds: no endpoint may accept an
// unbounded limit or a nonsensical page (scraping/DoS hygiene). Bounds are
// applied silently — bad input degrades to the default instead of 400-ing, so
// callers keep one code path.
const parsePagedQuery = (query = {}, { page: defPage = 1, limit: defLimit = 20, maxLimit = 100 } = {}) => {
  const rawPage = Number.parseInt(String(query.page), 10);
  const rawLimit = Number.parseInt(String(query.limit), 10);

  let limit = Number.isInteger(rawLimit) && rawLimit > 0 ? rawLimit : defLimit;
  if (limit > maxLimit) limit = maxLimit;

  let page = Number.isInteger(rawPage) && rawPage >= 1 ? rawPage : defPage;
  // Range math in PostgREST is a signed int — keep products well inside it.
  const maxPageForRange = Math.floor(2147483647 / limit);
  if (page > maxPageForRange) page = maxPageForRange;

  return { page, limit };
};

module.exports = { validate, validateRequest, parsePagedQuery, isUuid };
