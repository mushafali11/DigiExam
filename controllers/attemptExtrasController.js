const pool = require('../db/pool');
const toId = require('../utils/toId');
const { lockAttempt, autoSubmitIfExpired } = require('../services/attemptService');

// Runs "work" inside a transaction on a locked, still-running attempt of this student.
// work(client, attempt) returns an object to send back, or { error: { status, message } }.
async function withActiveAttempt(req, res, work) {
  const attemptId = toId(req.params.id);
  if (!attemptId) return res.status(400).json({ message: 'Invalid attempt id' });

  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    const attempt = await lockAttempt(client, attemptId);
    if (!attempt || attempt.student_id !== req.user.id) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Attempt not found' });
    }

    // If time ran out, settle that first
    await autoSubmitIfExpired(client, attempt);
    if (attempt.status !== 'in_progress') {
      await client.query('COMMIT');
      return res.status(409).json({
        message: 'This attempt is already submitted, so it can no longer be changed',
        status: 'submitted',
      });
    }

    const result = await work(client, attempt);
    if (result && result.error) {
      await client.query('ROLLBACK');
      return res.status(result.error.status).json({ message: result.error.message });
    }

    await client.query('COMMIT');
    res.json(result);
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  } finally {
    if (client) client.release();
  }
}

// DELETE /api/attempts/:id/answers/:questionId   - clears the chosen option of one question
async function clearAnswer(req, res) {
  const questionId = toId(req.params.questionId);
  if (!questionId) return res.status(400).json({ message: 'Invalid question id' });

  return withActiveAttempt(req, res, async (client, attempt) => {
    const onPaper = await client.query(
      'SELECT 1 FROM attempt_questions WHERE attempt_id = $1 AND question_id = $2',
      [attempt.id, questionId]
    );
    if (onPaper.rows.length === 0) {
      return { error: { status: 400, message: 'That question is not part of your paper' } };
    }

    const deleted = await client.query(
      'DELETE FROM answers WHERE attempt_id = $1 AND question_id = $2',
      [attempt.id, questionId]
    );
    const hadAnswer = deleted.rowCount > 0;

    if (hadAnswer) {
      await client.query(
        "INSERT INTO attempt_events (attempt_id, type, detail) VALUES ($1, 'save', 'cleared')",
        [attempt.id]
      );
    }

    return { cleared: true, had_answer: hadAnswer, remaining_seconds: attempt.remaining_seconds };
  });
}

// PUT /api/attempts/:id/flags   body: { question_id, flagged: true|false }
async function setFlag(req, res) {
  const questionId = toId(req.body.question_id);
  const flagged = req.body.flagged;
  if (!questionId || typeof flagged !== 'boolean') {
    return res.status(400).json({ message: 'question_id and flagged (true or false) are required' });
  }

  return withActiveAttempt(req, res, async (client, attempt) => {
    const updated = await client.query(
      `UPDATE attempt_questions SET flagged = $3
       WHERE attempt_id = $1 AND question_id = $2`,
      [attempt.id, questionId, flagged]
    );
    if (updated.rowCount === 0) {
      return { error: { status: 400, message: 'That question is not part of your paper' } };
    }

    return { flagged, question_id: questionId, remaining_seconds: attempt.remaining_seconds };
  });
}

module.exports = { clearAnswer, setFlag };