const pool = require('../db/pool');
const toId = require('../utils/toId');

const DIFFICULTIES = ['easy', 'medium', 'hard'];

// Checks the request body. Returns { error } or { data }.
function validateQuestion(body) {
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    const difficulty = body.difficulty === undefined ? 'medium' : body.difficulty;
    const marks = body.marks === undefined ? 1 : Number(body.marks);
    const options = body.options;

    if (!text) return { error: 'Question text is required' };
    if (!DIFFICULTIES.includes(difficulty)) {
        return { error: 'Difficulty must be easy, medium or hard' };
    }
    if (!(marks > 0) || marks > 100) {
        return { error: 'Marks must be greater than 0 and at most 100' };
    }
    if (!Array.isArray(options) || options.length < 2 || options.length > 6) {
        return { error: 'A question needs 2 to 6 options' };
    }

    const cleaned = [];
    for (const opt of options) {
        const optText = opt && typeof opt.text === 'string' ? opt.text.trim() : '';
        if (!optText) return { error: 'Every option needs text' };
        cleaned.push({ text: optText, is_correct: opt.is_correct === true });
    }

    const correctCount = cleaned.filter((o) => o.is_correct).length;
    if (correctCount !== 1) return { error: 'Exactly one option must be correct' };

    return { data: { text, difficulty, marks, options: cleaned } };
}

// Finds the course and checks it belongs to this teacher.
// Sends an error response and returns null if not.
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

// Finds the question and checks its course belongs to this teacher.
async function findOwnQuestion(req, res) {
    const id = toId(req.params.id);
    if (!id) {
        res.status(400).json({ message: 'Invalid question id' });
        return null;
    }
    const r = await pool.query(
        `SELECT q.id, q.course_id, c.teacher_id
     FROM questions q JOIN courses c ON c.id = q.course_id
     WHERE q.id = $1`,
        [id]
    );
    if (r.rows.length === 0) {
        res.status(404).json({ message: 'Question not found' });
        return null;
    }
    if (r.rows[0].teacher_id !== req.user.id) {
        res.status(403).json({ message: 'This question is not in your course' });
        return null;
    }
    return r.rows[0];
}

async function insertOptions(client, questionId, options) {
    for (const opt of options) {
        await client.query(
            'INSERT INTO options (question_id, text, is_correct) VALUES ($1, $2, $3)',
            [questionId, opt.text, opt.is_correct]
        );
    }
}

async function loadQuestionWithOptions(questionId) {
    const q = await pool.query(
        `SELECT id, course_id, text, difficulty, marks::float AS marks
     FROM questions WHERE id = $1`,
        [questionId]
    );
    const o = await pool.query(
        'SELECT id, text, is_correct FROM options WHERE question_id = $1 ORDER BY id',
        [questionId]
    );
    return { ...q.rows[0], options: o.rows };
}

async function isUsedInAttempt(questionId) {
    const r = await pool.query(
        'SELECT 1 FROM attempt_questions WHERE question_id = $1 LIMIT 1',
        [questionId]
    );
    return r.rows.length > 0;
}

// POST /api/courses/:courseId/questions
async function createQuestion(req, res) {
    let client;
    try {
        const course = await findOwnCourse(req, res);
        if (!course) return;

        const { error, data } = validateQuestion(req.body);
        if (error) return res.status(400).json({ message: error });

        client = await pool.connect();
        await client.query('BEGIN');

        const q = await client.query(
            `INSERT INTO questions (course_id, text, difficulty, marks, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [course.id, data.text, data.difficulty, data.marks, req.user.id]
        );
        await insertOptions(client, q.rows[0].id, data.options);

        await client.query('COMMIT');

        const question = await loadQuestionWithOptions(q.rows[0].id);
        res.status(201).json({ question });
    } catch (err) {
        if (client) await client.query('ROLLBACK').catch(() => { });
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    } finally {
        if (client) client.release();
    }
}

// GET /api/courses/:courseId/questions   (optional: ?difficulty=easy)
async function listQuestions(req, res) {
    try {
        const course = await findOwnCourse(req, res);
        if (!course) return;

        const { difficulty } = req.query;
        if (difficulty && !DIFFICULTIES.includes(difficulty)) {
            return res.status(400).json({ message: 'Invalid difficulty filter' });
        }

        const qs = difficulty
            ? await pool.query(
                `SELECT id, text, difficulty, marks::float AS marks
           FROM questions WHERE course_id = $1 AND difficulty = $2 ORDER BY id`,
                [course.id, difficulty]
            )
            : await pool.query(
                `SELECT id, text, difficulty, marks::float AS marks
           FROM questions WHERE course_id = $1 ORDER BY id`,
                [course.id]
            );

        const ids = qs.rows.map((q) => q.id);
        let optionRows = [];
        if (ids.length > 0) {
            const o = await pool.query(
                'SELECT id, question_id, text, is_correct FROM options WHERE question_id = ANY($1::int[]) ORDER BY id',
                [ids]
            );
            optionRows = o.rows;
        }

        const questions = qs.rows.map((q) => ({
            ...q,
            options: optionRows
                .filter((o) => o.question_id === q.id)
                .map((o) => ({ id: o.id, text: o.text, is_correct: o.is_correct })),
        }));

        res.json({ questions });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
}

// GET /api/questions/:id
async function getQuestion(req, res) {
    try {
        const found = await findOwnQuestion(req, res);
        if (!found) return;
        const question = await loadQuestionWithOptions(found.id);
        res.json({ question });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
}

// PUT /api/questions/:id   (replaces text, difficulty, marks and all options)
async function updateQuestion(req, res) {
    let client;
    try {
        const found = await findOwnQuestion(req, res);
        if (!found) return;

        const { error, data } = validateQuestion(req.body);
        if (error) return res.status(400).json({ message: error });

        if (await isUsedInAttempt(found.id)) {
            return res.status(409).json({
                message: 'This question was already used in an exam attempt and cannot be edited',
            });
        }

        client = await pool.connect();
        await client.query('BEGIN');

        await client.query(
            'UPDATE questions SET text = $1, difficulty = $2, marks = $3 WHERE id = $4',
            [data.text, data.difficulty, data.marks, found.id]
        );
        await client.query('DELETE FROM options WHERE question_id = $1', [found.id]);
        await insertOptions(client, found.id, data.options);

        await client.query('COMMIT');

        const question = await loadQuestionWithOptions(found.id);
        res.json({ question });
    } catch (err) {
        if (client) await client.query('ROLLBACK').catch(() => { });
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    } finally {
        if (client) client.release();
    }
}

// DELETE /api/questions/:id
async function deleteQuestion(req, res) {
    try {
        const found = await findOwnQuestion(req, res);
        if (!found) return;

        if (await isUsedInAttempt(found.id)) {
            return res.status(409).json({
                message: 'This question was already used in an exam attempt and cannot be deleted',
            });
        }

        await pool.query('DELETE FROM questions WHERE id = $1', [found.id]);
        res.json({ message: 'Question deleted' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
}

module.exports = {
    createQuestion,
    listQuestions,
    getQuestion,
    updateQuestion,
    deleteQuestion,
};