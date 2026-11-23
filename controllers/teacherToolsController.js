const pool = require('../db/pool');
const toId = require('../utils/toId');
const { toCsv, sendCsv } = require('../utils/csv');
const { findOwnExam } = require('./examController');
const { lockAttempt, autoSubmitIfExpired } = require('../services/attemptService');

// SQL piece: total marks of one attempt's paper (uses the outer alias "a")
const TOTAL_MARKS_SQL = `(SELECT COALESCE(SUM(q.marks), 0)::float
   FROM attempt_questions aq JOIN questions q ON q.id = aq.question_id
   WHERE aq.attempt_id = a.id)`;

function percentage(score, total) {
    if (!total) return 0;
    return Math.round((score / total) * 1000) / 10;
}

// POST /api/exams/:id/attempts/:attemptId/extend   body: { extra_minutes: 10, reason: "..." }
// In progress: adds time. Auto-submitted (time up or switch limit): reopens it.
async function extendAttempt(req, res) {
    const found = await findOwnExam(req, res);
    if (!found) return;

    const attemptId = toId(req.params.attemptId);
    if (!attemptId) return res.status(400).json({ message: 'Invalid attempt id' });

    const minutes = req.body.extra_minutes;
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 120) {
        return res.status(400).json({ message: 'extra_minutes must be a whole number from 1 to 120' });
    }
    const reason = typeof req.body.reason === 'string' ? req.body.reason.trim().slice(0, 200) : '';
    const detail = `+${minutes} min` + (reason ? `: ${reason}` : '');

    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');

        const attempt = await lockAttempt(client, attemptId);
        if (!attempt || attempt.exam_id !== found.id) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Attempt not found for this exam' });
        }

        // If the time already ran out but nobody noticed yet, settle that first
        await autoSubmitIfExpired(client, attempt);

        let action;
        if (attempt.status === 'in_progress') {
            await client.query(
                `UPDATE attempts
         SET deadline_at = GREATEST(deadline_at, NOW()) + make_interval(mins => $1::int),
             extra_minutes = extra_minutes + $1::int
         WHERE id = $2`,
                [minutes, attemptId]
            );
            await client.query(
                "INSERT INTO attempt_events (attempt_id, type, detail) VALUES ($1, 'extend', $2)",
                [attemptId, detail]
            );
            action = 'extended';
        } else {
            const row = (
                await client.query('SELECT submit_reason FROM attempts WHERE id = $1', [attemptId])
            ).rows[0];
            if (row.submit_reason === 'manual') {
                await client.query('ROLLBACK');
                return res.status(409).json({
                    message: 'The student submitted this attempt themselves, so it cannot be reopened',
                });
            }

            await client.query(
                `UPDATE attempts
         SET status = 'in_progress', submit_reason = NULL, submitted_at = NULL, score = NULL,
             deadline_at = NOW() + make_interval(mins => $1::int),
             extra_minutes = extra_minutes + $1::int
         WHERE id = $2`,
                [minutes, attemptId]
            );
            // The switches stay in the log as evidence, but no longer count against the student
            await client.query(
                "UPDATE attempt_events SET excused = TRUE WHERE attempt_id = $1 AND type = 'tab_switch' AND NOT excused",
                [attemptId]
            );
            await client.query(
                "INSERT INTO attempt_events (attempt_id, type, detail) VALUES ($1, 'reopen', $2)",
                [attemptId, detail]
            );
            action = 'reopened';
        }

        const after = (
            await client.query(
                `SELECT deadline_at, extra_minutes,
                GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (deadline_at - NOW()))))::int AS remaining_seconds
         FROM attempts WHERE id = $1`,
                [attemptId]
            )
        ).rows[0];
        await client.query('COMMIT');

        res.json({
            action,
            attempt_id: attemptId,
            deadline_at: after.deadline_at,
            remaining_seconds: after.remaining_seconds,
            extra_minutes_total: after.extra_minutes,
            message:
                action === 'extended'
                    ? `Added ${minutes} minute(s)`
                    : `Attempt reopened with ${minutes} minute(s). The student can resume it now`,
        });
    } catch (err) {
        if (client) await client.query('ROLLBACK').catch(() => { });
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    } finally {
        if (client) client.release();
    }
}

// GET /api/exams/:id/attempts/:attemptId/review  - one student's answers against the correct ones
async function attemptReview(req, res) {
    try {
        const found = await findOwnExam(req, res);
        if (!found) return;

        const attemptId = toId(req.params.attemptId);
        if (!attemptId) return res.status(400).json({ message: 'Invalid attempt id' });

        const att = await pool.query(
            `SELECT a.id, a.status, a.submit_reason, a.started_at, a.submitted_at, a.extra_minutes,
              a.score::float AS score, u.name AS student_name, u.email AS student_email,
              e.title AS exam_title, ${TOTAL_MARKS_SQL} AS total_marks
       FROM attempts a
       JOIN users u ON u.id = a.student_id
       JOIN exams e ON e.id = a.exam_id
       WHERE a.id = $1 AND a.exam_id = $2`,
            [attemptId, found.id]
        );
        if (att.rows.length === 0) {
            return res.status(404).json({ message: 'Attempt not found for this exam' });
        }
        const a = att.rows[0];

        const questionRows = (
            await pool.query(
                `SELECT aq.position, aq.option_order, q.id AS question_id, q.text, q.difficulty,
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
                difficulty: q.difficulty,
                marks: q.marks,
                options,
                selected_option_id: q.selected_option_id,
                correct_option_id: correct ? correct.id : null,
                answered,
                is_correct: answered && !!correct && q.selected_option_id === correct.id,
            };
        });

        const graded = a.score !== null;
        res.json({
            attempt: {
                id: a.id,
                student_name: a.student_name,
                student_email: a.student_email,
                exam_title: a.exam_title,
                status: a.status,
                submit_reason: a.submit_reason,
                started_at: a.started_at,
                submitted_at: a.submitted_at,
                extra_minutes: a.extra_minutes,
            },
            score: graded ? a.score : null,
            total_marks: a.total_marks,
            percentage: graded ? percentage(a.score, a.total_marks) : null,
            questions,
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
}

// GET /api/exams/:id/results/export   - CSV download
async function exportResults(req, res) {
    try {
        const found = await findOwnExam(req, res);
        if (!found) return;

        const data = (
            await pool.query(
                `SELECT u.name, u.email, a.status, a.submit_reason, a.submitted_at, a.extra_minutes,
                a.score::float AS score, ${TOTAL_MARKS_SQL} AS total_marks,
                (SELECT COUNT(*)::int FROM attempt_events ev
                 WHERE ev.attempt_id = a.id AND ev.type = 'tab_switch') AS switches
         FROM enrollments en
         JOIN users u ON u.id = en.student_id
         LEFT JOIN attempts a ON a.exam_id = $1 AND a.student_id = u.id
         WHERE en.course_id = $2
         ORDER BY u.name`,
                [found.id, found.course_id]
            )
        ).rows;

        const rows = [
            ['Name', 'Email', 'Status', 'Score', 'Total marks', 'Percentage',
                'Submit reason', 'Submitted at', 'Tab switches', 'Extra minutes'],
        ];
        for (const r of data) {
            const submitted = r.status === 'submitted';
            rows.push([
                r.name,
                r.email,
                r.status || 'not_attempted',
                submitted ? r.score : '',
                submitted ? r.total_marks : '',
                submitted ? percentage(r.score, r.total_marks) : '',
                r.submit_reason || '',
                r.submitted_at ? new Date(r.submitted_at).toISOString() : '',
                r.status ? r.switches : '',
                r.status ? r.extra_minutes : '',
            ]);
        }

        sendCsv(res, `exam-${found.id}-results.csv`, toCsv(rows));
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
}

module.exports = { extendAttempt, attemptReview, exportResults };