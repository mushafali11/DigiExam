const express = require('express');
const router = express.Router();
const {
    createCourse,
    listCourses,
    enrollStudent,
    listCourseStudents,
    removeStudent,
} = require('../controllers/courseController');
const { authenticate, requireRole } = require('../middleware/auth');
const { createQuestion, listQuestions } = require('../controllers/questionController');
const { createExam, listExams } = require('../controllers/examController');

// Every route here needs a login
router.use(authenticate);

router.post('/', requireRole('admin'), createCourse);
router.get('/', listCourses);
router.post('/:id/enrollments', requireRole('admin'), enrollStudent);
router.get('/:id/students', requireRole('admin', 'teacher'), listCourseStudents);
router.delete('/:id/enrollments/:studentId', requireRole('admin'), removeStudent);
router.post('/:courseId/questions', requireRole('teacher'), createQuestion);
router.get('/:courseId/questions', requireRole('teacher'), listQuestions);
router.post('/:courseId/exams', requireRole('teacher'), createExam);
router.get('/:courseId/exams', requireRole('teacher'), listExams);

module.exports = router;