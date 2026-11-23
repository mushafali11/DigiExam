const express = require('express');
const router = express.Router();
const {
  getExam,
  updateExam,
  setRelease,
  deleteExam,
} = require('../controllers/examController');
const { examActivity, attemptTimeline } = require('../controllers/activityController');
const { examResults, examAnalytics } = require('../controllers/resultController');
const { authenticate, requireRole } = require('../middleware/auth');

router.use(authenticate, requireRole('teacher'));

router.get('/:id', getExam);
router.put('/:id', updateExam);
router.patch('/:id/release', setRelease);
router.delete('/:id', deleteExam);
router.get('/:id/activity', examActivity);
router.get('/:id/attempts/:attemptId/events', attemptTimeline);
router.get('/:id/results', examResults);
router.get('/:id/analytics', examAnalytics);

module.exports = router;