const express = require('express');
const router = express.Router();
const {
  getExam,
  updateExam,
  setRelease,
  deleteExam,
} = require('../controllers/examController');
const { examActivity, attemptTimeline } = require('../controllers/activityController');
const { examAnalytics } = require('../controllers/resultController');
const { examResults } = require('../controllers/listController');
const {
  extendAttempt,
  attemptReview,
  exportResults,
} = require('../controllers/teacherToolsController');
const { authenticate, requireRole } = require('../middleware/auth');

router.use(authenticate, requireRole('teacher'));

router.get('/:id', getExam);
router.put('/:id', updateExam);
router.patch('/:id/release', setRelease);
router.delete('/:id', deleteExam);

router.get('/:id/activity', examActivity);
router.get('/:id/attempts/:attemptId/events', attemptTimeline);
router.get('/:id/attempts/:attemptId/review', attemptReview);
router.post('/:id/attempts/:attemptId/extend', extendAttempt);

router.get('/:id/results', examResults);
router.get('/:id/results/export', exportResults);
router.get('/:id/analytics', examAnalytics);

module.exports = router;