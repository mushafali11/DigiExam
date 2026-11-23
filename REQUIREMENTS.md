# DigiExam Requirements Traceability

Each requirement from the proposal, where it is implemented, how it was verified, and its status.

Status: **Done** = built and tested. **Frontend** = handled by the React app. **Evidence pending** = built, test output still to be saved.

## Functional requirements

| ID | Requirement | Implemented in | Verified by | Status |
|---|---|---|---|---|
| FR1 | Register and log in with role-based access | `POST /auth/register`, `POST /auth/login`, `GET /auth/me`; `middleware/auth.js` (`authenticate`, `requireRole`) | Login, `/me`, no token gives 401, wrong role gives 403, register gives 201 then 409 | Done. Registration creates students only; teachers and admins are created by the admin (`POST /admin/users`) |
| FR2 | Admin creates courses and enrols students; teachers manage questions of their own courses | `POST /courses`, `POST /courses/:id/enrollments` (admin); ownership check in question routes | Course creation, enrolment, duplicate enrolment gives 409, teacher creating a course gives 403, other teacher gives 403 | Done |
| FR3 | Teachers add, edit, delete MCQs (options, correct answer, marks, difficulty) | `POST/GET /courses/:courseId/questions`, `GET/PUT/DELETE /questions/:id` | Create, list, edit, delete; two correct options gives 400; student and other teacher get 403 | Done. Questions already used in an attempt are locked (409) |
| FR4 | Teachers create exams (course, duration, window, number of questions, marks, negative marking) | `POST/GET /courses/:courseId/exams`, `GET/PUT/DELETE /exams/:id`, `PATCH /exams/:id/release` | Create, list, update, release toggle, delete; too many questions, end before start and window shorter than duration all give 400 | Done. Total marks come from the chosen questions; negative marking is on or off with a fixed 25% penalty |
| FR5 | Unique randomized paper (question order and option order) per student | `POST /student/exams/:id/start`; tables `attempt_questions`, `option_order` | Two students got different papers; refresh returned the same paper | Done |
| FR6 | Server tracks start time and remaining time; timer survives refresh | `attempts.deadline_at`; `remaining_seconds` in `GET /attempts/:id` | Remaining time decreased across refreshes; 1-minute exam expired on the server | Done |
| FR7 | Autosave each answer; resume an unfinished attempt | `PUT /attempts/:id/answers` (upsert); start returns `resumed: true` | Saved and changed an answer; resume returned the same attempt id | Done |
| FR8 | Log tab and window switches with server timestamps; teacher sees counts and timeline | `POST /attempts/:id/events`; `GET /exams/:id/activity`; `GET /exams/:id/attempts/:attemptId/events` | Switch test: counts, duplicate ignored, teacher report and timeline | Done. The browser must call the endpoint on `visibilitychange` |
| FR9 | Auto-submit at time end or switch limit; block duplicate submission | `services/attemptService.js` (lazy check plus 30-second sweeper); row locking in `lockAttempt` | Timer test gave `time_up`; switch test gave `switch_limit`; second submit gave 409 | Done. Double submit under load: evidence pending (load test) |
| FR10 | Auto-grade; teacher results and question analytics; students see released results | `gradeAndSubmit`; `GET /exams/:id/results`, `/analytics`; `GET /student/results`, `/attempts/:id/result` | Score matched the review; 403 before release; analytics sorted hardest first | Done |

## Non-functional requirements

| ID | Requirement | Implemented in | Verified by | Status |
|---|---|---|---|---|
| NFR1 | Responsive UI (phone and desktop) | Not a backend concern; the API is plain JSON | n/a | Frontend |
| NFR2 | bcrypt, JWT, protected routes, role checks on every API | `bcrypt` (10 rounds), JWT (8 hours), `authenticate` and `requireRole` on every route except health, login and register; ownership checks | Role tests (401, 403, 404 for other students' attempts) | Done. Rate limiting, Helmet and a locked-down CORS list are planned |
| NFR3 | Client and server input validation with graceful errors | Validation in every controller; JSON error handler in `index.js` | Bad JSON gives 400, unknown URL gives 404, wrong data types give 400 | Done (server). Client-side validation is the frontend's part |
| NFR4 | Correct answers never sent during an attempt | `getAttempt` never selects `is_correct`; the review route only works after submission and release | Paper inspected (no `is_correct`); result gave 403 before release | Done |
| NFR5 | No answer loss on refresh or short network failure; safe concurrent submissions | Save on every click; resume; transactions with `SELECT ... FOR UPDATE` | Refresh test; submit-twice test | Done on the server. The frontend must retry failed saves |
| NFR6 | Audit trail of start, save, switch, submit with server timestamps | `attempt_events` (`created_at DEFAULT NOW()`) | Timeline shows start, tab_switch, auto_submit; `?all=true` adds saves | Done |
| NFR7 | Reasonable performance when a whole class starts together | Indexes on attempts, events, questions, options; `tests/loadTest.js` | Run `node tests/loadTest.js 30` and paste the output below | Evidence pending |

Load test output:

```
(paste the result of node tests/loadTest.js 30 here)
```

## Proposal items outside FR1 to FR10 (honest status)

| Item | Status |
|---|---|
| M4 "question selection rules" (for example 2 easy, 2 medium, 1 hard) | Done. Optional `easy_count`, `medium_count`, `hard_count` on the exam; each student gets that exact mix in random order |
| Admin "configure system rules"; edit or deactivate users and courses | Not built yet. The admin can create and list, not edit |
| Examination office wants records of irregularities | The activity report and timeline exist. CSV export is not built yet |
| CP4 edge cases (refresh, lost connection, duplicate or late submit, two tabs, clock differences, double-fired events) | Handled on the server. Two-tab and late-save cases still need an automated test |

## Tests still to add

- Editing or deleting a question that was used in an attempt gives 409.
- Editing or deleting an exam after a student started gives 409.
- Two simultaneous "start" requests from one student return the same attempt (two tabs).
- A save sent after the deadline gives 409.
- Wrong data types give 400, not 500.