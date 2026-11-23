// Extras tests, part A: time extension, reopen, teacher review, results export
const h = require('./helpers');
const { check, section, api, raw, sleep, near, show } = h;

async function testExtendInProgress(ctx) {
    section('1. Extending the time of an attempt in progress');
    const exam = await h.makeExam(ctx);
    const a = await h.begin(ctx.s1, exam.id);
    const before = a.paper.data.attempt.remaining_seconds;
    const path = `/exams/${exam.id}/attempts/${a.attemptId}/extend`;

    const zero = await api('POST', path, ctx.teacher, { extra_minutes: 0 });
    check('0 extra minutes gives 400', zero.status === 400, show(zero));
    const huge = await api('POST', path, ctx.teacher, { extra_minutes: 500 });
    check('500 extra minutes gives 400', huge.status === 400, show(huge));
    const asText = await api('POST', path, ctx.teacher, { extra_minutes: '10' });
    check('minutes sent as text give 400', asText.status === 400, show(asText));
    const byStudent = await api('POST', path, ctx.s1, { extra_minutes: 10 });
    check('a student cannot extend time (403)', byStudent.status === 403, show(byStudent));
    const byOther = await api('POST', path, ctx.t2, { extra_minutes: 10 });
    check("another teacher cannot extend my exam's attempt (403)", byOther.status === 403, show(byOther));

    const otherExam = await h.makeExam(ctx);
    const wrongExam = await api(
        'POST', `/exams/${otherExam.id}/attempts/${a.attemptId}/extend`, ctx.teacher, { extra_minutes: 5 }
    );
    check('an attempt of a different exam gives 404', wrongExam.status === 404, show(wrongExam));

    const ok = await api('POST', path, ctx.teacher, { extra_minutes: 10, reason: 'Power cut' });
    check('the teacher can extend (action extended)', ok.status === 200 && ok.data.action === 'extended', show(ok));
    const after = await api('GET', `/attempts/${a.attemptId}`, ctx.s1);
    const gained = after.data.attempt.remaining_seconds - before;
    check('remaining time grew by about 10 minutes', gained >= 590 && gained <= 610, `gained ${gained}`);

    const tl = await api('GET', `/exams/${exam.id}/attempts/${a.attemptId}/events`, ctx.teacher);
    const ev = tl.data && tl.data.events.find((e) => e.type === 'extend');
    check('the timeline records the extension and its reason', ev && ev.detail.includes('Power cut'), JSON.stringify(tl.data));
    const act = await api('GET', `/exams/${exam.id}/activity`, ctx.teacher);
    const row = act.data && act.data.attempts.find((r) => r.attempt_id === a.attemptId);
    check('the activity report shows extra_minutes 10', row && row.extra_minutes === 10, JSON.stringify(row));
}

async function testReopenTimeUp(ctx) {
    section('2. Reopening an attempt that ran out of time');
    const exam = await h.makeExam(ctx);
    const a = await h.begin(ctx.s2, exam.id);
    const q = a.questions[0];
    const t = await h.truth([q.question_id]);
    await h.answer(ctx.s2, a.attemptId, q.question_id, t.correct[q.question_id]);
    await h.expireAttempt(a.attemptId);

    const late = await h.answer(ctx.s2, a.attemptId, q.question_id, t.correct[q.question_id]);
    check('a save after the deadline is refused (409)', late.status === 409, show(late));

    const path = `/exams/${exam.id}/attempts/${a.attemptId}/extend`;
    const ok = await api('POST', path, ctx.teacher, { extra_minutes: 5, reason: 'Network problem' });
    check('the teacher reopens the attempt', ok.status === 200 && ok.data.action === 'reopened', show(ok));
    const row = await h.dbAttempt(a.attemptId);
    check('it is in progress again with no score', row.status === 'in_progress' && row.score === null && row.submit_reason === null, JSON.stringify(row));

    const view = await api('GET', `/attempts/${a.attemptId}`, ctx.s2);
    const left = view.data.attempt.remaining_seconds;
    check('the student has about 5 minutes and the saved answer is still there',
        view.data.attempt.status === 'in_progress' && left > 280 && left <= 300 &&
        view.data.answers[q.question_id] === t.correct[q.question_id], JSON.stringify(view.data.attempt));

    const list = await api('GET', '/student/exams', ctx.s2);
    const listed = list.data.exams.find((e) => e.id === exam.id);
    check('the exam list shows it as in_progress (Resume)', listed && listed.attempt_status === 'in_progress', JSON.stringify(listed));

    const q2 = a.questions[1];
    const t2 = await h.truth([q2.question_id]);
    const save = await h.answer(ctx.s2, a.attemptId, q2.question_id, t2.wrong[q2.question_id]);
    check('the student can save answers again', save.status === 200, show(save));
    const sub = await api('POST', `/attempts/${a.attemptId}/submit`, ctx.s2);
    check('and submit again', sub.status === 200 && sub.data.reason === 'manual', show(sub));
    const done = await h.dbAttempt(a.attemptId);
    check('it is graded again (only the correct answer counts)', done && near(done.score, t.marks[q.question_id]), `score ${done && done.score}`);
}

async function testReopenSwitchLimit(ctx) {
    section('3. Reopening after the switch limit (switches are excused, not deleted)');
    const exam = await h.makeExam(ctx, { switch_limit: 1 });
    const a = await h.begin(ctx.s1, exam.id);
    const ev = { type: 'tab_switch' };
    const events = `/attempts/${a.attemptId}/events`;

    await api('POST', events, ctx.s1, ev);
    await sleep(2300);
    const second = await api('POST', events, ctx.s1, ev);
    check('the second switch auto-submits (limit 1)', second.data && second.data.auto_submitted === true, show(second));

    const ok = await api('POST', `/exams/${exam.id}/attempts/${a.attemptId}/extend`, ctx.teacher,
        { extra_minutes: 10, reason: 'Accidental click' });
    check('the teacher reopens it', ok.status === 200 && ok.data.action === 'reopened', show(ok));

    const view = await api('GET', `/attempts/${a.attemptId}`, ctx.s1);
    check('the student has a fresh switch counter (0 of 1)',
        view.data.attempt.switch_count === 0 && view.data.attempt.switch_limit === 1, JSON.stringify(view.data.attempt));

    await sleep(2300);
    const third = await api('POST', events, ctx.s1, ev);
    check('one more switch is tolerated again and does not auto-submit',
        third.data && third.data.logged === true && third.data.switch_count === 1 && third.data.auto_submitted === false, show(third));

    const act = await api('GET', `/exams/${exam.id}/activity`, ctx.teacher);
    const row = act.data.attempts.find((r) => r.attempt_id === a.attemptId);
    check('the teacher still sees all 3 switches as evidence (2 excused)',
        row && row.switch_count === 3 && row.excused_switches === 2, JSON.stringify(row));

    const tl = await api('GET', `/exams/${exam.id}/attempts/${a.attemptId}/events`, ctx.teacher);
    const switches = tl.data.events.filter((e) => e.type === 'tab_switch');
    check('the timeline marks the first 2 switches as excused and records the reopen',
        switches.filter((e) => e.excused).length === 2 && tl.data.events.some((e) => e.type === 'reopen'), JSON.stringify(tl.data.events));
}

async function testManualNotReopenable(ctx) {
    section('4. A manual submission cannot be reopened');
    const exam = await h.makeExam(ctx);
    const a = await h.begin(ctx.s1, exam.id);
    await api('POST', `/attempts/${a.attemptId}/submit`, ctx.s1);
    const r = await api('POST', `/exams/${exam.id}/attempts/${a.attemptId}/extend`, ctx.teacher, { extra_minutes: 5 });
    check('reopening a manual submission gives 409', r.status === 409, show(r));
    const row = await h.dbAttempt(a.attemptId);
    check('the attempt stays submitted', row.status === 'submitted', JSON.stringify(row));
}

async function testReview(ctx) {
    section('5. Teacher review of one attempt');
    const exam = await h.makeExam(ctx);
    const a = await h.begin(ctx.s1, exam.id);
    const ids = a.questions.map((q) => q.question_id);
    const t = await h.truth(ids);
    await h.answer(ctx.s1, a.attemptId, ids[0], t.correct[ids[0]]);
    for (const id of ids.slice(1)) await h.answer(ctx.s1, a.attemptId, id, t.wrong[id]);
    await api('POST', `/attempts/${a.attemptId}/submit`, ctx.s1);

    const path = `/exams/${exam.id}/attempts/${a.attemptId}/review`;
    const rv = await api('GET', path, ctx.teacher);
    check('the teacher gets the review', rv.status === 200 && rv.data.attempt.student_email === 'student1@digiexam.com', show(rv));
    check('it lists every question with the correct option', rv.data.questions.length === ids.length &&
        rv.data.questions.every((q) => q.correct_option_id !== null));
    check('only the first answer is marked correct', rv.data.questions[0].is_correct === true &&
        rv.data.questions.slice(1).every((q) => q.is_correct === false));
    check('the score matches', near(rv.data.score, t.marks[ids[0]]), `score ${rv.data.score}`);

    const byOther = await api('GET', path, ctx.t2);
    check("another teacher cannot review (403)", byOther.status === 403, show(byOther));
    const byStudent = await api('GET', path, ctx.s1);
    check('a student cannot use the teacher review (403)', byStudent.status === 403, show(byStudent));
    const otherExam = await h.makeExam(ctx);
    const wrong = await api('GET', `/exams/${otherExam.id}/attempts/${a.attemptId}/review`, ctx.teacher);
    check('an attempt of a different exam gives 404', wrong.status === 404, show(wrong));
}

async function testExport(ctx) {
    section('6. Results export (CSV)');
    await api('POST', '/admin/users', ctx.admin, {
        name: '=SUM(1+1)', email: 'extras-formula@test.com', password: 'abc12345', role: 'student',
    });
    const list = await api('GET', '/admin/users?role=student', ctx.admin);
    const sid = list.data.users.find((u) => u.email === 'extras-formula@test.com').id;
    await api('POST', `/courses/${ctx.courseId}/enrollments`, ctx.admin, { student_id: sid });

    const exam = await h.makeExam(ctx);
    const a = await h.begin(ctx.s1, exam.id);
    await api('POST', `/attempts/${a.attemptId}/submit`, ctx.s1);

    const r = await raw('GET', `/exams/${exam.id}/results/export`, ctx.teacher);
    const lines = r.text.trim().split(/\r?\n/);
    check('it downloads as CSV with the right file name',
        r.status === 200 && r.type.includes('text/csv') && r.disposition.includes(`exam-${exam.id}-results.csv`),
        `${r.status} ${r.type} ${r.disposition}`);
    check('the header row is right',
        lines[0] === 'Name,Email,Status,Score,Total marks,Percentage,Submit reason,Submitted at,Tab switches,Extra minutes', lines[0]);
    check('a submitted student has a row', lines.some((l) => l.includes('student1@digiexam.com') && l.includes('submitted')));
    check('a student who never started shows not_attempted', lines.some((l) => l.includes('student2@digiexam.com') && l.includes('not_attempted')));
    check('a name that looks like a formula is neutralised',
        r.text.includes("'=SUM(1+1)") && !lines.some((l) => l.startsWith('=SUM')));

    const byOther = await raw('GET', `/exams/${exam.id}/results/export`, ctx.t2);
    check("another teacher cannot export (403)", byOther.status === 403, String(byOther.status));
    const byStudent = await raw('GET', `/exams/${exam.id}/results/export`, ctx.s1);
    check('a student cannot export (403)', byStudent.status === 403, String(byStudent.status));
}

async function main() {
    console.log('DigiExam extras tests, part A (time extension, review, export)');
    const ctx = await h.setup();
    await h.runGroups(ctx, [
        testExtendInProgress, testReopenTimeUp, testReopenSwitchLimit,
        testManualNotReopenable, testReview, testExport,
    ]);
    await h.finish();
}

main().catch(async (err) => {
    console.error('Test run crashed:', err.message);
    await h.pool.end().catch(() => { });
    process.exit(1);
});