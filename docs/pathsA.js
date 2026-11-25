// OpenAPI paths, part A: system, auth, admin, courses, question bank, exams.
const {
    ref, str, int, num, bool, date, arr, obj, json, ROLE, LEVEL, REASON, message,
    idParam, queryParam, PAGING, SEARCH, add, paths,
} = require('./helpers');

// ---------------------------------------------------------------- System and auth
add('get', '/health', {
    tag: 'System', summary: 'Server and database health check', public: true,
    ok: obj({ status: str(), dbTime: date() }),
});

add('post', '/auth/register', {
    tag: 'Auth', summary: 'Register a new student', public: true,
    who: 'anyone. Always creates a student (teachers and admins are created by an admin)',
    body: obj({
        name: str({ maxLength: 100 }),
        email: str({ format: 'email', maxLength: 150 }),
        password: str({ minLength: 6, maxLength: 72 }),
    }, ['name', 'email', 'password']),
    code: 201, ok: ref('AuthResult'), errors: [400, 409, 429],
});

add('post', '/auth/login', {
    tag: 'Auth', summary: 'Log in and get a token', public: true,
    description: 'Use the returned token as `Authorization: Bearer <token>`. Tokens last 8 hours. '
        + '403 means the account was deactivated. 429 means too many failed attempts.',
    body: obj({ email: str({ format: 'email' }), password: str() }, ['email', 'password']),
    ok: ref('AuthResult'), errors: [400, 401, 403, 429],
});

add('get', '/auth/me', {
    tag: 'Auth', summary: 'The logged-in user', who: 'any logged-in user',
    ok: obj({ user: ref('User') }),
});

add('post', '/auth/change-password', {
    tag: 'Auth', summary: 'Change my own password', who: 'any logged-in user',
    description: 'A wrong current password returns **403** (not 401), so a front-end does not log the user out.',
    body: obj({
        current_password: str(),
        new_password: str({ minLength: 6, maxLength: 72 }),
    }, ['current_password', 'new_password']),
    ok: message, errors: [400, 403, 429],
});

// ---------------------------------------------------------------- Admin
add('post', '/admin/users', {
    tag: 'Admin', summary: 'Create a user', who: 'admin',
    body: obj({
        name: str({ maxLength: 100 }), email: str({ format: 'email' }),
        password: str({ minLength: 6, maxLength: 72 }), role: ROLE,
    }, ['name', 'email', 'password', 'role']),
    code: 201, ok: obj({ user: ref('User') }), errors: [400, 403, 409],
});

add('get', '/admin/users', {
    tag: 'Admin', summary: 'List users', who: 'admin',
    description: 'Without `page` or `limit` all matching users are returned. With them, the response also has `pagination`.',
    params: [queryParam('role', ROLE, 'Only users with this role'), SEARCH('name and email'), ...PAGING],
    ok: obj({ users: arr(ref('User')), pagination: ref('Pagination') }), errors: [400, 403],
});

add('patch', '/admin/users/{id}', {
    tag: 'Admin', summary: 'Edit, deactivate, reactivate a user or reset a password', who: 'admin',
    description: 'Send any of the fields. 409 when: you change or deactivate your own account, the last active admin '
        + 'would be removed, the role changes for a user who already has data, or the email is taken. '
        + 'Deactivation and role changes apply immediately, even to existing tokens.',
    params: [idParam('id', 'User id')],
    body: obj({
        name: str({ maxLength: 100 }), email: str({ format: 'email' }), role: ROLE,
        is_active: bool(), password: str({ minLength: 6, maxLength: 72 }),
    }),
    ok: obj({ user: ref('User') }), errors: [400, 403, 404, 409],
});

// ---------------------------------------------------------------- Courses
add('post', '/courses', {
    tag: 'Courses', summary: 'Create a course', who: 'admin',
    body: obj({ code: str({ maxLength: 20 }), title: str({ maxLength: 150 }), teacher_id: int() },
        ['code', 'title', 'teacher_id']),
    code: 201, ok: obj({ course: ref('Course') }), errors: [400, 403, 409],
});

add('get', '/courses', {
    tag: 'Courses', summary: 'List my courses', who: 'any logged-in user',
    description: 'Admin: all courses. Teacher: own courses. Student: enrolled courses.',
    ok: obj({ courses: arr(ref('Course')) }),
});

add('patch', '/courses/{id}', {
    tag: 'Courses', summary: 'Edit a course', who: 'admin',
    params: [idParam('id', 'Course id')],
    body: obj({ code: str({ maxLength: 20 }), title: str({ maxLength: 150 }), teacher_id: int() }),
    ok: obj({ course: ref('Course') }), errors: [400, 403, 404, 409],
});

add('delete', '/courses/{id}', {
    tag: 'Courses', summary: 'Delete a course', who: 'admin',
    description: 'Only while the course has no exams (409 otherwise). Its questions and enrolments are removed too.',
    params: [idParam('id', 'Course id')], ok: message, errors: [403, 404, 409],
});

add('post', '/courses/{id}/enrollments', {
    tag: 'Courses', summary: 'Enrol a student', who: 'admin',
    params: [idParam('id', 'Course id')],
    body: obj({ student_id: int() }, ['student_id']),
    code: 201,
    ok: obj({ enrollment: obj({ id: int(), course_id: int(), student_id: int() }) }),
    errors: [400, 403, 404, 409],
});

add('get', '/courses/{id}/students', {
    tag: 'Courses', summary: 'Students of a course', who: 'admin, or the teacher of that course',
    params: [idParam('id', 'Course id')],
    ok: obj({ students: arr(obj({ id: int(), name: str(), email: str() })) }), errors: [403, 404],
});

add('delete', '/courses/{id}/enrollments/{studentId}', {
    tag: 'Courses', summary: 'Remove a student from a course', who: 'admin',
    params: [idParam('id', 'Course id'), idParam('studentId', 'Student id')],
    ok: message, errors: [403, 404],
});

// ---------------------------------------------------------------- Question bank
add('post', '/courses/{courseId}/questions', {
    tag: 'Question bank', summary: 'Add a question', who: 'teacher of the course',
    params: [idParam('courseId', 'Course id')], body: ref('QuestionInput'),
    code: 201, ok: obj({ question: ref('Question') }), errors: [400, 403, 404],
});

add('get', '/courses/{courseId}/questions', {
    tag: 'Question bank', summary: 'List questions of a course', who: 'teacher of the course',
    description: '`counts` is how many questions of each difficulty the whole course has. '
        + 'Without `page` or `limit` all matching questions are returned; with them the response also has `pagination`.',
    params: [idParam('courseId', 'Course id'), queryParam('difficulty', LEVEL, 'Only this difficulty'),
    SEARCH('the question text'), ...PAGING],
    ok: obj({
        questions: arr(ref('Question')),
        counts: obj({ easy: int(), medium: int(), hard: int() }),
        pagination: ref('Pagination'),
    }),
    errors: [400, 403, 404],
});

add('post', '/courses/{courseId}/questions/import', {
    tag: 'Question bank', summary: 'Import questions from CSV text', who: 'teacher of the course',
    description: 'Columns: `text, difficulty, marks, option1..option6, correct` (correct = position 1 to 6 of the right option; '
        + 'difficulty and marks are optional). Up to 200 questions. The whole file is rejected if any row is bad '
        + '(400 with a list of `errors` with row numbers; row 1 is the header). Questions whose text already exists are skipped. '
        + 'Use `dry_run: true` to check a file without importing.',
    params: [idParam('courseId', 'Course id')],
    body: obj({ csv: str({ description: 'The CSV file content as text' }), dry_run: bool() }, ['csv']),
    code: 201,
    ok: obj({ imported: int(), skipped_duplicates: int() }),
    more: {
        200: {
            description: 'Dry run result',
            content: json(obj({ valid: bool(), would_import: int(), skipped_duplicates: int() })),
        },
    },
    errors: [400, 403, 404],
});

add('get', '/courses/{courseId}/questions/export', {
    tag: 'Question bank', summary: 'Download the questions as CSV', who: 'teacher of the course',
    params: [idParam('courseId', 'Course id')], csv: true, errors: [403, 404],
});

add('get', '/questions/import-template', {
    tag: 'Question bank', summary: 'Download the CSV import template', who: 'teacher', csv: true,
});

add('get', '/questions/{id}', {
    tag: 'Question bank', summary: 'One question', who: 'teacher of its course',
    params: [idParam('id', 'Question id')], ok: obj({ question: ref('Question') }), errors: [403, 404],
});

add('put', '/questions/{id}', {
    tag: 'Question bank', summary: 'Replace a question and all its options', who: 'teacher of its course',
    description: '409 when the question was already used in an exam attempt.',
    params: [idParam('id', 'Question id')], body: ref('QuestionInput'),
    ok: obj({ question: ref('Question') }), errors: [400, 403, 404, 409],
});

add('delete', '/questions/{id}', {
    tag: 'Question bank', summary: 'Delete a question', who: 'teacher of its course',
    description: '409 when the question was already used in an exam attempt.',
    params: [idParam('id', 'Question id')], ok: message, errors: [403, 404, 409],
});

// ---------------------------------------------------------------- Exams
add('post', '/courses/{courseId}/exams', {
    tag: 'Exams', summary: 'Create an exam', who: 'teacher of the course',
    params: [idParam('courseId', 'Course id')], body: ref('ExamInput'),
    code: 201, ok: obj({ exam: ref('Exam') }), errors: [400, 403, 404],
});

add('get', '/courses/{courseId}/exams', {
    tag: 'Exams', summary: 'List exams of a course', who: 'teacher of the course',
    params: [idParam('courseId', 'Course id')], ok: obj({ exams: arr(ref('Exam')) }), errors: [403, 404],
});

add('get', '/exams/{id}', {
    tag: 'Exams', summary: 'One exam', who: 'teacher of its course',
    params: [idParam('id', 'Exam id')], ok: obj({ exam: ref('Exam') }), errors: [403, 404],
});

add('put', '/exams/{id}', {
    tag: 'Exams', summary: 'Replace all settings of an exam', who: 'teacher of its course',
    description: '409 once any student has started the exam.',
    params: [idParam('id', 'Exam id')], body: ref('ExamInput'),
    ok: obj({ exam: ref('Exam') }), errors: [400, 403, 404, 409],
});

add('patch', '/exams/{id}/release', {
    tag: 'Exams', summary: 'Show or hide the results to students', who: 'teacher of its course',
    description: 'Always allowed, even after students started.',
    params: [idParam('id', 'Exam id')], body: obj({ release_results: bool() }, ['release_results']),
    ok: obj({ exam: ref('Exam') }), errors: [400, 403, 404],
});

add('delete', '/exams/{id}', {
    tag: 'Exams', summary: 'Delete an exam', who: 'teacher of its course',
    description: '409 once any student has started the exam.',
    params: [idParam('id', 'Exam id')], ok: message, errors: [403, 404, 409],
});