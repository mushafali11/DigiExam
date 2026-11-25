const express = require('express');
const router = express.Router();
const { createUser, updateUser } = require('../controllers/adminController');
const { listUsers } = require('../controllers/listController');
const { authenticate, requireRole } = require('../middleware/auth');

// Every route in this file is admin-only
router.use(authenticate, requireRole('admin'));

router.post('/users', createUser);
router.get('/users', listUsers);
router.patch('/users/:id', updateUser);

module.exports = router;