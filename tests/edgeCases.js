// Automated edge-case tests.
// Run from the backend folder, with the server running:
//   node tests/edgeCases.js
//
// Needs the seeded data (node db/seed.js): the demo accounts and course CSC336.

require('dotenv').config();
const pool = require('../db/pool');
const { sweepExpiredAttempts } = require('../services/attemptService');

const BASE = 'http://localhost:5000/api';
const ctx = {};
let passed = 0;
let failed = 0;

function check(name, ok, detail) {
    if (ok) {
        passed++;
        console.log(`  PASS  ${name}`);
    } else {
        failed++;
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

async function login(email, password) {
    const r = await api('POST', '/auth/login', null, { email, password });
    if (r.status !== 200) {
        throw new Error(`Cannot log in as ${email}. Run "node db/seed.js" first. (${show(r)})`);
    }
    return r.data.token;
}

// The body of an exam that is open right now
function examBody(extra = {}) {
    const now = Date.now();
    return {
        title: `EDGE TEST ${now}-${Math.random().toString(36).slice(2, 6)}`,
        duration_min: 30,
        start_at: new Date(now - 60 * 1000).toISOString(),
        end_at: new Date(now + 2 * 60 * 60 * 1000).toISOString(),
        num_questions: 3,
        switch_limit: 2,
        negative_marking: false,
        ...extra,
    };
}

async function makeExam(extra = {}) {
    const body = examBody(extra);
    const r = await api('POST', `/courses/${ctx.courseId}/exams`, ctx.teacher, body);
    if (r.status !== 201) throw new Error(`Could not create exam: ${show(r)}`);
    return { id: r.data.exam.id, body };
}

// Starts an attempt and loads the paper
async function begin(token, examId) {
    const st = await api('POST', `/student/exams/${examId}/start`, token);
    if (st.status !== 201) {
        throw new Error(`Could not start exam ${examId}: ${show(st)}. Is the student enrolled? Run "node db/seed.js"`);
    }
    const paper = await api('GET', `/attempts/${st.data.attempt_id}`, token);
    return { attemptId: st.data.attempt_id, questions: paper.data.questions, paper };
}

function answer(token, attemptId, questionId, optionId) {
    return api('PUT', `/attempts/${attemptId}/answers`, token, {
        question_id: questionId,
        option_id: optionId,
    });
}

// Looks up the real correct answers and marks in the database
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

// ---------------------------------------------------------------------------

async function testMainFlow() {
    section('1. Paper, locking, grading and the release rule');
    const exam = await makeExam();
    const a = await begin(ctx.s1, exam.id);
    const qids = a.questions.map((q) => q.question_id);

    check('paper never contains is_correct', !JSON.stringify(a.paper.data).includes('is_correct'));

    const again = await api('GET', `/attempts/${a.attemptId}`, ctx.s1);
    const sameOrder =
        JSON.stringify(again.data.questions) === JSON.stringify(a.questions);
    check('refresh returns the same paper (question and option order)', sameOrder);

    const other = await api('GET', `/attempts/${a.attemptId}`, ctx.s2);
    check("another student cannot read my attempt (404)", other.status === 404, show(other));

    const qBody = {
        text: 'changed',
        options: [
            { text: 'a', is_correct: true },
            { text: 'b', is_correct: false },
        ],
    };
    const editQ = await api('PUT', `/questions/${qids[0]}`, ctx.teacher, qBody);
    check('editing a question used in an attempt gives 409', editQ.status === 409, show(editQ));
    const delQ = await api('DELETE', `/questions/${qids[0]}`, ctx.teacher);
    check('deleting a question used in an attempt gives 409', delQ.status === 409, show(delQ));

    const editE = await api('PUT', `/exams/${exam.id}`, ctx.teacher, exam.body);
    check('editing an exam after a student started gives 409', editE.status === 409, show(editE));
    const delE = await api('DELETE', `/exams/${exam.id}`, ctx.teacher);
    check('deleting an exam after a student started gives 409', delE.status === 409, show(delE));
    const rel = await api('PATCH', `/exams/${exam.id}/release`, ctx.teacher, { release_results: false });
    check('release toggle still works after attempts exist', rel.status === 200, show(rel));

    // Answer everything correctly
    const t = await truth(qids);
    for (const q of a.questions) {
        await answer(ctx.s1, a.attemptId, q.question_id, t.correct[q.question_id]);
    }
    const total = qids.reduce((sum, id) => sum + t.marks[id], 0);

    const sub = await api('POST', `/attempts/${a.attemptId}/submit`, ctx.s1);
    check('manual submit returns 200', sub.status === 200, show(sub));
    const row = await dbAttempt(a.attemptId);
    check('all correct answers give full marks', row && near(row.score, total), `score ${row && row.score}, expected ${total}`);
    check('submit reason is manual', row && row.submit_reason === 'manual');

    const again2 = await api('POST', `/attempts/${a.attemptId}/submit`, ctx.s1);
    check('submitting twice gives 409', again2.status === 409, show(again2));
    const late = await answer(ctx.s1, a.attemptId, qids[0], t.correct[qids[0]]);
    check('saving after submit gives 409', late.status === 409, show(late));
    const restart = await api('POST', `/student/exams/${exam.id}/start`, ctx.s1);
    check('starting again after submit gives 409', restart.status === 409, show(restart));

    // Results are hidden until released
    const hidden = await api('GET', `/attempts/${a.attemptId}/result`, ctx.s1);
    check('result is hidden before release (403)', hidden.status === 403, show(hidden));
    const list1 = await api('GET', '/student/results', ctx.s1);
    const mine1 = list1.data && list1.data.results.find((r) => r.exam_id === exam.id);
    check('results list hides the score before release', mine1 && mine1.results_released === false && mine1.score === null);

    await api('PATCH', `/exams/${exam.id}/release`, ctx.teacher, { release_results: true });
    const shown = await api('GET', `/attempts/${a.attemptId}/result`, ctx.s1);
    check('result is visible after release', shown.status === 200 && near(shown.data.score, total), show(shown));
    check('result review lists every question', shown.data && shown.data.questions.length === qids.length);
    check('every answer is marked correct in the review', shown.data && shown.data.questions.every((q) => q.is_correct));
    const otherResult = await api('GET', `/attempts/${a.attemptId}/result`, ctx.s2);
    check("another student cannot read my result (404)", otherResult.status === 404, show(otherResult));

    const results = await api('GET', `/exams/${exam.id}/results`, ctx.teacher);
    const row1 = results.data && results.data.results.find((r) => r.email === 'student1@digiexam.com');
    check('teacher results table shows the submitted attempt', row1 && row1.status === 'submitted' && near(row1.score, total), show(results));
    const an = await api('GET', `/exams/${exam.id}/analytics`, ctx.teacher);
    check('analytics counts one submitted attempt', an.status === 200 && an.data.summary.submitted === 1, show(an));
    check('analytics highest score is correct', an.data && near(an.data.summary.highest_score, total));
}

async function testNegativeMarking() {
    section('2. Negative marking');
    const exam = await makeExam({ negative_marking: true });
    const a = await begin(ctx.s1, exam.id);
    const qids = a.questions.map((q) => q.question_id);
    const t = await truth(qids);

    // first question right, the others wrong
    await answer(ctx.s1, a.attemptId, qids[0], t.correct[qids[0]]);
    for (const id of qids.slice(1)) await answer(ctx.s1, a.attemptId, id, t.wrong[id]);
    await api('POST', `/attempts/${a.attemptId}/submit`, ctx.s1);

    let expected = t.marks[qids[0]];
    for (const id of qids.slice(1)) expected -= t.marks[id] * 0.25;
    expected = Math.max(0, expected);
    const row = await dbAttempt(a.attemptId);
    check('wrong answers lose 25% of their marks', row && near(row.score, expected), `score ${row && row.score}, expected ${expected}`);

    // unanswered questions are not penalised
    const exam2 = await makeExam({ negative_marking: true });
    const b = await begin(ctx.s1, exam2.id);
    const qids2 = b.questions.map((q) => q.question_id);
    const t2 = await truth(qids2);
    await answer(ctx.s1, b.attemptId, qids2[0], t2.correct[qids2[0]]);
    await api('POST', `/attempts/${b.attemptId}/submit`, ctx.s1);
    const row2 = await dbAttempt(b.attemptId);
    check('unanswered questions are not penalised', row2 && near(row2.score, t2.marks[qids2[0]]), `score ${row2 && row2.score}`);

    // all wrong never goes below zero
    const exam3 = await makeExam({ negative_marking: true });
    const c = await begin(ctx.s1, exam3.id);
    const qids3 = c.questions.map((q) => q.question_id);
    const t3 = await truth(qids3);
    for (const id of qids3) await answer(ctx.s1, c.attemptId, id, t3.wrong[id]);
    await api('POST', `/attempts/${c.attemptId}/submit`, ctx.s1);
    const row3 = await dbAttempt(c.attemptId);
    check('score never goes below zero', row3 && row3.score === 0, `score ${row3 && row3.score}`);
}

async function testTimeEdgeCases() {
    section('3. Time running out (late save, late submit, sweeper)');

    // Late save
    const e1 = await makeExam();
    const a = await begin(ctx.s1, e1.id);
    const q = a.questions[0];
    const t = await truth([q.question_id]);
    const saved = await answer(ctx.s1, a.attemptId, q.question_id, t.correct[q.question_id]);
    check('save before the deadline works', saved.status === 200, show(saved));
    await expireAttempt(a.attemptId);
    const lateSave = await answer(ctx.s1, a.attemptId, q.question_id, t.wrong[q.question_id] || t.correct[q.question_id]);
    check('save after the deadline gives 409', lateSave.status === 409, show(lateSave));
    const row = await dbAttempt(a.attemptId);
    check('attempt was auto-submitted with reason time_up', row && row.status === 'submitted' && row.submit_reason === 'time_up');
    check('submit time is recorded as the deadline', row && new Date(row.submitted_at).getTime() === new Date(row.deadline_at).getTime());
    check('the answer saved before the deadline was graded', row && near(row.score, t.marks[q.question_id]), `score ${row && row.score}`);
    const view = await api('GET', `/attempts/${a.attemptId}`, ctx.s1);
    check('loading an expired attempt shows it as submitted', view.data && view.data.attempt.status === 'submitted');

    // Late submit button press
    const e2 = await makeExam();
    const b = await begin(ctx.s2, e2.id);
    await expireAttempt(b.attemptId);
    const lateSubmit = await api('POST', `/attempts/${b.attemptId}/submit`, ctx.s2);
    check('pressing submit after the deadline still succeeds as time_up', lateSubmit.status === 200 && lateSubmit.data.reason === 'time_up', show(lateSubmit));

    // Background sweeper (nobody touches the attempt)
    const e3 = await makeExam();
    const c = await begin(ctx.s1, e3.id);
    await expireAttempt(c.attemptId);
    await sweepExpiredAttempts();
    const swept = await dbAttempt(c.attemptId);
    check('the background sweeper submits an abandoned attempt', swept && swept.status === 'submitted' && swept.submit_reason === 'time_up', JSON.stringify(swept));
}

async function testSwitches() {
    section('4. Tab switches');
    const exam = await makeExam({ switch_limit: 2 });
    const a = await begin(ctx.s1, exam.id);
    const ev = { type: 'tab_switch' };

    const one = await api('POST', `/attempts/${a.attemptId}/events`, ctx.s1, ev);
    check('first switch is logged', one.status === 200 && one.data.logged === true && one.data.switch_count === 1, show(one));
    const dup = await api('POST', `/attempts/${a.attemptId}/events`, ctx.s1, ev);
    check('a double-fired event is ignored', dup.status === 200 && dup.data.logged === false && dup.data.switch_count === 1, show(dup));

    const view = await api('GET', `/attempts/${a.attemptId}`, ctx.s1);
    check('refresh keeps the switch count', view.data && view.data.attempt.switch_count === 1 && view.data.attempt.switch_limit === 2);

    const forged = await api('POST', `/attempts/${a.attemptId}/events`, ctx.s1, { type: 'submit' });
    check('a student cannot forge other event types (400)', forged.status === 400, show(forged));

    await sleep(2300);
    const two = await api('POST', `/attempts/${a.attemptId}/events`, ctx.s1, ev);
    check('second switch is logged and still allowed', two.status === 200 && two.data.switch_count === 2 && two.data.auto_submitted === false, show(two));

    await sleep(2300);
    const three = await api('POST', `/attempts/${a.attemptId}/events`, ctx.s1, ev);
    check('exceeding the switch limit auto-submits', three.status === 200 && three.data.auto_submitted === true, show(three));
    const row = await dbAttempt(a.attemptId);
    check('submit reason is switch_limit', row && row.submit_reason === 'switch_limit');
    const after = await api('POST', `/attempts/${a.attemptId}/events`, ctx.s1, ev);
    check('switches after auto-submit give 409', after.status === 409, show(after));

    const act = await api('GET', `/exams/${exam.id}/activity`, ctx.teacher);
    const mine = act.data && act.data.attempts.find((r) => r.attempt_id === a.attemptId);
    check('teacher activity report shows 3 switches', mine && mine.switch_count === 3, show(act));
    const tl = await api('GET', `/exams/${exam.id}/attempts/${a.attemptId}/events`, ctx.teacher);
    const types = tl.data ? tl.data.events.map((e) => e.type) : [];
    check('teacher timeline has start, 3 switches and the auto-submit',
        types.filter((x) => x === 'tab_switch').length === 3 && types.includes('start') && types.includes('auto_submit'), types.join(','));
}

async function testConcurrency() {
    section('5. Two tabs and double clicks');

    // Same student starts the exam from two tabs at the same moment
    const e1 = await makeExam();
    const [r1, r2] = await Promise.all([
        api('POST', `/student/exams/${e1.id}/start`, ctx.s2),
        api('POST', `/student/exams/${e1.id}/start`, ctx.s2),
    ]);
    const okStatus = [r1.status, r2.status].every((s) => s === 200 || s === 201);
    check('two simultaneous starts both succeed', okStatus, `${r1.status} and ${r2.status}`);
    check('both starts return the same attempt', r1.data && r2.data && r1.data.attempt_id === r2.data.attempt_id);
    const count = await pool.query(
        "SELECT COUNT(*)::int AS n FROM attempts a JOIN users u ON u.id = a.student_id WHERE a.exam_id = $1 AND u.email = 'student2@digiexam.com'",
        [e1.id]
    );
    check('only one attempt row exists', count.rows[0].n === 1, `rows: ${count.rows[0].n}`);

    // Double click on Submit
    const e2 = await makeExam();
    const a = await begin(ctx.s1, e2.id);
    const [s1, s2] = await Promise.all([
        api('POST', `/attempts/${a.attemptId}/submit`, ctx.s1),
        api('POST', `/attempts/${a.attemptId}/submit`, ctx.s1),
    ]);
    const pair = [s1.status, s2.status].sort().join(',');
    check('two simultaneous submits give exactly one 200 and one 409', pair === '200,409', pair);
}

async function testDifficultyMix() {
    section('6. Difficulty mix');
    const have = ctx.have;

    const exam = await makeExam({ num_questions: 5, easy_count: 2, medium_count: 2, hard_count: 1 });
    for (const [name, token] of [['student 1', ctx.s1], ['student 2', ctx.s2]]) {
        const a = await begin(token, exam.id);
        const r = await pool.query(
            `SELECT q.difficulty, COUNT(*)::int AS n
       FROM attempt_questions aq JOIN questions q ON q.id = aq.question_id
       WHERE aq.attempt_id = $1 GROUP BY q.difficulty`,
            [a.attemptId]
        );
        const got = {};
        for (const row of r.rows) got[row.difficulty] = row.n;
        check(`${name} got exactly 2 easy, 2 medium, 1 hard`, got.easy === 2 && got.medium === 2 && got.hard === 1, JSON.stringify(got));
    }

    const sumWrong = await api('POST', `/courses/${ctx.courseId}/exams`, ctx.teacher,
        examBody({ num_questions: 5, easy_count: 2, medium_count: 2, hard_count: 2 }));
    check('a mix that does not add up to num_questions gives 400', sumWrong.status === 400, show(sumWrong));

    const tooMany = await api('POST', `/courses/${ctx.courseId}/exams`, ctx.teacher,
        examBody({ num_questions: have.hard + 1, easy_count: 0, medium_count: 0, hard_count: have.hard + 1 }));
    check('asking for more hard questions than exist gives 400', tooMany.status === 400, show(tooMany));

    const negative = await api('POST', `/courses/${ctx.courseId}/exams`, ctx.teacher,
        examBody({ num_questions: 5, easy_count: -1, medium_count: 3, hard_count: 3 }));
    check('a negative count gives 400', negative.status === 400, show(negative));

    const plain = await api('POST', `/courses/${ctx.courseId}/exams`, ctx.teacher, examBody({ num_questions: 5 }));
    check('an exam without a mix is still fully random and allowed', plain.status === 201, show(plain));
}

async function testValidationAndRoles() {
    section('7. Validation, errors and roles');

    const badName = await api('POST', '/auth/register', null, { name: 123, email: 'x@y.com', password: 'abc123' });
    check('a number as the name gives 400', badName.status === 400, show(badName));
    const noBody = await api('POST', '/auth/login');
    check('login with no body gives 400', noBody.status === 400, show(noBody));
    const badJson = await api('POST', '/auth/login', null, undefined, '{bad json');
    check('invalid JSON gives 400', badJson.status === 400, show(badJson));
    const unknown = await api('GET', '/nothing-here');
    check('unknown URL gives 404', unknown.status === 404, show(unknown));
    const longName = await api('POST', '/auth/register', null, { name: 'a'.repeat(150), email: 'x@y.com', password: 'abc123' });
    check('a 150-character name gives 400', longName.status === 400, show(longName));

    const adminBadName = await api('POST', '/admin/users', ctx.admin, { name: 123, email: 'a@b.com', password: 'abc123', role: 'student' });
    check('admin: a number as the name gives 400', adminBadName.status === 400, show(adminBadName));
    const badCode = await api('POST', '/courses', ctx.admin, { code: 123, title: 'X', teacher_id: 2 });
    check('a number as the course code gives 400', badCode.status === 400, show(badCode));
    const longCode = await api('POST', '/courses', ctx.admin, { code: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', title: 'X', teacher_id: 2 });
    check('a course code over 20 characters gives 400', longCode.status === 400, show(longCode));
    const longTitle = await api('POST', `/courses/${ctx.courseId}/exams`, ctx.teacher, examBody({ title: 'a'.repeat(200) }));
    check('an exam title over 150 characters gives 400', longTitle.status === 400, show(longTitle));
    const tooManyQ = await api('POST', `/courses/${ctx.courseId}/exams`, ctx.teacher, examBody({ num_questions: 500 }));
    check('asking for more questions than the course has gives 400', tooManyQ.status === 400, show(tooManyQ));
    const badDates = await api('POST', `/courses/${ctx.courseId}/exams`, ctx.teacher,
        examBody({ start_at: new Date(Date.now() + 7200000).toISOString(), end_at: new Date(Date.now() + 3600000).toISOString() }));
    check('end before start gives 400', badDates.status === 400, show(badDates));
    const twoCorrect = await api('POST', `/courses/${ctx.courseId}/questions`, ctx.teacher, {
        text: 'Bad',
        options: [{ text: 'A', is_correct: true }, { text: 'B', is_correct: true }],
    });
    check('a question with two correct options gives 400', twoCorrect.status === 400, show(twoCorrect));

    const noToken = await api('GET', '/auth/me');
    check('no token gives 401', noToken.status === 401, show(noToken));
    const garbage = await api('GET', '/auth/me', 'abc.def.ghi');
    check('a garbage token gives 401', garbage.status === 401, show(garbage));

    const studentTeacherRoute = await api('GET', `/courses/${ctx.courseId}/questions`, ctx.s1);
    check('a student on a teacher route gives 403', studentTeacherRoute.status === 403, show(studentTeacherRoute));
    const teacherStudentRoute = await api('GET', '/student/exams', ctx.teacher);
    check('a teacher on a student route gives 403', teacherStudentRoute.status === 403, show(teacherStudentRoute));
    const studentAdminRoute = await api('GET', '/admin/users', ctx.s1);
    check('a student on an admin route gives 403', studentAdminRoute.status === 403, show(studentAdminRoute));

    // A second teacher must not touch the first teacher's course
    await api('POST', '/admin/users', ctx.admin, { name: 'Teacher Two', email: 'teacher2@digiexam.com', password: 'teacher123', role: 'teacher' });
    const t2 = await login('teacher2@digiexam.com', 'teacher123');
    const otherQuestions = await api('GET', `/courses/${ctx.courseId}/questions`, t2);
    check("another teacher cannot read my course's questions (403)", otherQuestions.status === 403, show(otherQuestions));
    const exam = await makeExam();
    const otherExam = await api('GET', `/exams/${exam.id}/analytics`, t2);
    check("another teacher cannot read my exam's analytics (403)", otherExam.status === 403, show(otherExam));
}

// ---------------------------------------------------------------------------

async function main() {
    console.log('DigiExam edge-case tests');

    const health = await api('GET', '/health').catch(() => null);
    if (!health || health.status !== 200) {
        console.log('\nThe server is not running. Start it with "npm run dev" in another window, then try again.');
        process.exit(1);
    }

    ctx.admin = await login('admin@digiexam.com', 'admin123');
    ctx.teacher = await login('teacher@digiexam.com', 'teacher123');
    ctx.s1 = await login('student1@digiexam.com', 'student123');
    ctx.s2 = await login('student2@digiexam.com', 'student123');

    const course = await pool.query("SELECT id FROM courses WHERE code = 'CSC336'");
    if (course.rows.length === 0) {
        console.log('\nCourse CSC336 not found. Run "node db/seed.js" first.');
        process.exit(1);
    }
    ctx.courseId = course.rows[0].id;

    const counts = await pool.query(
        'SELECT difficulty, COUNT(*)::int AS n FROM questions WHERE course_id = $1 GROUP BY difficulty',
        [ctx.courseId]
    );
    ctx.have = { easy: 0, medium: 0, hard: 0 };
    for (const r of counts.rows) ctx.have[r.difficulty] = r.n;
    if (ctx.have.easy < 2 || ctx.have.medium < 2 || ctx.have.hard < 1) {
        console.log(`\nThe course needs at least 2 easy, 2 medium and 1 hard question (it has ${JSON.stringify(ctx.have)}).`);
        process.exit(1);
    }

    const groups = [
        testMainFlow,
        testNegativeMarking,
        testTimeEdgeCases,
        testSwitches,
        testConcurrency,
        testDifficultyMix,
        testValidationAndRoles,
    ];

    for (const group of groups) {
        try {
            await group();
        } catch (err) {
            failed++;
            console.log(`  FAIL  ${group.name} stopped with an error   -> ${err.message}`);
        }
    }

    // Remove the test exams (their attempts are deleted with them)
    await pool.query("DELETE FROM exams WHERE title LIKE 'EDGE TEST %'");
    await pool.end();

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (err) => {
    console.error('Test run crashed:', err.message);
    await pool.end().catch(() => { });
    process.exit(1);
});