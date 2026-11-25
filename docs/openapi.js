// OpenAPI 3.0 description of the DigiExam API.
// Served as JSON at /api/docs.json and as an interactive page at /api/docs ("Try it out").
// The endpoints are described in pathsA.js and pathsB.js. When you add or change an endpoint, update them too.

const {
    ref, str, int, num, bool, date, arr, obj, json, ROLE, LEVEL, REASON, message,
    idParam, queryParam, PAGING, SEARCH, add, paths,
} = require('./helpers');
require('./pathsA');
require('./pathsB');

// ---------------------------------------------------------------- The document
const spec = {
    openapi: '3.0.3',
    info: {
        title: 'DigiExam API',
        version: '1.2.0',
        description:
            'Secure online quiz and exam platform (CSC336, Team 16).\n\n'
            + '**How to try it:** call `POST /auth/login` with a demo account, copy the `token`, click **Authorize** and paste it. '
            + 'Demo accounts: admin@digiexam.com / admin123, teacher@digiexam.com / teacher123, student1@digiexam.com / student123.\n\n'
            + 'Errors are always `{ "message": "..." }`. Dates are ISO strings in UTC.',
    },
    servers: [{ url: '/api' }],
    tags: [
        { name: 'System' }, { name: 'Auth' }, { name: 'Admin' }, { name: 'Courses' },
        { name: 'Question bank' }, { name: 'Exams' }, { name: 'Teacher reports' }, { name: 'Student' },
    ],
    paths,
    components: {
        securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
        responses: {
            BadRequest: { description: 'Invalid input (the message says which field)', content: json(ref('Error')) },
            Unauthorized: { description: 'Not logged in, token expired or account deactivated', content: json(ref('Error')) },
            Forbidden: { description: 'Wrong role, not your course or exam, or not allowed right now', content: json(ref('Error')) },
            NotFound: { description: 'Not found (or somebody else\'s attempt)', content: json(ref('Error')) },
            Conflict: { description: 'Conflict: duplicate, locked, or attempt already submitted', content: json(ref('Error')) },
            TooManyRequests: { description: 'Too many failed login attempts', content: json(ref('Error')) },
        },
        schemas: {
            Error: obj({ message: str() }, ['message']),
            Pagination: obj({ page: int(), limit: int(), total: int(), total_pages: int() }),
            User: obj({ id: int(), name: str(), email: str(), role: ROLE, is_active: bool() }),
            AuthResult: obj({ token: str(), user: obj({ id: int(), name: str(), email: str(), role: ROLE }) }),
            Course: obj({ id: int(), code: str(), title: str(), teacher_id: int(), teacher_name: str() }),
            Option: obj({ id: int(), text: str(), is_correct: bool() }),
            Question: obj({
                id: int(), course_id: int(), text: str(), difficulty: LEVEL, marks: num(), options: arr(ref('Option')),
            }),
            QuestionInput: obj({
                text: str({ maxLength: 1000 }),
                difficulty: { ...LEVEL, default: 'medium' },
                marks: num({ minimum: 0.01, maximum: 100, default: 1 }),
                options: {
                    type: 'array', minItems: 2, maxItems: 6,
                    items: obj({ text: str(), is_correct: bool() }, ['text']),
                    description: 'Exactly one option must have is_correct true',
                },
            }, ['text', 'options']),
            Exam: obj({
                id: int(), course_id: int(), title: str(), duration_min: int(),
                start_at: date(), end_at: date(), num_questions: int(), switch_limit: int(),
                negative_marking: bool(), release_results: bool(),
                easy_count: int(), medium_count: int(), hard_count: int(),
            }),
            ExamInput: obj({
                title: str({ maxLength: 150 }),
                duration_min: int({ minimum: 1, maximum: 300 }),
                start_at: date({ description: 'Send with a time zone, e.g. 2026-11-25T10:00:00+05:00' }),
                end_at: date({ description: 'Must be after start_at, in the future, and at least duration_min after start_at' }),
                num_questions: int({ minimum: 1, maximum: 200 }),
                switch_limit: int({ minimum: 0, maximum: 50, default: 3, description: 'Tab switches tolerated; the next one auto-submits' }),
                negative_marking: bool({ default: false, description: 'A wrong answer loses 25% of the question marks' }),
                easy_count: int({ minimum: 0, description: 'Optional difficulty mix. If any is above 0 the three must add up to num_questions' }),
                medium_count: int({ minimum: 0 }),
                hard_count: int({ minimum: 0 }),
            }, ['title', 'duration_min', 'start_at', 'end_at', 'num_questions']),
            ReviewQuestion: obj({
                position: int(), question_id: int(), text: str(), difficulty: LEVEL, marks: num(),
                options: arr(ref('Option')), selected_option_id: int({ nullable: true }),
                correct_option_id: int({ nullable: true }), answered: bool(), is_correct: bool(),
            }),
        },
    },
};

// Drop undefined values so the document is clean JSON
module.exports = JSON.parse(JSON.stringify(spec));