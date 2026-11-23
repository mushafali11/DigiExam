const express = require('express');
const router = express.Router();
const { listMyExams, startAttempt } = require('../controllers/attemptController');
const { myResults } = require('../controllers/resultController');
const { authenticate, requireRole } = require('../middleware/auth');

router.use(authenticate, requireRole('student'));

router.get('/exams', listMyExams);
router.post('/exams/:id/start', startAttempt);
router.get('/results', myResults);

module.exports = router;