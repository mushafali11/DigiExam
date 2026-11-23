const pool = require('../db/pool');
const toId = require('../utils/toId');
const { findOwnExam } = require('./examController');

// SQL piece: the total marks of one attempt's paper (uses the outer alias "a")
const TOTAL_MARKS_SQL = `(SELECT COALESCE(SUM(q.marks), 0)::float
   FROM attempt_questions aq JOIN questions q ON q.id = aq.question_id
   WHERE aq.attempt_id = a.id)`;

function percentage(score, total) {
  if (!total) return 0;
  return Math.round((score / total) * 1000) / 10;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// GET /api/student/results   (student) - my submitted attempts
// Scores are hidden until the teacher releases the results
async function myResults(req, res) {
  try {
    const rows = (
      await pool.query(
        `SELECT a.id AS attempt_id, e.id AS exam_id, e.title AS exam_title,
                c.code AS course_code, a.submitted_at, e.release_results,
                a.score::float AS score, ${TOTAL_MARKS_SQL} AS total_marks
         FROM attempts a
         JOIN exams e ON e.id = a.exam_id
         JOIN courses c ON c.id = e.course_id
         WHERE a.student_id = $1 AND a.status = 'submitted'
         ORDER BY a.submitted_at DESC`,
        [req.user.id]
      )
    ).rows;

    const results = rows.map((r) => {
      const base = {
        attempt_id: r.attempt_id,
        exam_id: r.exam_id,
        exam_title: r.exam_title,
        course_code: r.course_code,
        submitted_at: r.submitted_at,
        results_released: r.release_results,
      };
      if (!r.release_results) {
        return { ...base, score: null, total_marks: null, percentage: null };
      }
      return {
        ...base,
        score: r.score,
        total_marks: r.total_marks,
        percentage: percentage(r.score, r.total_marks),
      };
    });

    res.json({ results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
}

// GET /api/attempts/:id/result   (student) - score + review of one attempt
async function attemptResult(req, res) {
  try {
    const attemptId = toId(req.params.id);
    if (!attemptId) return res.status(400).json({ message: 'Invalid attempt id' });

    const found = await pool.query(
      `SELECT a.id, a.status, a.submit_reason, a.submitted_at, a.score::float AS score,
              e.title AS exam_title, e.release_results, ${TOTAL_MARKS_SQL} AS total_marks
       FROM attempts a JOIN exams e ON e.id = a.exam_id
       WHERE a.id = $1 AND a.student_id = $2`,
      [attemptId, req.user.id]
    );
    if (found.rows.length === 0) {
      return res.status(404).json({ message: 'Attempt not found' });
    }
    const attempt = found.rows[0];

    if (attempt.status !== 'submitted') {
      return res.status(409).json({ message: 'This attempt is not submitted yet' });
    }
    if (!attempt.release_results) {
      return res.status(403).json({ message: 'Results have not been released yet' });
    }

    const questionRows = (
      await pool.query(
        `SELECT aq.position, aq.option_order, q.id AS question_id, q.text,
                q.marks::float AS marks, ans.option_id AS selected_option_id
         FROM attempt_questions aq
         JOIN questions q ON q.id = aq.question_id
         LEFT JOIN answers ans
           ON ans.attempt_id = aq.attempt_id AND ans.question_id = aq.question_id
         WHERE aq.attempt_id = $1
         ORDER BY aq.position`,
        [attemptId]
      )
    ).rows;

    const questionIds = questionRows.map((q) => q.question_id);
    const optionRows = (
      await pool.query(
        'SELECT id, question_id, text, is_correct FROM options WHERE question_id = ANY($1::int[])',
        [questionIds]
      )
    ).rows;

    const questions = questionRows.map((q) => {
      const mine = optionRows.filter((o) => o.question_id === q.question_id);
      // Options in the same shuffled order the student saw
      const options = q.option_order
        .map((id) => mine.find((o) => o.id === id))
        .filter(Boolean)
        .map((o) => ({ id: o.id, text: o.text, is_correct: o.is_correct }));
      const correct = options.find((o) => o.is_correct);
      const answered = q.selected_option_id !== null;

      return {
        position: q.position,
        question_id: q.question_id,
        text: q.text,
        marks: q.marks,
        options,
        selected_option_id: q.selected_option_id,
        correct_option_id: correct ? correct.id : null,
        answered,
        is_correct: answered && !!correct && q.selected_option_id === correct.id,
      };
    });

    res.json({
      attempt: {
        id: attempt.id,
        exam_title: attempt.exam_title,
        submitted_at: attempt.submitted_at,
        submit_reason: attempt.submit_reason,
      },
      score: attempt.score,
      total_marks: attempt.total_marks,
      percentage: percentage(attempt.score, attempt.total_marks),
      questions,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
}

// GET /api/exams/:id/results   (teacher) - one row per enrolled student
async function examResults(req, res) {
  try {
    const found = await findOwnExam(req, res);
    if (!found) return;

    const exam = (
      await pool.query('SELECT id, title, release_results FROM exams WHERE id = $1', [found.id])
    ).rows[0];

    const rows = (
      await pool.query(
        `SELECT u.id AS student_id, u.name, u.email,
                a.id AS attempt_id, a.status, a.submit_reason, a.submitted_at,
                a.score::float AS score, ${TOTAL_MARKS_SQL} AS total_marks
         FROM enrollments en
         JOIN users u ON u.id = en.student_id
         LEFT JOIN attempts a ON a.exam_id = $1 AND a.student_id = u.id
         WHERE en.course_id = $2
         ORDER BY u.name`,
        [found.id, found.course_id]
      )
    ).rows;

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

    res.json({ exam, results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
}

// GET /api/exams/:id/analytics   (teacher) - summary, distribution, per-question stats
async function examAnalytics(req, res) {
  try {
    const found = await findOwnExam(req, res);
    if (!found) return;

    const exam = (
      await pool.query('SELECT id, title FROM exams WHERE id = $1', [found.id])
    ).rows[0];

    // One row per submitted attempt
    const attempts = (
      await pool.query(
        `SELECT a.score::float AS score, ${TOTAL_MARKS_SQL} AS total_marks
         FROM attempts a
         WHERE a.exam_id = $1 AND a.status = 'submitted'`,
        [found.id]
      )
    ).rows;

    const enrolled = (
      await pool.query('SELECT COUNT(*)::int AS total FROM enrollments WHERE course_id = $1', [
        found.course_id,
      ])
    ).rows[0].total;

    const inProgress = (
      await pool.query(
        "SELECT COUNT(*)::int AS total FROM attempts WHERE exam_id = $1 AND status = 'in_progress'",
        [found.id]
      )
    ).rows[0].total;

    const scores = attempts.map((a) => a.score);
    const percentages = attempts.map((a) => percentage(a.score, a.total_marks));
    const count = attempts.length;

    const summary = {
      enrolled_students: enrolled,
      submitted: count,
      in_progress: inProgress,
      not_attempted: Math.max(0, enrolled - count - inProgress),
      average_score: count ? round2(scores.reduce((s, x) => s + x, 0) / count) : null,
      highest_score: count ? Math.max(...scores) : null,
      lowest_score: count ? Math.min(...scores) : null,
      average_percentage: count ? round2(percentages.reduce((s, x) => s + x, 0) / count) : null,
    };

    // Score distribution in 20% buckets (handy for a bar chart)
    const distribution = [
      { range: '0-20%', students: 0 },
      { range: '20-40%', students: 0 },
      { range: '40-60%', students: 0 },
      { range: '60-80%', students: 0 },
      { range: '80-100%', students: 0 },
    ];
    for (const p of percentages) {
      distribution[Math.min(4, Math.floor(p / 20))].students++;
    }

    // Per-question statistics, hardest question first
    const questions = (
      await pool.query(
        `SELECT q.id AS question_id, q.text, q.difficulty, q.marks::float AS marks,
                COUNT(*)::int AS times_shown,
                COUNT(ans.option_id)::int AS times_answered,
                (COUNT(*) FILTER (WHERE o.is_correct))::int AS times_correct,
                ROUND(100.0 * (COUNT(*) FILTER (WHERE o.is_correct)) / COUNT(*), 1)::float AS percent_correct
         FROM attempts a
         JOIN attempt_questions aq ON aq.attempt_id = a.id
         JOIN questions q ON q.id = aq.question_id
         LEFT JOIN answers ans
           ON ans.attempt_id = a.id AND ans.question_id = aq.question_id
         LEFT JOIN options o ON o.id = ans.option_id
         WHERE a.exam_id = $1 AND a.status = 'submitted'
         GROUP BY q.id
         ORDER BY percent_correct ASC, times_shown DESC`,
        [found.id]
      )
    ).rows;

    res.json({ exam, summary, distribution, questions });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
}

module.exports = { myResults, attemptResult, examResults, examAnalytics };