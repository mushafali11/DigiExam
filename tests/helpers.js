// Shared helpers for the extras tests
require('dotenv').config();
const pool = require('../db/pool');

const BASE = `http://localhost:${process.env.PORT || 5000}/api`;
const state = { passed: 0, failed: 0 };

function check(name, ok, detail) {
    if (ok) {
        state.passed++;
        console.log(`  PASS  ${name}`);
    } else {
        state.failed++;
        console.log(`  FAIL  ${name}${detail ? '   -> ' + detail : ''}`);
    }
}

function section(title) {
    console.log(`\n${title}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const near = (a, b) => Math.abs(a - b) < 0.011;
const show = (r) => `status ${r.status} ${JSON.stringify(r.data)}`;

async function api(method, path, token, body, rawBody) {
    const res = await fetch(BASE + path, {
        method,
        headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: rawBody !== undefined ? rawBody : body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try {
        data = await res.json();
    } catch (err) {
        data = null;
    }
    return { status: res.status, data };
}

// For CSV downloads
async function raw(method, path, token) {
    const res = await fetch(BASE + path, {
        method,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    return {
        status: res.status,
        type: res.headers.get('content-type') || '',
        disposition: res.headers.get('content-disposition') || '',
        text: (await res.text()).replace(/^\uFEFF/, ''),
    };
}

async function login(email, password) {
    const r = await api('POST', '/auth/login', null, { email, password });
    if (r.status !== 200) throw new Error(`Cannot log in as ${email}: ${show(r)}`);
    return r.data.token;
}

// The body of an exam that is open right now
function examBody(extra = {}) {
    const now = Date.now();
    return {
        title: `EXTRAS TEST ${now}-${Math.random().toString(36).slice(2, 6)}`,
        duration_min: 30,
        start_at: new Date(now - 60 * 1000).toISOString(),
        end_at: new Date(now + 2 * 60 * 60 * 1000).toISOString(),
        num_questions: 3,
        switch_limit: 2,
        negative_marking: false,
        ...extra,
    };
}

async function setup() {
    const health = await api('GET', '/health').catch(() => null);
    if (!health || health.status !== 200) {
        console.log('The server is not running. Start it with "npm run dev" in another window, then try again.');
        process.exit(1);
    }
    const ctx = {};
    ctx.admin = await login('admin@digiexam.com', 'admin123');
    ctx.teacher = await login('teacher@digiexam.com', 'teacher123');
    ctx.s1 = await login('student1@digiexam.com', 'student123');
    ctx.s2 = await login('student2@digiexam.com', 'student123');

    // A second teacher (409 just means it already exists)
    await api('POST', '/admin/users', ctx.admin, {
        name: 'Teacher Two', email: 'teacher2@digiexam.com', password: 'teacher123', role: 'teacher',
    });
    ctx.t2 = await login('teacher2@digiexam.com', 'teacher123');

    const course = await pool.query("SELECT id FROM courses WHERE code = 'CSC336'");
    if (course.rows.length === 0) {
        console.log('Course CSC336 not found. Run "node db/seed.js" (or npm run demo:reset) first.');
        process.exit(1);
    }
    ctx.courseId = course.rows[0].id;
    return ctx;
}

async function makeExam(ctx, extra = {}) {
    const body = examBody(extra);
    const r = await api('POST', `/courses/${ctx.courseId}/exams`, ctx.teacher, body);
    if (r.status !== 201) throw new Error(`Could not create exam: ${show(r)}`);
    return { id: r.data.exam.id, body };
}

// Starts an attempt and loads the paper
async function begin(token, examId) {
    const st = await api('POST', `/student/exams/${examId}/start`, token);
    if (st.status !== 201) throw new Error(`Could not start exam ${examId}: ${show(st)}`);
    const paper = await api('GET', `/attempts/${st.data.attempt_id}`, token);
    return { attemptId: st.data.attempt_id, questions: paper.data.questions, paper };
}

function answer(token, attemptId, questionId, optionId) {
    return api('PUT', `/attempts/${attemptId}/answers`, token, {
        question_id: questionId,
        option_id: optionId,
    });
}

// Looks up the real correct and a wrong option, and the marks, for each question
async function truth(questionIds) {
    const o = await pool.query(
        'SELECT id, question_id, is_correct FROM options WHERE question_id = ANY($1::int[]) ORDER BY id',
        [questionIds]
    );
    const q = await pool.query(
        'SELECT id, marks::float AS marks FROM questions WHERE id = ANY($1::int[])',
        [questionIds]
    );
    const t = { marks: {}, correct: {}, wrong: {} };
    for (const r of q.rows) t.marks[r.id] = r.marks;
    for (const r of o.rows) {
        if (r.is_correct) t.correct[r.question_id] = r.id;
        else if (!t.wrong[r.question_id]) t.wrong[r.question_id] = r.id;
    }
    return t;
}

async function dbAttempt(attemptId) {
    const r = await pool.query(
        `SELECT status, submit_reason, score::float AS score, submitted_at, deadline_at
     FROM attempts WHERE id = $1`,
        [attemptId]
    );
    return r.rows[0];
}

async function expireAttempt(attemptId) {
    await pool.query(
        "UPDATE attempts SET deadline_at = NOW() - INTERVAL '5 seconds' WHERE id = $1",
        [attemptId]
    );
}

// Removes everything these tests created
async function cleanup() {
    await pool.query("DELETE FROM exams WHERE title LIKE 'EXTRAS TEST %'");
    await pool.query("DELETE FROM courses WHERE code = 'EXTRAS1'");
    await pool.query("DELETE FROM questions WHERE text LIKE 'EXTRAS IMPORT %'");
    await pool.query("DELETE FROM users WHERE email LIKE 'extras-%@test.com'");
}

async function runGroups(ctx, groups) {
    for (const group of groups) {
        try {
            await group(ctx);
        } catch (err) {
            state.failed++;
            console.log(`  FAIL  ${group.name} stopped with an error   -> ${err.message}`);
        }
    }
}

async function finish() {
    await cleanup().catch((err) => console.log('Cleanup problem:', err.message));
    await pool.end();
    console.log(`\n${state.passed} passed, ${state.failed} failed`);
    process.exit(state.failed > 0 ? 1 : 0);
}

module.exports = {
    pool, check, section, sleep, near, show, api, raw, login,
    examBody, setup, makeExam, begin, answer, truth, dbAttempt, expireAttempt,
    cleanup, runGroups, finish,
};