const express = require('express');
const router = express.Router();
const { getAttempt, saveAnswer, submitAttempt } = require('../controllers/attemptController');
const { logEvent } = require('../controllers/activityController');
const { attemptResult } = require('../controllers/resultController');
const { clearAnswer, setFlag } = require('../controllers/attemptExtrasController');
const { authenticate, requireRole } = require('../middleware/auth');

router.use(authenticate, requireRole('student'));

router.get('/:id', getAttempt);
router.put('/:id/answers', saveAnswer);
router.delete('/:id/answers/:questionId', clearAnswer);
router.put('/:id/flags', setFlag);
router.post('/:id/submit', submitAttempt);
router.post('/:id/events', logEvent);
router.get('/:id/result', attemptResult);

module.exports = router;