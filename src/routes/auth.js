const express = require('express');
const router = express.Router();
const AuthController = require('../controllers/AuthController');
const auth = require('../middleware/auth');
const validate = require('../middleware/validate');

router.post('/login', AuthController.loginValidators(), validate, (req, res, next) => AuthController.login(req, res, next));
router.post('/refresh', (req, res, next) => AuthController.refresh(req, res, next));
router.get('/me', auth, (req, res, next) => AuthController.me(req, res, next));

module.exports = router;
