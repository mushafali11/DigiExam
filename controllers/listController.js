// List endpoints with OPTIONAL pagination and search.
// Without ?page= or ?limit= they return exactly what they returned before.
// With them, the response also has a "pagination" object.

const pool = require('../db/pool');
const toId = require('../utils/toId');
const { readPaging, pagingMeta, readSearch, likePattern } = require('../utils/paginate');
const { findOwnExam } = require('./examController');

const ROLES = ['teacher', 'student', 'admin'];
const DIFFICULTIES = ['easy', 'medium', 'hard'];
const STATUSES = ['submitted', 'in_progress', 'not_attempted'];

// SQL piece: the total marks of one attempt's paper (uses the outer alias "a")
const TOTAL_MARKS_SQL = `(SELECT COALESCE(SUM(q.marks), 0)::float
   FROM attempt_questions aq JOIN questions q ON q.id = aq.question_id
   WHERE aq.attempt_id = a.id)`;

function percentage(score, total) {
  if (!total) return 0;
  return Math.round((score / total) * 1000) / 10;
}

// GET /api/admin/users?role=&search=&page=&limit=   (admin)
async function listUsers(req, res) {
  try {
    const rawRole = req.query.role;
    if (rawRole !== undefined && rawRole !== '' && !ROLES.includes(rawRole)) {
      return res.status(400).json({ message: 'Invalid role filter' });
    }
    const role = rawRole || '';

    const paging = readPaging(req.query);
    if (paging.error) return res.status(400).json({ message: paging.error });
    const search = readSearch(req.query);

    const where = [];
    const params = [];
    if (role) {
      params.push(role);
      where.push(`role = $${params.length}`);
    }
    if (search) {
      params.push(likePattern(search));
      where.push(
        `(name ILIKE $${params.length} ESCAPE '\\' OR email ILIKE $${params.length} ESCAPE '\\')`
      );
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const columns = 'id, name, email, role, is_active';

    if (!paging.enabled) {
      const result = await pool.query(
        `SELECT ${columns} FROM users ${whereSql} ORDER BY id`,
        params
      );
      return res.json({ users: result.rows });
    }

    const total = (
      await pool.query(`SELECT COUNT(*)::int AS total FROM users ${whereSql}`, params)
    ).rows[0].total;
    const result = await pool.query(
      `SELECT ${columns} FROM users ${whereSql} ORDER BY id
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, paging.limit, paging.offset]
    );
    res.json({ users: result.rows, pagination: pagingMeta(paging, total) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
}

// GET /api/courses/:courseId/questions?difficulty=&search=&page=&limit=   (teacher, own course)
async function listQuestions(req, res) {
  try {
    const courseId = toId(req.params.courseId);
    if (!courseId) return res.status(400).json({ message: 'Invalid course id' });

    const course = await pool.query('SELECT id, teacher_id FROM courses WHERE id = $1', [courseId]);
    if (course.rows.length === 0) {
      return res.status(404).json({ message: 'Course not found' });
    }
    if (course.rows[0].teacher_id !== req.user.id) {
      return res.status(403).json({ message: 'This is not your course' });
    }

    const rawDifficulty = req.query.difficulty;
    if (rawDifficulty !== undefined && rawDifficulty !== '' && !DIFFICULTIES.includes(rawDifficulty)) {
      return res.status(400).json({ message: 'Invalid difficulty filter' });
    }
    const difficulty = rawDifficulty || '';

    const paging = readPaging(req.query);
    if (paging.error) return res.status(400).json({ message: paging.error });
    const search = readSearch(req.query);

    const where = ['course_id = $1'];
    const params = [courseId];
    if (difficulty) {
      params.push(difficulty);
      where.push(`difficulty = $${params.length}`);
    }
    if (search) {
      params.push(likePattern(search));
      where.push(`text ILIKE $${params.length} ESCAPE '\\'`);
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const columns = 'id, text, difficulty, marks::float AS marks';

    let total = null;
    let rows;
    if (paging.enabled) {
      total = (
        await pool.query(`SELECT COUNT(*)::int AS total FROM questions ${whereSql}`, params)
      ).rows[0].total;
      rows = (
        await pool.query(
          `SELECT ${columns} FROM questions ${whereSql} ORDER BY id
           LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, paging.limit, paging.offset]
        )
      ).rows;
    } else {
      rows = (
        await pool.query(`SELECT ${columns} FROM questions ${whereSql} ORDER BY id`, params)
      ).rows;
    }

    const ids = rows.map((q) => q.id);
    let optionRows = [];
    if (ids.length > 0) {
      optionRows = (
        await pool.query(
          'SELECT id, question_id, text, is_correct FROM options WHERE question_id = ANY($1::int[]) ORDER BY id',
          [ids]
        )
      ).rows;
    }

    const questions = rows.map((q) => ({
      ...q,
      options: optionRows
        .filter((o) => o.question_id === q.id)
        .map((o) => ({ id: o.id, text: o.text, is_correct: o.is_correct })),
    }));

    // How many questions of each difficulty the WHOLE course has (handy for the exam builder)
    const counts = { easy: 0, medium: 0, hard: 0 };
    const countRows = (
      await pool.query(
        'SELECT difficulty, COUNT(*)::int AS total FROM questions WHERE course_id = $1 GROUP BY difficulty',
        [courseId]
      )
    ).rows;
    for (const r of countRows) counts[r.difficulty] = r.total;

    const body = { questions, counts };
    if (paging.enabled) body.pagination = pagingMeta(paging, total);
    res.json(body);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
}

// GET /api/exams/:id/results?status=&search=&page=&limit=   (teacher, own exam)
async function examResults(req, res) {
  try {
    const found = await findOwnExam(req, res);
    if (!found) return;

    const rawStatus = req.query.status;
    if (rawStatus !== undefined && rawStatus !== '' && !STATUSES.includes(rawStatus)) {
      return res.status(400).json({ message: 'status must be submitted, in_progress or not_attempted' });
    }
    const status = rawStatus || '';

    const paging = readPaging(req.query);
    if (paging.error) return res.status(400).json({ message: paging.error });
    const search = readSearch(req.query);

    const exam = (
      await pool.query('SELECT id, title, release_results FROM exams WHERE id = $1', [found.id])
    ).rows[0];

    const params = [found.id, found.course_id];
    const where = ['en.course_id = $2'];
    if (status) {
      params.push(status);
      where.push(`COALESCE(a.status, 'not_attempted') = $${params.length}`);
    }
    if (search) {
      params.push(likePattern(search));
      where.push(
        `(u.name ILIKE $${params.length} ESCAPE '\\' OR u.email ILIKE $${params.length} ESCAPE '\\')`
      );
    }
    const fromSql = `FROM enrollments en
       JOIN users u ON u.id = en.student_id
       LEFT JOIN attempts a ON a.exam_id = $1 AND a.student_id = u.id
       WHERE ${where.join(' AND ')}`;

    const columns = `u.id AS student_id, u.name, u.email,
       a.id AS attempt_id, a.status, a.submit_reason, a.submitted_at,
       a.score::float AS score, ${TOTAL_MARKS_SQL} AS total_marks`;

    let total = null;
    let rows;
    if (paging.enabled) {
      total = (
        await pool.query(`SELECT COUNT(*)::int AS total ${fromSql}`, params)
      ).rows[0].total;
      rows = (
        await pool.query(
          `SELECT ${columns} ${fromSql} ORDER BY u.name, u.id
           LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, paging.limit, paging.offset]
        )
      ).rows;
    } else {
      rows = (
        await pool.query(`SELECT ${columns} ${fromSql} ORDER BY u.name, u.id`, params)
      ).rows;
    }

    const results = rows.map((r) => {
      const submitted = r.status === 'submitted';
      return {
        student_id: r.student_id,
        name: r.name,
        email: r.email,
        attempt_id: r.attempt_id,
        status: r.status || 'not_attempted',
        submit_reason: r.submit_reason,
        submitted_at: r.submitted_at,
        score: submitted ? r.score : null,
        total_marks: submitted ? r.total_marks : null,
        percentage: submitted ? percentage(r.score, r.total_marks) : null,
      };
    });

    const body = { exam, results };
    if (paging.enabled) body.pagination = pagingMeta(paging, total);
    res.json(body);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
}

module.exports = { listUsers, listQuestions, examResults };