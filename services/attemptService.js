const pool = require('../db/pool');

// Negative marking: a wrong answer costs this fraction of the question's marks
const NEGATIVE_FRACTION = 0.25;

// Finds an attempt and LOCKS its row, so two requests can't change it at the same time.
// Must be called after BEGIN.
async function lockAttempt(client, attemptId) {
  const r = await client.query(
    `SELECT a.id, a.exam_id, a.student_id, a.status, a.started_at, a.deadline_at,
            a.deadline_at <= NOW() AS expired,
            GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (a.deadline_at - NOW()))))::int AS remaining_seconds,
            e.title AS exam_title, e.duration_min, e.negative_marking, e.switch_limit
     FROM attempts a JOIN exams e ON e.id = a.exam_id
     WHERE a.id = $1
     FOR UPDATE OF a`,
    [attemptId]
  );
  return r.rows[0] || null;
}

// Grades the attempt and marks it submitted. Must be called after lockAttempt.
// reason: 'manual', 'time_up' or 'switch_limit'
async function gradeAndSubmit(client, attempt, reason) {
  const rows = (
    await client.query(
      `SELECT q.marks::float AS marks, o.is_correct, (a.option_id IS NOT NULL) AS answered
       FROM attempt_questions aq
       JOIN questions q ON q.id = aq.question_id
       LEFT JOIN answers a ON a.attempt_id = aq.attempt_id AND a.question_id = aq.question_id
       LEFT JOIN options o ON o.id = a.option_id
       WHERE aq.attempt_id = $1`,
      [attempt.id]
    )
  ).rows;

  let score = 0;
  for (const row of rows) {
    if (!row.answered) continue;
    if (row.is_correct) score += row.marks;
    else if (attempt.negative_marking) score -= row.marks * NEGATIVE_FRACTION;
  }
  score = Math.max(0, Math.round(score * 100) / 100);

  // If time ran out, record the deadline as the submit time (the real end of the attempt)
  const submittedAt = reason === 'time_up' ? 'deadline_at' : 'NOW()';
  await client.query(
    `UPDATE attempts
     SET status = 'submitted', submit_reason = $1, submitted_at = ${submittedAt}, score = $2
     WHERE id = $3`,
    [reason, score, attempt.id]
  );

  const eventType = reason === 'manual' ? 'submit' : 'auto_submit';
  await client.query('INSERT INTO attempt_events (attempt_id, type) VALUES ($1, $2)', [
    attempt.id,
    eventType,
  ]);

  return score;
}

// If the deadline has passed, submits the attempt. Returns true if it did.
async function autoSubmitIfExpired(client, attempt) {
  if (attempt.status === 'in_progress' && attempt.expired) {
    await gradeAndSubmit(client, attempt, 'time_up');
    attempt.status = 'submitted';
    return true;
  }
  return false;
}

// Background job: submits every attempt whose time is up, even if the student left.
async function sweepExpiredAttempts() {
  try {
    const expired = await pool.query(
      "SELECT id FROM attempts WHERE status = 'in_progress' AND deadline_at <= NOW()"
    );

    for (const row of expired.rows) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const attempt = await lockAttempt(client, row.id);
        if (attempt) await autoSubmitIfExpired(client, attempt);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('Sweeper error:', err);
      } finally {
        client.release();
      }
    }
  } catch (err) {
    console.error('Sweeper error:', err);
  }
}

module.exports = { lockAttempt, gradeAndSubmit, autoSubmitIfExpired, sweepExpiredAttempts };