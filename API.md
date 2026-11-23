# DigiExam API

Base URL: `http://localhost:5000/api`

## Rules for every request

- Send JSON, with header `Content-Type: application/json`.
- After login, send `Authorization: Bearer <token>` on every request. Tokens last 8 hours.
- Errors always look like `{ "message": "..." }`.
- Status codes: 400 invalid input, 401 not logged in or token expired, 403 wrong role or not your data, 404 not found, 409 conflict (duplicate, locked, or already submitted).
- Dates are ISO strings. Send times with a timezone, for example `2026-11-25T10:00:00+05:00`.

## Auth

| Method and URL | Who | Body or notes |
|---|---|---|
| POST /auth/register | anyone | `{ name, email, password }`. Creates a **student**. Returns `{ token, user }` |
| POST /auth/login | anyone | `{ email, password }`. Returns `{ token, user }` |
| GET /auth/me | any logged-in user | Returns `{ user }` |

## Admin

| Method and URL | Who | Body or notes |
|---|---|---|
| POST /admin/users | admin | `{ name, email, password, role }`, role is teacher, student or admin |
| GET /admin/users?role=teacher | admin | Optional role filter. Returns `{ users }` |
| POST /courses | admin | `{ code, title, teacher_id }` |
| POST /courses/:id/enrollments | admin | `{ student_id }` |
| DELETE /courses/:id/enrollments/:studentId | admin | Removes the student from the course |

## Courses

| Method and URL | Who | Notes |
|---|---|---|
| GET /courses | any | Admin sees all, teacher sees own, student sees enrolled. Returns `{ courses }` |
| GET /courses/:id/students | admin or the course's teacher | Returns `{ students }` |

## Question bank (teacher, own courses only)

| Method and URL | Notes |
|---|---|
| POST /courses/:courseId/questions | `{ text, difficulty, marks, options: [{ text, is_correct }] }`. 2 to 6 options, exactly one correct. difficulty is easy, medium or hard |
| GET /courses/:courseId/questions?difficulty=easy | Returns `{ questions }` with options and `is_correct` |
| GET /questions/:id | One question |
| PUT /questions/:id | Same body as create. Replaces all options |
| DELETE /questions/:id | |

A question that was already used in a student's attempt cannot be edited or deleted (409).

## Exams (teacher, own courses only)

| Method and URL | Notes |
|---|---|
| POST /courses/:courseId/exams | `{ title, duration_min, start_at, end_at, num_questions, switch_limit, negative_marking }` |
| GET /courses/:courseId/exams | Returns `{ exams }` |
| GET /exams/:id | One exam |
| PUT /exams/:id | Same body as create. 409 once any student has started |
| PATCH /exams/:id/release | `{ release_results: true or false }`. Always allowed |
| DELETE /exams/:id | 409 once any student has started |
| GET /exams/:id/activity | Per attempt: student, status, submit_reason, switch_count |
| GET /exams/:id/attempts/:attemptId/events | Timeline of one attempt. Add `?all=true` to include save events |
| GET /exams/:id/results | One row per enrolled student: status, score, total_marks, percentage |
| GET /exams/:id/analytics | `{ summary, distribution, questions }`. Questions are sorted hardest first |

`switch_limit` is how many tab switches are tolerated. With a limit of 2, the 3rd switch auto-submits.

## Student

| Method and URL | Notes |
|---|---|
| GET /student/exams | Exams of my courses with `phase` (upcoming, open, closed), `attempt_id`, `attempt_status` |
| POST /student/exams/:id/start | 201 with `{ attempt_id, deadline_at }` for a new attempt. 200 with `resumed: true` if one exists. 409 if already submitted |
| GET /attempts/:id | In progress: `{ attempt, exam, questions, answers }`. If time is up it is auto-submitted and returns `attempt.status = "submitted"` |
| PUT /attempts/:id/answers | `{ question_id, option_id }`. Autosave. Returns `{ saved, remaining_seconds }`. 409 means submitted |
| POST /attempts/:id/submit | Returns `{ status, reason }`. 409 if already submitted |
| POST /attempts/:id/events | `{ type: "tab_switch" }`. Returns `{ switch_count, switch_limit, switches_left, auto_submitted }` |
| GET /student/results | My submitted attempts. Scores are null until the teacher releases results |
| GET /attempts/:id/result | Score and per-question review. 403 until released, 409 if not submitted |

### Frontend notes

- **Timer:** `remaining_seconds` comes from the server. Run a local countdown for display, and re-sync it on every save response and page load. Never trust the local clock.
- **Autosave:** call PUT /attempts/:id/answers on every option click.
- **Tab switches:** listen for the `visibilitychange` event. When `document.hidden` is true, post a `tab_switch` event and show the warning. If `auto_submitted` is true, go to the "submitted" screen.
- **Refresh:** GET /attempts/:id restores the same paper, saved answers, remaining time and switch count.
- **The paper never contains `is_correct`.** Correct answers only appear in the result review after release.
- **Any 409 on save, submit or events** means the attempt is finished. Go to the submitted screen.