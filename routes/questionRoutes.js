const express = require('express');
const router = express.Router();
const {
  getQuestion,
  updateQuestion,
  deleteQuestion,
} = require('../controllers/questionController');
const { importTemplate } = require('../controllers/importController');
const { authenticate, requireRole } = require('../middleware/auth');

router.use(authenticate, requireRole('teacher'));

// Must come before '/:id', otherwise "import-template" would be read as an id
router.get('/import-template', importTemplate);

router.get('/:id', getQuestion);
router.put('/:id', updateQuestion);
router.delete('/:id', deleteQuestion);

module.exports = router;