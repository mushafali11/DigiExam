const express = require('express');
const router = express.Router();
const { register, login, me, changePassword } = require('../controllers/authController');
const { authenticate } = require('../middleware/auth');
const { failedAuthLimiter } = require('../middleware/rateLimit');

router.post('/register', failedAuthLimiter, register);
router.post('/login', failedAuthLimiter, login);
router.get('/me', authenticate, me);
router.post('/change-password', authenticate, failedAuthLimiter, changePassword);

module.exports = router;