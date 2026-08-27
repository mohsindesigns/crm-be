const { body } = require('express-validator');
const AuthService = require('../services/AuthService');
const validate = require('../middleware/validate');

class AuthController {
  loginValidators() {
    return [
      // No .normalizeEmail() — see UserController.createValidators() for why (it
      // strips dots from Gmail addresses, which would break login for any account
      // whose real email has a dot). AuthService.login() lowercases to match how
      // the address was stored at creation time.
      body('email').isEmail(),
      body('password').notEmpty(),
    ];
  }

  async login(req, res, next) {
    try {
      const { email, password, turnstileToken } = req.body;
      const result = await AuthService.login(email, password, turnstileToken, req.ip);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  async refresh(req, res, next) {
    try {
      const { refreshToken } = req.body;
      if (!refreshToken) return res.status(400).json({ message: 'refreshToken required.' });
      const tokens = await AuthService.refresh(refreshToken);
      res.json(tokens);
    } catch (err) {
      next(err);
    }
  }

  async me(req, res, next) {
    try {
      const result = await AuthService.me(req.user.id);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
}

module.exports = new AuthController();
