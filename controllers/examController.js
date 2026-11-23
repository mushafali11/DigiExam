const pool = require('../db/pool');
const toId = require('../utils/toId');

const EXAM_COLUMNS = `id, course_id, title, duration_min, start_at, end_at,
  num_questions, switch_limit, negative_marking, release_results,
  easy_count, medium_count, hard_count`;

// Reads an optional count. Returns -1 if it is not a whole number of 0 or more.
function readCount(value) {
  if (value === undefined) return 0;
  if (typeof value !== 'number') return -1;
  return Number.isInteger(value) && value >= 0 ? value : -1;
}

// Checks the request body. Returns { error } or { data }.
function validateExam(body) {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const duration = Number(body.duration_min);
  const numQuestions = Number(body.num_questions);
  const switchLimit = body.switch_limit === undefined ? 3 : Number(body.switch_limit);
  const negative = body.negative_marking === undefined ? false : body.negative_marking;

  if (!title) return { error: 'Title is required' };
  if (title.length > 150) return { error: 'Title must be at most 150 characters' };
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

  // Optional difficulty mix. All zero (or left out) means fully random.
  const easy = readCount(body.easy_count);
  const medium = readCount(body.medium_count);
  const hard = readCount(body.hard_count);
  if (easy < 0 || medium < 0 || hard < 0) {
    return { error: 'easy_count, medium_count and hard_count must be whole numbers from 0 up' };
  }
  const mixTotal = easy + medium + hard;
  if (mixTotal > 0 && mixTotal !== numQuestions) {
    return {
      error: `easy_count + medium_count + hard_count must add up to num_questions (${numQuestions})`,
    };
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
      easy_count: easy,
      medium_count: medium,
      hard_count: hard,
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

// Does the course have enough questions for this exam? Returns an error message or null.
async function checkAvailability(courseId, data) {
  const rows = (
    await pool.query(
      `SELECT difficulty, COUNT(*)::int AS total
       FROM questions WHERE course_id = $1 GROUP BY difficulty`,
      [courseId]
    )
  ).rows;

  const have = { easy: 0, medium: 0, hard: 0 };
  for (const r of rows) have[r.difficulty] = r.total;

  const mixTotal = data.easy_count + data.medium_count + data.hard_count;

  // No mix chosen: just check the total
  if (mixTotal === 0) {
    const total = have.easy + have.medium + have.hard;
    if (data.num_questions > total) {
      return `This course only has ${total} question(s), but the exam asks for ${data.num_questions}`;
    }
    return null;
  }

  const wanted = { easy: data.easy_count, medium: data.medium_count, hard: data.hard_count };
  for (const level of ['easy', 'medium', 'hard']) {
    if (wanted[level] > have[level]) {
      return `This course only has ${have[level]} ${level} question(s), but the exam asks for ${wanted[level]}`;
    }
  }
  return null;
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

    const problem = await checkAvailability(course.id, data);
    if (problem) return res.status(400).json({ message: problem });

    const result = await pool.query(
      `INSERT INTO exams
         (course_id, title, duration_min, start_at, end_at,
          num_questions, switch_limit, negative_marking,
          easy_count, medium_count, hard_count, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING ${EXAM_COLUMNS}`,
      [
        course.id, data.title, data.duration_min, data.start_at, data.end_at,
        data.num_questions, data.switch_limit, data.negative_marking,
        data.easy_count, data.medium_count, data.hard_count, req.user.id,
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

    const problem = await checkAvailability(found.course_id, data);
    if (problem) return res.status(400).json({ message: problem });

    const result = await pool.query(
      `UPDATE exams
       SET title = $1, duration_min = $2, start_at = $3, end_at = $4,
           num_questions = $5, switch_limit = $6, negative_marking = $7,
           easy_count = $8, medium_count = $9, hard_count = $10
       WHERE id = $11
       RETURNING ${EXAM_COLUMNS}`,
      [
        data.title, data.duration_min, data.start_at, data.end_at,
        data.num_questions, data.switch_limit, data.negative_marking,
        data.easy_count, data.medium_count, data.hard_count, found.id,
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