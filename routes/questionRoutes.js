const express = require('express');
const router = express.Router();
const {
    getQuestion,
    updateQuestion,
    deleteQuestion,
} = require('../controllers/questionController');
const { authenticate, requireRole } = require('../middleware/auth');

router.use(authenticate, requireRole('teacher'));

router.get('/:id', getQuestion);
router.put('/:id', updateQuestion);
router.delete('/:id', deleteQuestion);

module.exports = router;