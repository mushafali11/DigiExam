// Simulated class load test.
// Run from the backend folder, with the server running:
//   node tests/loadTest.js 30
//
// It creates test students, starts one exam for ALL of them at the same moment,
// answers every question, and sends two submits at once per student
// to prove that double submission is blocked.

const BASE = 'http://localhost:5000/api';
const STUDENTS = Number(process.argv[2]) || 30;
const COURSE_ID = 1;

const latencies = [];

async function api(method, path, token, body) {
  const started = Date.now();
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

  latencies.push(Date.now() - started);
  return { status: res.status, data };
}

async function login(email, password) {
  const r = await api('POST', '/auth/login', null, { email, password });
  if (r.status !== 200) throw new Error(`Login failed for ${email}`);
  return r.data.token;
}

async function main() {
  console.log(`Load test with ${STUDENTS} students\n`);

  const admin = await login('admin@digiexam.com', 'admin123');
  const teacher = await login('teacher@digiexam.com', 'teacher123');

  // 1. Create the students (409 means they already exist, which is fine)
  const emails = Array.from({ length: STUDENTS }, (_, i) => `load${i + 1}@test.com`);
  await Promise.all(
    emails.map((email, i) =>
      api('POST', '/admin/users', admin, {
        name: `Load Student ${i + 1}`,
        email,
        password: 'load1234',
        role: 'student',
      })
    )
  );

  // 2. Enrol them in the course
  const list = await api('GET', '/admin/users?role=student', admin);
  const idByEmail = {};
  for (const u of list.data.users) idByEmail[u.email] = u.id;

  await Promise.all(
    emails.map((email) =>
      api('POST', `/courses/${COURSE_ID}/enrollments`, admin, { student_id: idByEmail[email] })
    )
  );

  // 3. Log everyone in
  const tokens = await Promise.all(emails.map((email) => login(email, 'load1234')));

  // 4. The teacher creates an exam that is open right now
  const now = Date.now();
  const exam = await api('POST', `/courses/${COURSE_ID}/exams`, teacher, {
    title: `Load test ${new Date().toISOString()}`,
    duration_min: 30,
    start_at: new Date(now - 60 * 1000).toISOString(),
    end_at: new Date(now + 2 * 60 * 60 * 1000).toISOString(),
    num_questions: 5,
    switch_limit: 3,
    negative_marking: false,
  });
  if (exam.status !== 201) {
    console.log('Could not create the exam:', exam.data);
    return;
  }
  const examId = exam.data.exam.id;

  // 5. EVERYONE starts at the same moment
  const t0 = Date.now();
  const starts = await Promise.all(
    tokens.map((tok) => api('POST', `/student/exams/${examId}/start`, tok))
  );
  const startMs = Date.now() - t0;
  const startedOk = starts.filter((s) => s.status === 201).length;
  console.log(`All students started in ${startMs} ms (${startedOk}/${STUDENTS} succeeded)`);

  // 6. Each student loads the paper, answers everything, then submits TWICE at once
  const t1 = Date.now();
  const outcomes = await Promise.all(
    tokens.map(async (tok, i) => {
      if (starts[i].status !== 201) return 'start failed';
      const attemptId = starts[i].data.attempt_id;

      const paper = await api('GET', `/attempts/${attemptId}`, tok);
      for (const q of paper.data.questions) {
        await api('PUT', `/attempts/${attemptId}/answers`, tok, {
          question_id: q.question_id,
          option_id: q.options[0].id,
        });
      }

      const [a, b] = await Promise.all([
        api('POST', `/attempts/${attemptId}/submit`, tok),
        api('POST', `/attempts/${attemptId}/submit`, tok),
      ]);
      return [a.status, b.status].sort().join('+');
    })
  );
  console.log(`Answering and submitting took ${Date.now() - t1} ms`);

  const doubleBlocked = outcomes.filter((o) => o === '200+409').length;

  // 7. Check the teacher's analytics
  const analytics = await api('GET', `/exams/${examId}/analytics`, teacher);
  const submitted = analytics.data.summary.submitted;

  // 8. Latency numbers
  const sorted = [...latencies].sort((a, b) => a - b);
  const avg = Math.round(sorted.reduce((s, x) => s + x, 0) / sorted.length);
  const p95 = sorted[Math.floor(0.95 * (sorted.length - 1))];

  console.log(`\nRequests sent: ${sorted.length}`);
  console.log(`Average response: ${avg} ms, 95th percentile: ${p95} ms, slowest: ${sorted[sorted.length - 1]} ms`);

  console.log('\nResults:');
  console.log(`${startedOk === STUDENTS ? 'PASS' : 'FAIL'}  every student started an attempt (${startedOk}/${STUDENTS})`);
  console.log(`${doubleBlocked === STUDENTS ? 'PASS' : 'FAIL'}  double submit blocked for every student (${doubleBlocked}/${STUDENTS} got exactly one 200 and one 409)`);
  console.log(`${submitted === STUDENTS ? 'PASS' : 'FAIL'}  analytics shows all attempts submitted (${submitted}/${STUDENTS})`);
  console.log(`\nAverage score in analytics: ${analytics.data.summary.average_score}`);
}

main().catch((err) => {
  console.error('Load test failed:', err.message);
  process.exit(1);
});