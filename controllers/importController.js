const pool = require('../db/pool');
const toId = require('../utils/toId');
const { parseCsv, toCsv, sendCsv } = require('../utils/csv');

const DIFFICULTIES = ['easy', 'medium', 'hard'];
const MAX_QUESTIONS = 200;
const HEADER = [
    'text', 'difficulty', 'marks',
    'option1', 'option2', 'option3', 'option4', 'option5', 'option6',
    'correct',
];

// Trims a cell, and removes the ' that exports add in front of = + - @
function clean(value) {
    return String(value === undefined ? '' : value).trim().replace(/^'(?=[=+\-@])/, '');
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

// Reads the CSV text. Returns { questions, errors }. Row 1 is the header, so the first question is row 2.
function parseQuestions(csvText) {
    let rows;
    try {
        rows = parseCsv(csvText);
    } catch (err) {
        return { questions: [], errors: [{ row: 0, message: err.message }] };
    }
    if (rows.length === 0) {
        return { questions: [], errors: [{ row: 0, message: 'The file is empty' }] };
    }

    const header = rows[0].map((h) => h.trim().toLowerCase());
    const col = Object.create(null);
    header.forEach((name, index) => {
        if (!(name in col)) col[name] = index;
    });

    const missing = ['text', 'option1', 'option2', 'correct'].filter((n) => !(n in col));
    if (missing.length > 0) {
        return {
            questions: [],
            errors: [{ row: 1, message: `Missing column(s): ${missing.join(', ')}. The first row must be the header row` }],
        };
    }

    const get = (row, name) => (name in col ? clean(row[col[name]]) : '');
    const questions = [];
    const errors = [];

    for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (row.every((c) => c.trim() === '')) continue;
        const rowNumber = i + 1;
        const problems = [];

        const text = get(row, 'text');
        if (!text) problems.push('Question text is empty');
        else if (text.length > 1000) problems.push('Question text is longer than 1000 characters');

        const difficulty = get(row, 'difficulty').toLowerCase() || 'medium';
        if (!DIFFICULTIES.includes(difficulty)) problems.push('difficulty must be easy, medium or hard');

        const marksRaw = get(row, 'marks');
        const marks = marksRaw === '' ? 1 : Number(marksRaw);
        if (!(marks > 0) || marks > 100) problems.push('marks must be more than 0 and at most 100');

        const all = [1, 2, 3, 4, 5, 6].map((k) => get(row, `option${k}`));
        let last = -1;
        all.forEach((t, idx) => {
            if (t) last = idx;
        });
        const options = all.slice(0, last + 1);

        let optionsOk = true;
        if (options.some((t) => !t)) {
            problems.push('options must be filled in order, with no empty option between two filled ones');
            optionsOk = false;
        } else if (options.length < 2) {
            problems.push('at least 2 options are needed');
            optionsOk = false;
        } else {
            if (options.some((t) => t.length > 500)) problems.push('an option is longer than 500 characters');
            if (new Set(options.map((t) => t.toLowerCase())).size !== options.length) {
                problems.push('two options have the same text');
            }
        }

        const correct = Number(get(row, 'correct'));
        if (optionsOk && (!Number.isInteger(correct) || correct < 1 || correct > options.length)) {
            problems.push(`correct must be a number from 1 to ${options.length} (the position of the right option)`);
        }

        if (problems.length > 0) {
            for (const p of problems) errors.push({ row: rowNumber, message: p });
        } else {
            questions.push({
                text,
                difficulty,
                marks,
                options: options.map((t, idx) => ({ text: t, is_correct: idx === correct - 1 })),
            });
        }
    }

    if (errors.length === 0 && questions.length === 0) {
        errors.push({ row: 0, message: 'No questions were found in the file' });
    }
    if (questions.length + errors.length > 0 && questions.length > MAX_QUESTIONS) {
        errors.push({ row: 0, message: `At most ${MAX_QUESTIONS} questions can be imported at once` });
    }
    return { questions, errors };
}

// POST /api/courses/:courseId/questions/import   body: { csv: "...", dry_run: true|false }
async function importQuestions(req, res) {
    let client;
    try {
        const course = await findOwnCourse(req, res);
        if (!course) return;

        const csv = req.body.csv;
        if (typeof csv !== 'string' || !csv.trim()) {
            return res.status(400).json({ message: 'Send the CSV text in the "csv" field' });
        }
        const dryRun = req.body.dry_run === true;

        const { questions, errors } = parseQuestions(csv);
        if (errors.length > 0) {
            return res.status(400).json({
                message: `The file has ${errors.length} problem(s). Nothing was imported`,
                errors: errors.slice(0, 50),
            });
        }

        // Skip questions that already exist in this course (same text), and repeats inside the file
        const existing = await pool.query(
            'SELECT lower(trim(text)) AS t FROM questions WHERE course_id = $1',
            [course.id]
        );
        const seen = new Set(existing.rows.map((r) => r.t));
        const fresh = [];
        let skipped = 0;
        for (const q of questions) {
            const key = q.text.toLowerCase();
            if (seen.has(key)) {
                skipped++;
                continue;
            }
            seen.add(key);
            fresh.push(q);
        }

        if (dryRun) {
            return res.json({ valid: true, would_import: fresh.length, skipped_duplicates: skipped });
        }

        client = await pool.connect();
        await client.query('BEGIN');
        for (const q of fresh) {
            const inserted = await client.query(
                `INSERT INTO questions (course_id, text, difficulty, marks, created_by)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
                [course.id, q.text, q.difficulty, q.marks, req.user.id]
            );
            for (const o of q.options) {
                await client.query(
                    'INSERT INTO options (question_id, text, is_correct) VALUES ($1, $2, $3)',
                    [inserted.rows[0].id, o.text, o.is_correct]
                );
            }
        }
        await client.query('COMMIT');

        res.status(201).json({ imported: fresh.length, skipped_duplicates: skipped });
    } catch (err) {
        if (client) await client.query('ROLLBACK').catch(() => { });
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    } finally {
        if (client) client.release();
    }
}

// GET /api/courses/:courseId/questions/export
async function exportQuestions(req, res) {
    try {
        const course = await findOwnCourse(req, res);
        if (!course) return;

        const info = await pool.query('SELECT code FROM courses WHERE id = $1', [course.id]);
        const qs = (
            await pool.query(
                'SELECT id, text, difficulty, marks::float AS marks FROM questions WHERE course_id = $1 ORDER BY id',
                [course.id]
            )
        ).rows;
        const ids = qs.map((q) => q.id);
        const opts = ids.length
            ? (
                await pool.query(
                    'SELECT question_id, text, is_correct FROM options WHERE question_id = ANY($1::int[]) ORDER BY id',
                    [ids]
                )
            ).rows
            : [];

        const rows = [HEADER];
        for (const q of qs) {
            const mine = opts.filter((o) => o.question_id === q.id);
            const cells = mine.slice(0, 6).map((o) => o.text);
            while (cells.length < 6) cells.push('');
            const correct = mine.findIndex((o) => o.is_correct) + 1;
            rows.push([q.text, q.difficulty, q.marks, ...cells, correct]);
        }

        const safeCode = String(info.rows[0].code).replace(/[^A-Za-z0-9_-]/g, '');
        sendCsv(res, `questions-${safeCode}.csv`, toCsv(rows));
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
}

// GET /api/questions/import-template
function importTemplate(req, res) {
    const rows = [
        HEADER,
        ['What does HTML stand for?', 'easy', 1, 'Hyper Text Markup Language', 'High Tech Modern Language', 'Home Tool Markup Language', '', '', '', 1],
        ['Which of these is a front-end library, not a database?', 'medium', 2, 'React', 'PostgreSQL', 'MySQL', 'MongoDB', '', '', 1],
        ['What does a 404 status code mean?', '', '', 'Not Found', 'Server Error', '', '', '', '', 1],
    ];
    sendCsv(res, 'question-import-template.csv', toCsv(rows));
}

module.exports = { importQuestions, exportQuestions, importTemplate };