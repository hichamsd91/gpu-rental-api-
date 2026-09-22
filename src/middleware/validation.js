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

module.exports = { validate, validateRequest };
