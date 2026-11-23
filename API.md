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
| POST /courses/:courseId/exams | { title, duration_min, start_at, end_at, num_questions, switch_limit, negative_marking,       easy_count, medium_count, hard_count }
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

## Added on 23 November 2026 (contract version 1.1)

### Teacher: time extension and review

| Method and URL | Notes |
|---|---|
| POST /exams/:id/attempts/:attemptId/extend | Body `{ extra_minutes: 1 to 120, reason?: "..." }`. In progress: adds time (`action: "extended"`). Auto-submitted by time_up or switch_limit: reopens it (`action: "reopened"`): status back to in_progress, score cleared, saved answers kept, deadline = now + minutes, old tab switches excused. Manual submissions give 409. Returns `{ action, attempt_id, deadline_at, remaining_seconds, extra_minutes_total, message }`. The student then sees the exam as `in_progress` in GET /student/exams and uses "Resume exam" |
| GET /exams/:id/attempts/:attemptId/review | One student's paper with the correct answers: `{ attempt, score, total_marks, percentage, questions: [{ position, question_id, text, difficulty, marks, options: [{ id, text, is_correct }], selected_option_id, correct_option_id, answered, is_correct }] }`. Works at any time, no release needed |
| GET /exams/:id/results/export | CSV download of the results table |

Changed responses:
- GET /exams/:id/activity: each attempt also has `extra_minutes` and `excused_switches`. `switch_count` still counts ALL switches.
- GET /exams/:id/attempts/:attemptId/events: each event also has `detail` (text or null) and `excused` (boolean). New event types: `extend` and `reopen`.
- GET /attempts/:id and the switch warnings count only switches that are not excused.

### Teacher: question import and export

| Method and URL | Notes |
|---|---|
| GET /questions/import-template | CSV template download |
| POST /courses/:courseId/questions/import | Body `{ csv: "<file text>", dry_run?: true }`. Columns: `text, difficulty, marks, option1..option6, correct` (correct = position 1 to 6 of the right option; difficulty and marks are optional). Max 200 questions, whole file is rejected if any row is bad. Returns 201 `{ imported, skipped_duplicates }`, or with dry_run 200 `{ valid: true, would_import, skipped_duplicates }`. Errors: 400 `{ message, errors: [{ row, message }] }` (row 1 is the header) |
| GET /courses/:courseId/questions/export | CSV download in the same format |

### Admin

| Method and URL | Notes |
|---|---|
| PATCH /admin/users/:id | Any of `{ name, email, role, is_active, password }`. 409 for: own account deactivation or role change, removing the last active admin, role change when the user already has data, duplicate email |
| PATCH /courses/:id | Any of `{ code, title, teacher_id }`. 409 duplicate code |
| DELETE /courses/:id | 409 if the course has exams |

GET /admin/users and POST /admin/users now return `is_active`.

### Any logged-in user

| Method and URL | Notes |
|---|---|
| POST /auth/change-password | Body `{ current_password, new_password }`. A wrong current password gives **403**, not 401 (so the front-end does not log the user out) |

### Behaviour changes
- A deactivated user gets **403** at login, and any existing token returns **401** immediately.
- Role changes apply immediately to existing tokens (the front-end user object is stale until the next login).
- CSV downloads need the Authorization header, so the front-end must call them with fetch, read the response as a Blob, and trigger the download itself. A plain link will not work.