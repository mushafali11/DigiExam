const express = require('express');
const router = express.Router();
const { register, login, me } = require('../controllers/authController');
const { authenticate } = require('../middleware/auth');
const { failedAuthLimiter } = require('../middleware/rateLimit');

router.post('/register', failedAuthLimiter, register);
router.post('/login', failedAuthLimiter, login);
router.get('/me', authenticate, me);

module.exports = router;