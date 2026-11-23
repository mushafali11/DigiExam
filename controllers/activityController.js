const pool = require('../db/pool');
const toId = require('../utils/toId');
const {
    lockAttempt,
    gradeAndSubmit,
    autoSubmitIfExpired,
} = require('../services/attemptService');
const { findOwnExam } = require('./examController');

// Browsers can fire several events for one real switch, so repeats within this window are ignored
const DEBOUNCE_SECONDS = 2;

async function countSwitches(client, attemptId) {
    const r = await client.query(
        "SELECT COUNT(*)::int AS total FROM attempt_events WHERE attempt_id = $1 AND type = 'tab_switch'",
        [attemptId]
    );
    return r.rows[0].total;
}

// POST /api/attempts/:id/events   body: { type: "tab_switch" }   (student)
async function logEvent(req, res) {
    const attemptId = toId(req.params.id);
    if (!attemptId) return res.status(400).json({ message: 'Invalid attempt id' });

    if (req.body.type !== 'tab_switch') {
        return res.status(400).json({ message: 'Only tab_switch events can be reported' });
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
                message: 'This attempt is already submitted',
                status: 'submitted',
            });
        }

        // Was another switch logged a moment ago? Then this is a double-fired event
        const recent = await client.query(
            `SELECT 1 FROM attempt_events
       WHERE attempt_id = $1 AND type = 'tab_switch'
         AND created_at > NOW() - INTERVAL '${DEBOUNCE_SECONDS} seconds'
       LIMIT 1`,
            [attemptId]
        );
        if (recent.rows.length > 0) {
            const count = await countSwitches(client, attemptId);
            await client.query('COMMIT');
            return res.json({
                logged: false,
                reason: 'duplicate event ignored',
                switch_count: count,
                switch_limit: attempt.switch_limit,
                auto_submitted: false,
            });
        }

        await client.query("INSERT INTO attempt_events (attempt_id, type) VALUES ($1, 'tab_switch')", [
            attemptId,
        ]);
        const count = await countSwitches(client, attemptId);

        // Over the limit: grade and submit right now
        if (count > attempt.switch_limit) {
            await gradeAndSubmit(client, attempt, 'switch_limit');
            await client.query('COMMIT');
            return res.json({
                logged: true,
                switch_count: count,
                switch_limit: attempt.switch_limit,
                auto_submitted: true,
                message: 'Switch limit exceeded, so your attempt was submitted automatically',
            });
        }

        await client.query('COMMIT');
        res.json({
            logged: true,
            switch_count: count,
            switch_limit: attempt.switch_limit,
            switches_left: attempt.switch_limit - count,
            auto_submitted: false,
        });
    } catch (err) {
        if (client) await client.query('ROLLBACK').catch(() => { });
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    } finally {
        if (client) client.release();
    }
}

// GET /api/exams/:id/activity   (teacher) - one row per student attempt
async function examActivity(req, res) {
    try {
        const found = await findOwnExam(req, res);
        if (!found) return;

        const exam = await pool.query('SELECT id, title, switch_limit FROM exams WHERE id = $1', [
            found.id,
        ]);

        const attempts = await pool.query(
            `SELECT a.id AS attempt_id, u.id AS student_id, u.name, u.email,
              a.status, a.submit_reason, a.started_at, a.submitted_at,
              (SELECT COUNT(*)::int FROM attempt_events ev
               WHERE ev.attempt_id = a.id AND ev.type = 'tab_switch') AS switch_count
       FROM attempts a JOIN users u ON u.id = a.student_id
       WHERE a.exam_id = $1
       ORDER BY switch_count DESC, u.name`,
            [found.id]
        );

        res.json({ exam: exam.rows[0], attempts: attempts.rows });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
}

// GET /api/exams/:id/attempts/:attemptId/events   (teacher) - timeline of one attempt
// Hides routine 'save' events unless you add ?all=true
async function attemptTimeline(req, res) {
    try {
        const attemptId = toId(req.params.attemptId);
        if (!attemptId) return res.status(400).json({ message: 'Invalid attempt id' });

        const found = await findOwnExam(req, res);
        if (!found) return;

        const attemptResult = await pool.query(
            `SELECT a.id, u.name AS student_name, a.status, a.submit_reason, a.started_at, a.submitted_at
       FROM attempts a JOIN users u ON u.id = a.student_id
       WHERE a.id = $1 AND a.exam_id = $2`,
            [attemptId, found.id]
        );
        if (attemptResult.rows.length === 0) {
            return res.status(404).json({ message: 'Attempt not found for this exam' });
        }
        const attempt = attemptResult.rows[0];

        const filter = req.query.all === 'true' ? '' : "AND type <> 'save'";
        const eventRows = (
            await pool.query(
                `SELECT type, created_at FROM attempt_events
         WHERE attempt_id = $1 ${filter}
         ORDER BY created_at, id`,
                [attemptId]
            )
        ).rows;

        const events = eventRows.map((e) => ({
            type: e.type,
            created_at: e.created_at,
            seconds_from_start: Math.round((new Date(e.created_at) - new Date(attempt.started_at)) / 1000),
        }));

        res.json({ attempt, events });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
}

module.exports = { logEvent, examActivity, attemptTimeline };