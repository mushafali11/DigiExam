// OpenAPI paths, part B: teacher reports and student endpoints.
const {
    ref, str, int, num, bool, date, arr, obj, json, ROLE, LEVEL, REASON, message,
    idParam, queryParam, PAGING, SEARCH, add, paths,
} = require('./helpers');

// ---------------------------------------------------------------- Teacher reports
const resultRow = obj({
    student_id: int(), name: str(), email: str(),
    attempt_id: int({ nullable: true }),
    status: str({ enum: ['submitted', 'in_progress', 'not_attempted'] }),
    submit_reason: REASON, submitted_at: date({ nullable: true }),
    score: num({ nullable: true }), total_marks: num({ nullable: true }), percentage: num({ nullable: true }),
});

add('get', '/exams/{id}/results', {
    tag: 'Teacher reports', summary: 'Results table (one row per enrolled student)', who: 'teacher of its course',
    description: 'Without `page` or `limit` every student is returned; with them the response also has `pagination`.',
    params: [idParam('id', 'Exam id'),
    queryParam('status', str({ enum: ['submitted', 'in_progress', 'not_attempted'] }), 'Only this status'),
    SEARCH('student name and email'), ...PAGING],
    ok: obj({
        exam: obj({ id: int(), title: str(), release_results: bool() }),
        results: arr(resultRow), pagination: ref('Pagination'),
    }),
    errors: [400, 403, 404],
});

add('get', '/exams/{id}/results/export', {
    tag: 'Teacher reports', summary: 'Download the results as CSV', who: 'teacher of its course',
    description: 'Needs the Authorization header, so a front-end must fetch it and save the response as a file.',
    params: [idParam('id', 'Exam id')], csv: true, errors: [403, 404],
});

add('get', '/exams/{id}/analytics', {
    tag: 'Teacher reports', summary: 'Summary, score distribution and per-question statistics', who: 'teacher of its course',
    description: 'Only submitted attempts are counted. Questions are sorted hardest first.',
    params: [idParam('id', 'Exam id')],
    ok: obj({
        exam: obj({ id: int(), title: str() }),
        summary: obj({
            enrolled_students: int(), submitted: int(), in_progress: int(), not_attempted: int(),
            average_score: num({ nullable: true }), highest_score: num({ nullable: true }),
            lowest_score: num({ nullable: true }), average_percentage: num({ nullable: true }),
        }),
        distribution: arr(obj({ range: str(), students: int() })),
        questions: arr(obj({
            question_id: int(), text: str(), difficulty: LEVEL, marks: num(),
            times_shown: int(), times_answered: int(), times_correct: int(), percent_correct: num(),
        })),
    }),
    errors: [403, 404],
});

add('get', '/exams/{id}/activity', {
    tag: 'Teacher reports', summary: 'Activity report: one row per started attempt', who: 'teacher of its course',
    description: '`switch_count` counts ALL tab switches ever logged (evidence). `excused_switches` are the ones forgiven by a reopen.',
    params: [idParam('id', 'Exam id')],
    ok: obj({
        exam: obj({ id: int(), title: str(), switch_limit: int() }),
        attempts: arr(obj({
            attempt_id: int(), student_id: int(), name: str(), email: str(),
            status: str(), submit_reason: REASON, started_at: date(), submitted_at: date({ nullable: true }),
            extra_minutes: int(), switch_count: int(), excused_switches: int(),
        })),
    }),
    errors: [403, 404],
});

add('get', '/exams/{id}/attempts/{attemptId}/events', {
    tag: 'Teacher reports', summary: 'Timeline of one attempt', who: 'teacher of its course',
    description: 'Routine `save` events are hidden unless `all=true`.',
    params: [idParam('id', 'Exam id'), idParam('attemptId', 'Attempt id'),
    queryParam('all', bool(), 'true to include save events')],
    ok: obj({
        attempt: obj({
            id: int(), student_name: str(), status: str(), submit_reason: REASON,
            started_at: date(), submitted_at: date({ nullable: true }),
        }),
        events: arr(obj({
            type: str({ enum: ['start', 'save', 'tab_switch', 'submit', 'auto_submit', 'extend', 'reopen'] }),
            created_at: date(), seconds_from_start: int(), detail: str({ nullable: true }), excused: bool(),
        })),
    }),
    errors: [403, 404],
});

add('get', '/exams/{id}/attempts/{attemptId}/review', {
    tag: 'Teacher reports', summary: "One student's answers against the correct ones", who: 'teacher of its course',
    description: 'Works at any time; no release is needed.',
    params: [idParam('id', 'Exam id'), idParam('attemptId', 'Attempt id')],
    ok: obj({
        attempt: obj({
            id: int(), student_name: str(), student_email: str(), exam_title: str(), status: str(),
            submit_reason: REASON, started_at: date(), submitted_at: date({ nullable: true }), extra_minutes: int(),
        }),
        score: num({ nullable: true }), total_marks: num(), percentage: num({ nullable: true }),
        questions: arr(ref('ReviewQuestion')),
    }),
    errors: [403, 404],
});

add('post', '/exams/{id}/attempts/{attemptId}/extend', {
    tag: 'Teacher reports', summary: 'Add time to an attempt, or reopen it', who: 'teacher of its course',
    description: 'In progress: adds minutes. Auto-submitted by time_up or switch_limit: reopens it (saved answers kept, score cleared, '
        + 'old tab switches excused). A manual submission cannot be reopened (409).',
    params: [idParam('id', 'Exam id'), idParam('attemptId', 'Attempt id')],
    body: obj({ extra_minutes: int({ minimum: 1, maximum: 120 }), reason: str({ maxLength: 200 }) }, ['extra_minutes']),
    ok: obj({
        action: str({ enum: ['extended', 'reopened'] }), attempt_id: int(), deadline_at: date(),
        remaining_seconds: int(), extra_minutes_total: int(), message: str(),
    }),
    errors: [400, 403, 404, 409],
});

// ---------------------------------------------------------------- Student
add('get', '/student/exams', {
    tag: 'Student', summary: 'Exams of my courses with my status', who: 'student',
    ok: obj({
        exams: arr(obj({
            id: int(), title: str(), duration_min: int(), start_at: date(), end_at: date(), num_questions: int(),
            release_results: bool(), course_code: str(), course_title: str(),
            phase: str({ enum: ['upcoming', 'open', 'closed'] }),
            attempt_id: int({ nullable: true }),
            attempt_status: str({ enum: ['in_progress', 'submitted'], nullable: true }),
        })),
    }),
    errors: [403],
});

add('post', '/student/exams/{id}/start', {
    tag: 'Student', summary: 'Start the exam, or resume the attempt', who: 'student enrolled in the course',
    description: 'Safe to call twice (or from two tabs): it returns the same attempt.',
    params: [idParam('id', 'Exam id')],
    code: 201, okDescription: 'New attempt created',
    ok: obj({ attempt_id: int(), resumed: bool(), started_at: date(), deadline_at: date() }),
    more: {
        200: { description: 'Existing attempt resumed', content: json(obj({ attempt_id: int(), resumed: bool() })) },
    },
    errors: [403, 404, 409],
});

add('get', '/student/results', {
    tag: 'Student', summary: 'My submitted attempts', who: 'student',
    description: 'Score, total and percentage are null until the teacher releases the results.',
    ok: obj({
        results: arr(obj({
            attempt_id: int(), exam_id: int(), exam_title: str(), course_code: str(), submitted_at: date(),
            results_released: bool(), score: num({ nullable: true }), total_marks: num({ nullable: true }),
            percentage: num({ nullable: true }),
        })),
    }),
    errors: [403],
});

add('get', '/attempts/{id}', {
    tag: 'Student', summary: 'My paper, saved answers and remaining time', who: 'student who owns the attempt',
    description: 'Questions and options are already in this student\'s shuffled order. There is no `is_correct` here. '
        + 'If the time ran out, the attempt is submitted first and only `attempt.status = submitted` is returned.',
    params: [idParam('id', 'Attempt id')],
    ok: obj({
        attempt: obj({
            id: int(), exam_id: int(), status: str({ enum: ['in_progress', 'submitted'] }),
            started_at: date(), deadline_at: date(), remaining_seconds: int(),
            switch_count: int(), switch_limit: int(),
        }),
        exam: obj({ title: str(), duration_min: int() }),
        questions: arr(obj({
            position: int(), question_id: int(), text: str(), marks: num(), flagged: bool(),
            options: arr(obj({ id: int(), text: str() })),
        })),
        answers: { type: 'object', additionalProperties: int(), description: 'question_id -> chosen option_id' },
        message: str({ description: 'Only when already submitted' }),
    }),
    errors: [403, 404],
});

add('put', '/attempts/{id}/answers', {
    tag: 'Student', summary: 'Autosave an answer (send on every click)', who: 'student who owns the attempt',
    params: [idParam('id', 'Attempt id')],
    body: obj({ question_id: int(), option_id: int() }, ['question_id', 'option_id']),
    ok: obj({ saved: bool(), remaining_seconds: int() }), errors: [400, 403, 404, 409],
});

add('delete', '/attempts/{id}/answers/{questionId}', {
    tag: 'Student', summary: 'Clear my answer to one question', who: 'student who owns the attempt',
    description: 'Safe to repeat (`had_answer` tells whether there was something to clear). A cleared question counts as unanswered, '
        + 'so negative marking does not penalise it.',
    params: [idParam('id', 'Attempt id'), idParam('questionId', 'Question id')],
    ok: obj({ cleared: bool(), had_answer: bool(), remaining_seconds: int() }), errors: [400, 403, 404, 409],
});

add('put', '/attempts/{id}/flags', {
    tag: 'Student', summary: 'Flag or unflag a question for review', who: 'student who owns the attempt',
    description: 'Flags are only a reminder for the student. They never affect grading.',
    params: [idParam('id', 'Attempt id')],
    body: obj({ question_id: int(), flagged: bool() }, ['question_id', 'flagged']),
    ok: obj({ flagged: bool(), question_id: int(), remaining_seconds: int() }), errors: [400, 403, 404, 409],
});

add('post', '/attempts/{id}/submit', {
    tag: 'Student', summary: 'Submit the attempt', who: 'student who owns the attempt',
    description: 'A 409 means it was already submitted: treat it like success.',
    params: [idParam('id', 'Attempt id')],
    ok: obj({ status: str(), reason: str({ enum: ['manual', 'time_up'] }), message: str() }),
    errors: [403, 404, 409],
});

add('post', '/attempts/{id}/events', {
    tag: 'Student', summary: 'Report a tab switch', who: 'student who owns the attempt',
    description: 'Only `tab_switch` is accepted. Repeats within 2 seconds are ignored (`logged: false`). '
        + 'When `switch_count` goes above `switch_limit` the attempt is auto-submitted (`auto_submitted: true`).',
    params: [idParam('id', 'Attempt id')],
    body: obj({ type: str({ enum: ['tab_switch'] }) }, ['type']),
    ok: obj({
        logged: bool(), switch_count: int(), switch_limit: int(), switches_left: int(),
        auto_submitted: bool(), reason: str(), message: str(),
    }),
    errors: [400, 403, 404, 409],
});

add('get', '/attempts/{id}/result', {
    tag: 'Student', summary: 'My score and answer review', who: 'student who owns the attempt',
    description: '403 until the teacher releases the results; 409 if the attempt is not submitted yet.',
    params: [idParam('id', 'Attempt id')],
    ok: obj({
        attempt: obj({ id: int(), exam_title: str(), submitted_at: date(), submit_reason: REASON }),
        score: num(), total_marks: num(), percentage: num(),
        questions: arr(ref('ReviewQuestion')),
    }),
    errors: [403, 404, 409],
});