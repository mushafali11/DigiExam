// Demo reset: wipes ALL data and rebuilds a ready-to-demo world.
// Run from the backend folder, with the server running:
//   npm run demo:reset          (asks you to type YES)
//   npm run demo:reset -- --yes (skips the question)

require('dotenv').config();
const readline = require('readline');
const bcrypt = require('bcrypt');
const pool = require('./pool');

const BASE = `http://localhost:${process.env.PORT || 5000}/api`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// [difficulty, question, correct answer, [three wrong answers]]
const QUESTIONS = [
    ['easy', 'What does HTML stand for?', 'Hyper Text Markup Language',
        ['High Tech Modern Language', 'Hyperlinks and Text Marking Language', 'Home Tool Markup Language']],
    ['easy', 'Which HTML tag creates the largest heading?', 'h1', ['h6', 'head', 'header']],
    ['easy', 'Which CSS property changes the color of text?', 'color', ['font-color', 'text-color', 'foreground']],
    ['easy', 'Which HTML tag is used to create a hyperlink?', 'a', ['link', 'href', 'url']],
    ['easy', 'Which symbol is used for an ID selector in CSS?', '#', ['.', '*', '&']],
    ['easy', 'Which HTTP method is normally used to read data from a server?', 'GET', ['POST', 'DELETE', 'PUT']],
    ['easy', 'Which JavaScript keyword declares a block-scoped variable?', 'let', ['int', 'dim', 'string']],
    ['easy', 'What does CSS stand for?', 'Cascading Style Sheets',
        ['Creative Style Syntax', 'Computer Style Sheets', 'Colorful Style Sheets']],

    ['medium', 'Which HTTP status code means "Not Found"?', '404', ['200', '401', '500']],
    ['medium', 'Which CSS display value lays out children in a flexible row or column?', 'flex',
        ['block', 'inline', 'table-cell']],
    ['medium', 'What does JSON.parse() do in JavaScript?', 'Converts a JSON string into an object',
        ['Converts an object into a JSON string', 'Sends JSON to the server', 'Validates an HTML form']],
    ['medium', 'Which React hook keeps a value that, when changed, re-renders the component?', 'useState',
        ['useRef', 'useId', 'useCallback']],
    ['medium', 'Which Express method registers a handler for POST requests?', 'app.post()',
        ['app.get()', 'app.listen()', 'app.static()']],
    ['medium', 'What is bcrypt used for in an authentication system?', 'Hashing passwords before storing them',
        ['Encrypting the whole database', 'Creating JWT tokens', 'Validating email addresses']],
    ['medium', 'Which SQL clause filters rows AFTER they have been grouped?', 'HAVING',
        ['WHERE', 'ORDER BY', 'LIMIT']],
    ['medium', 'What does CORS control?', 'Which other websites may call an API from a browser',
        ['How passwords are hashed', 'How database connections are pooled', 'How files are compressed']],

    ['hard', 'A JWT has three parts. Which part carries claims such as the user id and role?', 'Payload',
        ['Header', 'Signature', 'Salt']],
    ['hard', 'What does SELECT ... FOR UPDATE do inside a PostgreSQL transaction?',
        'Locks the selected rows until the transaction ends',
        ['Updates the selected rows automatically', 'Creates an index on them', 'Makes the query read-only']],
    ['hard', 'Why must the timer of an online exam be enforced on the server?',
        'The user can change or reset the browser clock',
        ['Servers count faster than browsers', 'Browsers cannot count seconds', 'HTTP forbids timers']],
    ['hard', 'Which statement about SQL injection is correct?',
        'Parameterized queries prevent it by keeping SQL code separate from data',
        ['It only affects NoSQL databases', 'Hashing passwords prevents it', 'Using HTTPS prevents it']],
    ['hard', 'Which browser API tells a page that its tab has become hidden?',
        'Page Visibility API (visibilitychange)',
        ['Geolocation API', 'Web Storage API', 'Fetch API']],
    ['hard', 'What is the difference between authentication and authorization?',
        'Authentication proves who you are; authorization decides what you may do',
        ['Authentication decides what you may do; authorization proves who you are',
            'They mean the same thing', 'Authentication only applies to administrators']],
    ['hard', 'What does an HTTP 409 response indicate?', 'A conflict with the current state of the resource',
        ['The user is not logged in', 'The server crashed', 'The resource has moved permanently']],
    ['hard', 'In React, why should list items have a stable key prop?',
        'So React can match items between renders and update the DOM efficiently',
        ['To style the items', 'To sort the items alphabetically', 'HTML requires it']],
];

const PEOPLE = [
    ['Admin', 'admin@digiexam.com', 'admin123', 'admin'],
    ['Teacher One', 'teacher@digiexam.com', 'teacher123', 'teacher'],
    ['Student One', 'student1@digiexam.com', 'student123', 'student'],
    ['Student Two', 'student2@digiexam.com', 'student123', 'student'],
    ['Student Three', 'student3@digiexam.com', 'student123', 'student'],
    ['Student Four', 'student4@digiexam.com', 'student123', 'student'],
    ['Student Five', 'student5@digiexam.com', 'student123', 'student'],
];

async function api(method, path, token, body) {
    const res = await fetch(BASE + path, {
        method,
        headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
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
    if (r.status !== 200) throw new Error(`Login failed for ${email}: ${JSON.stringify(r.data)}`);
    return r.data.token;
}

function confirmWipe() {
    if (process.argv.includes('--yes')) return Promise.resolve(true);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question(
            `\nThis will DELETE ALL DATA in the database "${process.env.DB_NAME}" and rebuild the demo data.\nType YES to continue: `,
            (answer) => {
                rl.close();
                resolve(answer.trim() === 'YES');
            }
        );
    });
}

async function wipeAndSeed() {
    await pool.query(
        `TRUNCATE attempt_events, answers, attempt_questions, attempts, exams,
              options, questions, enrollments, courses, users RESTART IDENTITY CASCADE`
    );

    for (const [name, email, password, role] of PEOPLE) {
        const hash = await bcrypt.hash(password, 10);
        await pool.query(
            'INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4)',
            [name, email, hash, role]
        );
    }

    const teacher = (await pool.query("SELECT id FROM users WHERE email = 'teacher@digiexam.com'")).rows[0];
    const course = (
        await pool.query(
            `INSERT INTO courses (code, title, teacher_id)
       VALUES ('CSC336', 'Web Technologies', $1) RETURNING id`,
            [teacher.id]
        )
    ).rows[0];

    await pool.query(
        `INSERT INTO enrollments (course_id, student_id)
     SELECT $1::int, id FROM users WHERE role = 'student'`,
        [course.id]
    );

    for (let i = 0; i < QUESTIONS.length; i++) {
        const [difficulty, text, correct, wrong] = QUESTIONS[i];
        const q = await pool.query(
            `INSERT INTO questions (course_id, text, difficulty, marks, created_by)
       VALUES ($1, $2, $3, 1, $4) RETURNING id`,
            [course.id, text, difficulty, teacher.id]
        );

        // Spread the correct answer over different positions
        const options = wrong.map((w) => ({ text: w, ok: false }));
        options.splice(i % 4, 0, { text: correct, ok: true });
        for (const o of options) {
            await pool.query(
                'INSERT INTO options (question_id, text, is_correct) VALUES ($1, $2, $3)',
                [q.rows[0].id, o.text, o.ok]
            );
        }
    }

    return { courseId: course.id };
}

// Looks up the right and a wrong option for each question
async function truth(questionIds) {
    const r = await pool.query(
        'SELECT id, question_id, is_correct FROM options WHERE question_id = ANY($1::int[]) ORDER BY id',
        [questionIds]
    );
    const t = { correct: {}, wrong: {} };
    for (const o of r.rows) {
        if (o.is_correct) t.correct[o.question_id] = o.id;
        else if (!t.wrong[o.question_id]) t.wrong[o.question_id] = o.id;
    }
    return t;
}

// One student takes the exam through the REAL API
async function runStudent(token, examId, plan) {
    const st = await api('POST', `/student/exams/${examId}/start`, token);
    if (st.status !== 201) throw new Error(`${plan.email} could not start: ${JSON.stringify(st.data)}`);
    const attemptId = st.data.attempt_id;

    const paper = await api('GET', `/attempts/${attemptId}`, token);
    const questions = paper.data.questions;
    const t = await truth(questions.map((q) => q.question_id));

    for (let i = 0; i < plan.answered; i++) {
        const q = questions[i];
        const optionId = i < plan.correct ? t.correct[q.question_id] : t.wrong[q.question_id];
        await api('PUT', `/attempts/${attemptId}/answers`, token, {
            question_id: q.question_id,
            option_id: optionId,
        });
    }

    for (let i = 0; i < plan.switches; i++) {
        if (i > 0) await sleep(2300); // the server ignores switches closer than 2 seconds
        await api('POST', `/attempts/${attemptId}/events`, token, { type: 'tab_switch' });
    }

    if (plan.finish === 'manual') {
        await api('POST', `/attempts/${attemptId}/submit`, token);
    } else if (plan.finish === 'time_up') {
        // Pretend the clock ran out, then let the server notice it
        await pool.query(
            "UPDATE attempts SET deadline_at = NOW() - INTERVAL '5 seconds' WHERE id = $1",
            [attemptId]
        );
        await api('GET', `/attempts/${attemptId}`, token);
    }
    // finish === 'switches': the switch limit already submitted it
}

async function main() {
    if (process.env.NODE_ENV === 'production') {
        console.log('Refusing to run: NODE_ENV is production.');
        process.exit(1);
    }

    const health = await api('GET', '/health').catch(() => null);
    if (!health || health.status !== 200) {
        console.log('The server is not running. Start it with "npm run dev" in another window, then try again.');
        process.exit(1);
    }

    if (!(await confirmWipe())) {
        console.log('Cancelled. Nothing was changed.');
        await pool.end();
        return;
    }

    console.log('\n1/4 Wiping the database and adding users, course and questions...');
    const { courseId } = await wipeAndSeed();

    const teacher = await login('teacher@digiexam.com', 'teacher123');
    const tokens = {};
    for (let i = 1; i <= 5; i++) tokens[i] = await login(`student${i}@digiexam.com`, 'student123');

    const now = Date.now();
    const hours = (h) => new Date(now + h * 3600 * 1000).toISOString();

    console.log('2/4 Creating and running "Quiz 1 (completed)" through the real API (takes about 10 seconds)...');
    const done = await api('POST', `/courses/${courseId}/exams`, teacher, {
        title: 'Quiz 1 (completed)',
        duration_min: 30,
        start_at: new Date(now - 60 * 1000).toISOString(),
        end_at: hours(2),
        num_questions: 5,
        switch_limit: 2,
        negative_marking: false,
        easy_count: 2,
        medium_count: 2,
        hard_count: 1,
    });
    if (done.status !== 201) throw new Error(`Could not create the completed quiz: ${JSON.stringify(done.data)}`);
    const doneId = done.data.exam.id;

    await Promise.all([
        runStudent(tokens[1], doneId, { answered: 5, correct: 5, switches: 0, finish: 'manual' }),
        runStudent(tokens[2], doneId, { answered: 4, correct: 3, switches: 0, finish: 'time_up' }),
        runStudent(tokens[3], doneId, { answered: 5, correct: 3, switches: 2, finish: 'manual' }),
        runStudent(tokens[4], doneId, { answered: 2, correct: 1, switches: 3, finish: 'switches' }),
    ]);

    // Move the whole quiz three days into the past and release its results
    await pool.query(
        `UPDATE exams SET start_at = NOW() - INTERVAL '3 days',
                      end_at = NOW() - INTERVAL '3 days' + INTERVAL '3 hours'
     WHERE id = $1`,
        [doneId]
    );
    await pool.query(
        `UPDATE attempts SET started_at = started_at - INTERVAL '3 days',
                         deadline_at = deadline_at - INTERVAL '3 days',
                         submitted_at = submitted_at - INTERVAL '3 days'
     WHERE exam_id = $1`,
        [doneId]
    );
    await pool.query(
        `UPDATE answers SET saved_at = saved_at - INTERVAL '3 days'
     WHERE attempt_id IN (SELECT id FROM attempts WHERE exam_id = $1)`,
        [doneId]
    );
    await pool.query(
        `UPDATE attempt_events SET created_at = created_at - INTERVAL '3 days'
     WHERE attempt_id IN (SELECT id FROM attempts WHERE exam_id = $1)`,
        [doneId]
    );
    await api('PATCH', `/exams/${doneId}/release`, teacher, { release_results: true });

    console.log('3/4 Creating the live demo exams...');
    const live = [
        {
            title: 'Demo Quiz - open now', duration_min: 20, start_at: new Date(now - 60 * 1000).toISOString(),
            end_at: hours(24), num_questions: 5, switch_limit: 2, negative_marking: true,
            easy_count: 2, medium_count: 2, hard_count: 1,
        },
        {
            title: 'Timer Demo (2 minutes)', duration_min: 2, start_at: new Date(now - 60 * 1000).toISOString(),
            end_at: hours(24), num_questions: 3, switch_limit: 3, negative_marking: false,
        },
        {
            title: 'Upcoming Midterm', duration_min: 60, start_at: hours(24), end_at: hours(27),
            num_questions: 10, switch_limit: 2, negative_marking: true,
            easy_count: 3, medium_count: 4, hard_count: 3,
        },
    ];
    const created = [];
    for (const body of live) {
        const r = await api('POST', `/courses/${courseId}/exams`, teacher, body);
        if (r.status !== 201) throw new Error(`Could not create "${body.title}": ${JSON.stringify(r.data)}`);
        created.push(r.data.exam);
    }

    console.log('4/4 Checking the result...\n');
    const rows = (
        await pool.query(
            `SELECT u.email, a.status, a.submit_reason, a.score::float AS score,
              (SELECT COUNT(*)::int FROM attempt_events ev
               WHERE ev.attempt_id = a.id AND ev.type = 'tab_switch') AS switches
       FROM attempts a JOIN users u ON u.id = a.student_id
       WHERE a.exam_id = $1 ORDER BY u.email`,
            [doneId]
        )
    ).rows;

    console.log('Quiz 1 (completed), results released:');
    for (const r of rows) {
        console.log(`  ${r.email.padEnd(24)} ${String(r.status).padEnd(10)} ${String(r.submit_reason).padEnd(13)} score ${r.score}   switches ${r.switches}`);
    }
    console.log('  student5@digiexam.com    not attempted');

    console.log('\nLive exams:');
    for (const e of created) console.log(`  exam ${e.id}: ${e.title}`);

    console.log('\nAccounts: admin@digiexam.com / admin123, teacher@digiexam.com / teacher123,');
    console.log('          student1..student5@digiexam.com / student123');
    console.log('\nDemo data is ready.');
    await pool.end();
}

main().catch(async (err) => {
    console.error('\nDemo reset failed:', err.message);
    await pool.end().catch(() => { });
    process.exit(1);
});