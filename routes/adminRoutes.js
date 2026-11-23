const express = require('express');
const router = express.Router();
const { createUser, listUsers } = require('../controllers/adminController');
const { authenticate, requireRole } = require('../middleware/auth');

// Every route in this file is admin-only
router.use(authenticate, requireRole('admin'));

router.post('/users', createUser);
router.get('/users', listUsers);

module.exports = router;