const pool = require('../db/pool');
const toId = require('../utils/toId');
const {
    lockAttempt,
    gradeAndSubmit,
    autoSubmitIfExpired,
} = require('../services/attemptService');

// Randomly reorders a list (Fisher-Yates shuffle)
function shuffle(list) {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

async function findExisting(examId, studentId) {
    const r = await pool.query(
        'SELECT id, status FROM attempts WHERE exam_id = $1 AND student_id = $2',
        [examId, studentId]
    );
    return r.rows[0] || null;
}

// Replies for a student who already has an attempt on this exam
function replyExisting(res, existing) {
    if (existing.status === 'submitted') {
        return res.status(409).json({ message: 'You have already submitted this exam' });
    }
    return res.json({ attempt_id: existing.id, resumed: true });
}

// Picks this student's random questions.
// If the exam has a difficulty mix, picks exactly that many of each level.
// Returns a list of question ids, or null if the course does not have enough questions.
async function pickQuestions(exam) {
    const mixTotal = exam.easy_count + exam.medium_count + exam.hard_count;

    if (mixTotal === 0) {
        const picked = await pool.query(
            'SELECT id FROM questions WHERE course_id = $1 ORDER BY random() LIMIT $2',
            [exam.course_id, exam.num_questions]
        );
        if (picked.rows.length < exam.num_questions) return null;
        return picked.rows.map((r) => r.id);
    }

    const wanted = [
        ['easy', exam.easy_count],
        ['medium', exam.medium_count],
        ['hard', exam.hard_count],
    ];

    let ids = [];
    for (const [level, count] of wanted) {
        if (count === 0) continue;
        const picked = await pool.query(
            `SELECT id FROM questions
             WHERE course_id = $1 AND difficulty = $2
             ORDER BY random() LIMIT $3`,
            [exam.course_id, level, count]
        );
        if (picked.rows.length < count) return null;
        ids = ids.concat(picked.rows.map((r) => r.id));
    }

    // Mix the levels together so easy questions are not always first
    return shuffle(ids);
}

// GET /api/student/exams  - exams of the student's courses, with status
async function listMyExams(req, res) {
    try {
        const result = await pool.query(
            `SELECT e.id, e.title, e.duration_min, e.start_at, e.end_at, e.num_questions,
              e.release_results, c.code AS course_code, c.title AS course_title,
              CASE WHEN NOW() < e.start_at THEN 'upcoming'
                   WHEN NOW() >= e.end_at THEN 'closed'
                   ELSE 'open' END AS phase,
              a.id AS attempt_id, a.status AS attempt_status
       FROM exams e
       JOIN courses c ON c.id = e.course_id
       JOIN enrollments en ON en.course_id = c.id AND en.student_id = $1
       LEFT JOIN attempts a ON a.exam_id = e.id AND a.student_id = $1
       ORDER BY e.start_at DESC`,
            [req.user.id]
        );
        res.json({ exams: result.rows });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
}

// POST /api/student/exams/:id/start  - starts a new attempt, or resumes the existing one
async function startAttempt(req, res) {
    const examId = toId(req.params.id);
    const studentId = req.user.id;
    if (!examId) return res.status(400).json({ message: 'Invalid exam id' });

    let client;
    try {
        const examResult = await pool.query(
            `SELECT id, course_id, num_questions, easy_count, medium_count, hard_count,
              NOW() < start_at AS not_started, NOW() >= end_at AS ended
       FROM exams WHERE id = $1`,
            [examId]
        );
        if (examResult.rows.length === 0) {
            return res.status(404).json({ message: 'Exam not found' });
        }
        const exam = examResult.rows[0];

        const enrolled = await pool.query(
            'SELECT 1 FROM enrollments WHERE course_id = $1 AND student_id = $2',
            [exam.course_id, studentId]
        );
        if (enrolled.rows.length === 0) {
            return res.status(403).json({ message: 'You are not enrolled in this course' });
        }

        // Already started? Then resume instead of making a new paper
        const existing = await findExisting(examId, studentId);
        if (existing) return replyExisting(res, existing);

        if (exam.not_started) {
            return res.status(403).json({ message: 'This exam has not started yet' });
        }
        if (exam.ended) {
            return res.status(403).json({ message: 'This exam has ended' });
        }

        // Pick random questions for this student (following the difficulty mix, if any)
        const questionIds = await pickQuestions(exam);
        if (!questionIds) {
            return res.status(409).json({
                message: 'This exam does not have enough questions. Please contact your teacher',
            });
        }

        const opts = await pool.query(
            'SELECT id, question_id FROM options WHERE question_id = ANY($1::int[])',
            [questionIds]
        );

        client = await pool.connect();
        await client.query('BEGIN');

        // Deadline = start + duration, but never later than the exam's end time
        const created = await client.query(
            `INSERT INTO attempts (exam_id, student_id, started_at, deadline_at)
       SELECT e.id, $2::int, NOW(), LEAST(NOW() + make_interval(mins => e.duration_min), e.end_at)
       FROM exams e WHERE e.id = $1
       RETURNING id, started_at, deadline_at`,
            [examId, studentId]
        );
        const attempt = created.rows[0];

        // Save this student's paper: question order + shuffled option order
        for (let i = 0; i < questionIds.length; i++) {
            const optionIds = opts.rows
                .filter((o) => o.question_id === questionIds[i])
                .map((o) => o.id);
            await client.query(
                `INSERT INTO attempt_questions (attempt_id, question_id, position, option_order)
         VALUES ($1, $2, $3, $4)`,
                [attempt.id, questionIds[i], i + 1, shuffle(optionIds)]
            );
        }

        await client.query("INSERT INTO attempt_events (attempt_id, type) VALUES ($1, 'start')", [
            attempt.id,
        ]);
        await client.query('COMMIT');

        res.status(201).json({
            attempt_id: attempt.id,
            resumed: false,
            started_at: attempt.started_at,
            deadline_at: attempt.deadline_at,
        });
    } catch (err) {
        if (client) await client.query('ROLLBACK').catch(() => { });

        // Two "start" requests at the same moment: the other one won, so resume it
        if (err.code === '23505') {
            const existing = await findExisting(examId, studentId);
            if (existing) return replyExisting(res, existing);
        }
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    } finally {
        if (client) client.release();
    }
}

// GET /api/attempts/:id  - the student's paper, saved answers and remaining time
async function getAttempt(req, res) {
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

        // If time ran out while the student was away, submit it now
        await autoSubmitIfExpired(client, attempt);
        await client.query('COMMIT');

        if (attempt.status !== 'in_progress') {
            return res.json({
                attempt: { id: attempt.id, exam_id: attempt.exam_id, status: 'submitted' },
                message: 'This attempt has been submitted',
            });
        }

        const questionRows = (
            await pool.query(
                `SELECT aq.position, aq.option_order,  aq.flagged, q.id AS question_id, q.text, q.marks::float AS marks
         FROM attempt_questions aq JOIN questions q ON q.id = aq.question_id
         WHERE aq.attempt_id = $1
         ORDER BY aq.position`,
                [attempt.id]
            )
        ).rows;

        const questionIds = questionRows.map((q) => q.question_id);
        // NOTE: is_correct is deliberately NOT selected here
        const optionRows = (
            await pool.query(
                'SELECT id, question_id, text FROM options WHERE question_id = ANY($1::int[])',
                [questionIds]
            )
        ).rows;

        const questions = questionRows.map((q) => {
            const mine = optionRows.filter((o) => o.question_id === q.question_id);
            const ordered = q.option_order
                .map((id) => mine.find((o) => o.id === id))
                .filter(Boolean)
                .map((o) => ({ id: o.id, text: o.text }));
            return {
                position: q.position,
                question_id: q.question_id,
                text: q.text,
                marks: q.marks,
                flagged: q.flagged,
                options: ordered,
            };
        });

        const answerRows = (
            await pool.query('SELECT question_id, option_id FROM answers WHERE attempt_id = $1', [
                attempt.id,
            ])
        ).rows;
        const answers = {};
        for (const a of answerRows) answers[a.question_id] = a.option_id;

        // Count the tab switches so far (so a page refresh keeps the warning count)
        const switchCount = (
            await pool.query(
                "SELECT COUNT(*)::int AS total FROM attempt_events WHERE attempt_id = $1 AND type = 'tab_switch' AND NOT excused",
                [attempt.id]
            )
        ).rows[0].total;

        res.json({
            attempt: {
                id: attempt.id,
                exam_id: attempt.exam_id,
                status: attempt.status,
                started_at: attempt.started_at,
                deadline_at: attempt.deadline_at,
                remaining_seconds: attempt.remaining_seconds,
                switch_count: switchCount,
                switch_limit: attempt.switch_limit,
            },
            exam: { title: attempt.exam_title, duration_min: attempt.duration_min },
            questions,
            answers,
        });
    } catch (err) {
        if (client) await client.query('ROLLBACK').catch(() => { });
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    } finally {
        if (client) client.release();
    }
}

// PUT /api/attempts/:id/answers  body: { question_id, option_id }  (autosave)
async function saveAnswer(req, res) {
    const attemptId = toId(req.params.id);
    const questionId = toId(req.body.question_id);
    const optionId = toId(req.body.option_id);
    if (!attemptId || !questionId || !optionId) {
        return res.status(400).json({ message: 'Valid question_id and option_id are required' });
    }

    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');

        const attempt = await lockAttempt(client, attemptId);
        if (!attempt || attempt.student_id !== req.user.id) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Attempt not found' });
        }

        await autoSubmitIfExpired(client, attempt);
        if (attempt.status !== 'in_progress') {
            await client.query('COMMIT');
            return res.status(409).json({
                message: 'This attempt is already submitted, so answers can no longer be saved',
                status: 'submitted',
            });
        }

        // The question must be on THIS student's paper, and the option must belong to it
        const valid = await client.query(
            `SELECT 1
       FROM attempt_questions aq JOIN options o ON o.question_id = aq.question_id
       WHERE aq.attempt_id = $1 AND aq.question_id = $2 AND o.id = $3`,
            [attemptId, questionId, optionId]
        );
        if (valid.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'That question or option is not part of your paper' });
        }

        // Insert the answer, or change it if one already exists
        await client.query(
            `INSERT INTO answers (attempt_id, question_id, option_id, saved_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (attempt_id, question_id)
       DO UPDATE SET option_id = EXCLUDED.option_id, saved_at = NOW()`,
            [attemptId, questionId, optionId]
        );
        await client.query("INSERT INTO attempt_events (attempt_id, type) VALUES ($1, 'save')", [
            attemptId,
        ]);
        await client.query('COMMIT');

        res.json({ saved: true, remaining_seconds: attempt.remaining_seconds });
    } catch (err) {
        if (client) await client.query('ROLLBACK').catch(() => { });
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    } finally {
        if (client) client.release();
    }
}

// POST /api/attempts/:id/submit
async function submitAttempt(req, res) {
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

        // Already submitted earlier: block the duplicate
        if (attempt.status === 'submitted') {
            await client.query('ROLLBACK');
            return res.status(409).json({ message: 'This attempt is already submitted' });
        }

        // Time ran out before the student pressed submit
        if (await autoSubmitIfExpired(client, attempt)) {
            await client.query('COMMIT');
            return res.json({
                status: 'submitted',
                reason: 'time_up',
                message: 'Time was up, so your attempt was submitted automatically',
            });
        }

        await gradeAndSubmit(client, attempt, 'manual');
        await client.query('COMMIT');

        res.json({ status: 'submitted', reason: 'manual', message: 'Your attempt has been submitted' });
    } catch (err) {
        if (client) await client.query('ROLLBACK').catch(() => { });
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    } finally {
        if (client) client.release();
    }
}

module.exports = { listMyExams, startAttempt, getAttempt, saveAnswer, submitAttempt };