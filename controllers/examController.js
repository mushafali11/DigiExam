const pool = require('../db/pool');
const toId = require('../utils/toId');

const EXAM_COLUMNS = `id, course_id, title, duration_min, start_at, end_at,
  num_questions, switch_limit, negative_marking, release_results`;

// Checks the request body. Returns { error } or { data }.
function validateExam(body) {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const duration = Number(body.duration_min);
  const numQuestions = Number(body.num_questions);
  const switchLimit = body.switch_limit === undefined ? 3 : Number(body.switch_limit);
  const negative = body.negative_marking === undefined ? false : body.negative_marking;

  if (!title) return { error: 'Title is required' };
  if (!Number.isInteger(duration) || duration < 1 || duration > 300) {
    return { error: 'duration_min must be a whole number from 1 to 300' };
  }
  if (!Number.isInteger(numQuestions) || numQuestions < 1 || numQuestions > 200) {
    return { error: 'num_questions must be a whole number from 1 to 200' };
  }
  if (!Number.isInteger(switchLimit) || switchLimit < 0 || switchLimit > 50) {
    return { error: 'switch_limit must be a whole number from 0 to 50' };
  }
  if (typeof negative !== 'boolean') {
    return { error: 'negative_marking must be true or false' };
  }
  if (typeof body.start_at !== 'string' || typeof body.end_at !== 'string') {
    return { error: 'start_at and end_at are required' };
  }

  const start = new Date(body.start_at);
  const end = new Date(body.end_at);
  if (isNaN(start) || isNaN(end)) {
    return { error: 'start_at and end_at must be valid dates' };
  }
  if (end <= start) return { error: 'end_at must be after start_at' };
  if (end <= new Date()) return { error: 'end_at must be in the future' };
  if ((end - start) / 60000 < duration) {
    return { error: 'The time window must be at least as long as the duration' };
  }

  return {
    data: {
      title,
      duration_min: duration,
      start_at: start.toISOString(),
      end_at: end.toISOString(),
      num_questions: numQuestions,
      switch_limit: switchLimit,
      negative_marking: negative,
    },
  };
}

// Finds the course and checks it belongs to this teacher.
async function findOwnCourse(req, res) {
  const courseId = toId(req.params.courseId);
  if (!courseId) {
    res.status(400).json({ message: 'Invalid course id' });
    return null;
  }
  const r = await pool.query('SELECT id, teacher_id FROM courses WHERE id = $1', [courseId]);
  if (r.rows.length === 0) {
    res.status(404).json({ message: 'Course not found' });
    return null;
  }
  if (r.rows[0].teacher_id !== req.user.id) {
    res.status(403).json({ message: 'This is not your course' });
    return null;
  }
  return r.rows[0];
}

// Finds the exam and checks its course belongs to this teacher.
async function findOwnExam(req, res) {
  const id = toId(req.params.id);
  if (!id) {
    res.status(400).json({ message: 'Invalid exam id' });
    return null;
  }
  const r = await pool.query(
    `SELECT e.id, e.course_id, c.teacher_id
     FROM exams e JOIN courses c ON c.id = e.course_id
     WHERE e.id = $1`,
    [id]
  );
  if (r.rows.length === 0) {
    res.status(404).json({ message: 'Exam not found' });
    return null;
  }
  if (r.rows[0].teacher_id !== req.user.id) {
    res.status(403).json({ message: 'This exam is not in your course' });
    return null;
  }
  return r.rows[0];
}

async function countCourseQuestions(courseId) {
  const r = await pool.query(
    'SELECT COUNT(*)::int AS total FROM questions WHERE course_id = $1',
    [courseId]
  );
  return r.rows[0].total;
}

async function hasAttempts(examId) {
  const r = await pool.query('SELECT 1 FROM attempts WHERE exam_id = $1 LIMIT 1', [examId]);
  return r.rows.length > 0;
}

// POST /api/courses/:courseId/exams
async function createExam(req, res) {
  try {
    const course = await findOwnCourse(req, res);
    if (!course) return;

    const { error, data } = validateExam(req.body);
    if (error) return res.status(400).json({ message: error });

    const available = await countCourseQuestions(course.id);
    if (data.num_questions > available) {
      return res.status(400).json({
        message: `This course only has ${available} question(s), but the exam asks for ${data.num_questions}`,
      });
    }

    const result = await pool.query(
      `INSERT INTO exams
         (course_id, title, duration_min, start_at, end_at,
          num_questions, switch_limit, negative_marking, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${EXAM_COLUMNS}`,
      [
        course.id, data.title, data.duration_min, data.start_at, data.end_at,
        data.num_questions, data.switch_limit, data.negative_marking, req.user.id,
      ]
    );

    res.status(201).json({ exam: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
}

// GET /api/courses/:courseId/exams
async function listExams(req, res) {
  try {
    const course = await findOwnCourse(req, res);
    if (!course) return;

    const result = await pool.query(
      `SELECT ${EXAM_COLUMNS} FROM exams WHERE course_id = $1 ORDER BY start_at DESC`,
      [course.id]
    );
    res.json({ exams: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
}

// GET /api/exams/:id
async function getExam(req, res) {
  try {
    const found = await findOwnExam(req, res);
    if (!found) return;

    const result = await pool.query(`SELECT ${EXAM_COLUMNS} FROM exams WHERE id = $1`, [found.id]);
    res.json({ exam: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
}

// PUT /api/exams/:id   (replaces all settings; blocked once attempts exist)
async function updateExam(req, res) {
  try {
    const found = await findOwnExam(req, res);
    if (!found) return;

    const { error, data } = validateExam(req.body);
    if (error) return res.status(400).json({ message: error });

    if (await hasAttempts(found.id)) {
      return res.status(409).json({
        message: 'Students have already started this exam, so its settings are locked',
      });
    }

    const available = await countCourseQuestions(found.course_id);
    if (data.num_questions > available) {
      return res.status(400).json({
        message: `This course only has ${available} question(s), but the exam asks for ${data.num_questions}`,
      });
    }

    const result = await pool.query(
      `UPDATE exams
       SET title = $1, duration_min = $2, start_at = $3, end_at = $4,
           num_questions = $5, switch_limit = $6, negative_marking = $7
       WHERE id = $8
       RETURNING ${EXAM_COLUMNS}`,
      [
        data.title, data.duration_min, data.start_at, data.end_at,
        data.num_questions, data.switch_limit, data.negative_marking, found.id,
      ]
    );

    res.json({ exam: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
}

// PATCH /api/exams/:id/release   body: { release_results: true }
async function setRelease(req, res) {
  try {
    const found = await findOwnExam(req, res);
    if (!found) return;

    const value = req.body.release_results;
    if (typeof value !== 'boolean') {
      return res.status(400).json({ message: 'release_results must be true or false' });
    }

    const result = await pool.query(
      `UPDATE exams SET release_results = $1 WHERE id = $2 RETURNING ${EXAM_COLUMNS}`,
      [value, found.id]
    );
    res.json({ exam: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
}

// DELETE /api/exams/:id   (blocked once attempts exist)
async function deleteExam(req, res) {
  try {
    const found = await findOwnExam(req, res);
    if (!found) return;

    if (await hasAttempts(found.id)) {
      return res.status(409).json({
        message: 'Students have already attempted this exam, so it cannot be deleted',
      });
    }

    await pool.query('DELETE FROM exams WHERE id = $1', [found.id]);
    res.json({ message: 'Exam deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
}

module.exports = {
  createExam,
  listExams,
  getExam,
  updateExam,
  setRelease,
  deleteExam,
  findOwnExam,
};