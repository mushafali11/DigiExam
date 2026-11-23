// Extras tests, part B: question import/export, admin management, change password
const h = require('./helpers');
const { check, section, api, raw, show } = h;

const stamp = Date.now();
const HEADER = 'text,difficulty,marks,option1,option2,option3,option4,option5,option6,correct';

async function testImport(ctx) {
    section('1. Question import and export (CSV)');
    const tpl = await raw('GET', '/questions/import-template', ctx.teacher);
    check('the template downloads as CSV with the right header',
        tpl.status === 200 && tpl.type.includes('text/csv') && tpl.text.startsWith(HEADER), tpl.text.slice(0, 80));
    const tplStudent = await raw('GET', '/questions/import-template', ctx.s1);
    check('a student cannot download the template (403)', tplStudent.status === 403, String(tplStudent.status));

    const path = `/courses/${ctx.courseId}/questions/import`;
    const good = [
        HEADER,
        `EXTRAS IMPORT ${stamp} A,easy,1,Yes,No,,,,,1`,
        `"EXTRAS IMPORT ${stamp} B, with a comma and ""quotes""",hard,2,One,Two,Three,,,,3`,
        `EXTRAS IMPORT ${stamp} C,,,Alpha,Beta,,,,,2`,
    ].join('\r\n');

    const dry = await api('POST', path, ctx.teacher, { csv: good, dry_run: true });
    check('a dry run accepts the file', dry.status === 200 && dry.data.valid === true && dry.data.would_import === 3, show(dry));
    const none = await h.pool.query('SELECT COUNT(*)::int AS n FROM questions WHERE text LIKE $1', [`EXTRAS IMPORT ${stamp}%`]);
    check('a dry run imports nothing', none.rows[0].n === 0);

    const real = await api('POST', path, ctx.teacher, { csv: good });
    check('the import creates 3 questions', real.status === 201 && real.data.imported === 3, show(real));
    const rows = (await h.pool.query(
        `SELECT q.text, q.difficulty, q.marks::float AS marks,
            (SELECT COUNT(*)::int FROM options o WHERE o.question_id = q.id) AS opts,
            (SELECT o.text FROM options o WHERE o.question_id = q.id AND o.is_correct) AS right_answer
     FROM questions q WHERE q.text LIKE $1 ORDER BY q.id`, [`EXTRAS IMPORT ${stamp}%`])).rows;
    check('quoted text with a comma and quotes is read correctly',
        rows[1] && rows[1].text === `EXTRAS IMPORT ${stamp} B, with a comma and "quotes"`, JSON.stringify(rows[1]));
    check('difficulty, marks, options and the correct answer are read correctly',
        rows[1] && rows[1].difficulty === 'hard' && rows[1].marks === 2 && rows[1].opts === 3 && rows[1].right_answer === 'Three');
    check('blank difficulty becomes medium and blank marks become 1',
        rows[2] && rows[2].difficulty === 'medium' && rows[2].marks === 1 && rows[2].right_answer === 'Beta');

    const again = await api('POST', path, ctx.teacher, { csv: good });
    check('importing the same file again skips every duplicate',
        again.status === 201 && again.data.imported === 0 && again.data.skipped_duplicates === 3, show(again));

    // Bad files: nothing must be imported
    const noColumn = await api('POST', path, ctx.teacher, { csv: 'text,option1\r\nWhat,Yes' });
    check('a missing column gives 400', noColumn.status === 400 && JSON.stringify(noColumn.data).includes('Missing column'), show(noColumn));
    const badCorrect = await api('POST', path, ctx.teacher, { csv: `${HEADER}\r\nEXTRAS IMPORT ${stamp} X,easy,1,A,B,,,,,5` });
    check('a wrong "correct" number gives 400 with the row number',
        badCorrect.status === 400 && badCorrect.data.errors[0].row === 2, show(badCorrect));
    const oneOption = await api('POST', path, ctx.teacher, { csv: `${HEADER}\r\nEXTRAS IMPORT ${stamp} X,easy,1,A,,,,,,1` });
    check('a question with one option gives 400', oneOption.status === 400, show(oneOption));
    const badLevel = await api('POST', path, ctx.teacher, { csv: `${HEADER}\r\nEXTRAS IMPORT ${stamp} X,extreme,1,A,B,,,,,1` });
    check('an unknown difficulty gives 400', badLevel.status === 400, show(badLevel));
    const unclosed = await api('POST', path, ctx.teacher, { csv: `${HEADER}\r\n"EXTRAS IMPORT ${stamp} X,easy,1,A,B,,,,,1` });
    check('an unclosed quote gives 400', unclosed.status === 400, show(unclosed));
    const notText = await api('POST', path, ctx.teacher, { csv: 123 });
    check('a csv field that is not text gives 400', notText.status === 400, show(notText));

    const mixed = `${HEADER}\r\nEXTRAS IMPORT ${stamp} MIXED,easy,1,A,B,,,,,1\r\nEXTRAS IMPORT ${stamp} BAD,easy,1,A,B,,,,,9`;
    const mixedResult = await api('POST', path, ctx.teacher, { csv: mixed });
    const leaked = await h.pool.query('SELECT COUNT(*)::int AS n FROM questions WHERE text = $1', [`EXTRAS IMPORT ${stamp} MIXED`]);
    check('one bad row means nothing at all is imported', mixedResult.status === 400 && leaked.rows[0].n === 0, show(mixedResult));

    const byOther = await api('POST', path, ctx.t2, { csv: good });
    check("another teacher cannot import into my course (403)", byOther.status === 403, show(byOther));
    const byStudent = await api('POST', path, ctx.s1, { csv: good });
    check('a student cannot import (403)', byStudent.status === 403, show(byStudent));

    const ex = await raw('GET', `/courses/${ctx.courseId}/questions/export`, ctx.teacher);
    check('the export downloads as CSV and contains the imported questions',
        ex.status === 200 && ex.type.includes('text/csv') && ex.text.includes(`EXTRAS IMPORT ${stamp} A`), String(ex.status));
    const round = await api('POST', path, ctx.teacher, { csv: ex.text, dry_run: true });
    check('re-importing an export is valid and everything counts as a duplicate',
        round.status === 200 && round.data.would_import === 0 && round.data.skipped_duplicates > 0, show(round));
    const exOther = await raw('GET', `/courses/${ctx.courseId}/questions/export`, ctx.t2);
    check("another teacher cannot export my course's questions (403)", exOther.status === 403, String(exOther.status));
}

async function testAdminUsers(ctx) {
    section('2. Admin: edit, deactivate and reactivate users');
    const patch = (id, body, token = ctx.admin) => api('PATCH', `/admin/users/${id}`, token, body);

    const mk = await api('POST', '/admin/users', ctx.admin, {
        name: 'Extras Student', email: 'extras-s@test.com', password: 'abc12345', role: 'student',
    });
    check('create a temporary student', mk.status === 201, show(mk));
    const id = mk.data.user.id;

    const list = await api('GET', '/admin/users?role=student', ctx.admin);
    check('the user list includes is_active',
        list.status === 200 && list.data.users.length > 0 && list.data.users.every((u) => typeof u.is_active === 'boolean'));

    const rename = await patch(id, { name: 'Extras Renamed' });
    check('rename a user', rename.status === 200 && rename.data.user.name === 'Extras Renamed', show(rename));
    check('a duplicate email gives 409', (await patch(id, { email: 'admin@digiexam.com' })).status === 409);
    check('an unknown role gives 400', (await patch(id, { role: 'boss' })).status === 400);
    check('an empty change gives 400', (await patch(id, {})).status === 400);
    check('an unknown user gives 404', (await patch(999999, { name: 'X' })).status === 404);
    check('a teacher cannot edit users (403)', (await patch(id, { name: 'X' }, ctx.teacher)).status === 403);

    const myId = (await api('GET', '/auth/me', ctx.admin)).data.user.id;
    check('an admin cannot deactivate their own account (409)', (await patch(myId, { is_active: false })).status === 409);
    check('an admin cannot change their own role (409)', (await patch(myId, { role: 'teacher' })).status === 409);

    const s1Id = (await api('GET', '/auth/me', ctx.s1)).data.user.id;
    check('a user with data cannot change role (409)', (await patch(s1Id, { role: 'teacher' })).status === 409);

    const token = await h.login('extras-s@test.com', 'abc12345');
    check('a student can use student routes', (await api('GET', '/student/exams', token)).status === 200);

    const off = await patch(id, { is_active: false });
    check('deactivate a user', off.status === 200 && off.data.user.is_active === false, show(off));
    const loginOff = await api('POST', '/auth/login', null, { email: 'extras-s@test.com', password: 'abc12345' });
    check('a deactivated user cannot log in (403)', loginOff.status === 403, show(loginOff));
    const oldToken = await api('GET', '/auth/me', token);
    check('their existing token stops working at once (401)', oldToken.status === 401, show(oldToken));

    const on = await patch(id, { is_active: true });
    check('reactivate the user', on.status === 200 && on.data.user.is_active === true);
    check('they can log in again', (await api('POST', '/auth/login', null, { email: 'extras-s@test.com', password: 'abc12345' })).status === 200);

    check('a too-short password gives 400', (await patch(id, { password: 'abc' })).status === 400);
    check('the admin can reset a password', (await patch(id, { password: 'newpass123' })).status === 200);
    check('the old password no longer works (401)',
        (await api('POST', '/auth/login', null, { email: 'extras-s@test.com', password: 'abc12345' })).status === 401);
    check('the new password works',
        (await api('POST', '/auth/login', null, { email: 'extras-s@test.com', password: 'newpass123' })).status === 200);

    const token2 = await h.login('extras-s@test.com', 'newpass123');
    const toTeacher = await patch(id, { role: 'teacher' });
    check('a user without data can change role', toTeacher.status === 200 && toTeacher.data.user.role === 'teacher', show(toTeacher));
    check('the new role applies at once to the existing token (student route now 403)',
        (await api('GET', '/student/exams', token2)).status === 403);
}

async function testAdminCourses(ctx) {
    section('3. Admin: edit and delete courses');
    const teacherId = (await api('GET', '/auth/me', ctx.teacher)).data.user.id;
    const studentId = (await api('GET', '/auth/me', ctx.s1)).data.user.id;

    const mk = await api('POST', '/courses', ctx.admin, { code: 'EXTRAS1', title: 'Temporary', teacher_id: teacherId });
    check('create a temporary course', mk.status === 201, show(mk));
    const cid = mk.data.course.id;
    const patch = (body, token = ctx.admin, id = cid) => api('PATCH', `/courses/${id}`, token, body);

    const t = await patch({ title: 'Renamed course' });
    check('rename a course', t.status === 200 && t.data.course.title === 'Renamed course', show(t));
    check('a duplicate code gives 409', (await patch({ code: 'CSC336' })).status === 409);
    check('a student as teacher_id gives 400', (await patch({ teacher_id: studentId })).status === 400);
    check('an empty change gives 400', (await patch({})).status === 400);
    check('an unknown course gives 404', (await patch({ title: 'X' }, ctx.admin, 999999)).status === 404);
    check('a teacher cannot edit courses (403)', (await patch({ title: 'X' }, ctx.teacher)).status === 403);
    check('a student cannot delete courses (403)', (await api('DELETE', `/courses/${cid}`, ctx.s1)).status === 403);

    const csv = `${HEADER}\r\nEXTRAS IMPORT ${stamp} T1,easy,1,A,B,,,,,1\r\nEXTRAS IMPORT ${stamp} T2,easy,1,A,B,,,,,2`;
    const imp = await api('POST', `/courses/${cid}/questions/import`, ctx.teacher, { csv });
    check('import questions into the temporary course', imp.status === 201 && imp.data.imported === 2, show(imp));
    const exam = await api('POST', `/courses/${cid}/exams`, ctx.teacher, h.examBody({ num_questions: 1 }));
    check('create an exam in it', exam.status === 201, show(exam));

    const blocked = await api('DELETE', `/courses/${cid}`, ctx.admin);
    check('a course with exams cannot be deleted (409)', blocked.status === 409, show(blocked));
    const delExam = await api('DELETE', `/exams/${exam.data.exam.id}`, ctx.teacher);
    check('delete the exam', delExam.status === 200, show(delExam));
    const del = await api('DELETE', `/courses/${cid}`, ctx.admin);
    check('now the course can be deleted', del.status === 200, show(del));
    const courses = await api('GET', '/courses', ctx.admin);
    check('it is gone from the course list', !courses.data.courses.some((c) => c.id === cid));
    check('deleting it again gives 404', (await api('DELETE', `/courses/${cid}`, ctx.admin)).status === 404);
}

async function testChangePassword(ctx) {
    section('4. Change password');
    await api('POST', '/admin/users', ctx.admin, {
        name: 'Extras Password', email: 'extras-p@test.com', password: 'abc12345', role: 'student',
    });
    const token = await h.login('extras-p@test.com', 'abc12345');
    const change = (body, tok = token) => api('POST', '/auth/change-password', tok, body);

    const wrong = await change({ current_password: 'wrong-password', new_password: 'brandnew1' });
    check('a wrong current password gives 403 (not 401)', wrong.status === 403, show(wrong));
    check('a too-short new password gives 400', (await change({ current_password: 'abc12345', new_password: 'abc' })).status === 400);
    check('the same password gives 400', (await change({ current_password: 'abc12345', new_password: 'abc12345' })).status === 400);
    check('missing fields give 400', (await change({})).status === 400);
    check('no token gives 401', (await change({ current_password: 'a', new_password: 'b' }, null)).status === 401);

    const ok = await change({ current_password: 'abc12345', new_password: 'brandnew1' });
    check('the password changes', ok.status === 200, show(ok));
    check('the old password no longer works (401)',
        (await api('POST', '/auth/login', null, { email: 'extras-p@test.com', password: 'abc12345' })).status === 401);
    check('the new password works',
        (await api('POST', '/auth/login', null, { email: 'extras-p@test.com', password: 'brandnew1' })).status === 200);
}

async function main() {
    console.log('DigiExam extras tests, part B (import, admin management, password)');
    const ctx = await h.setup();
    await h.runGroups(ctx, [testImport, testAdminUsers, testAdminCourses, testChangePassword]);
    await h.finish();
}

main().catch(async (err) => {
    console.error('Test run crashed:', err.message);
    await h.pool.end().catch(() => { });
    process.exit(1);
});