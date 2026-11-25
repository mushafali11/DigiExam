# DigiExam Design Justification Note

## Server-side timer
- **Chosen:** when an attempt starts, the server stores `started_at` and `deadline_at`. Remaining time is calculated from the database clock on every request.
- **Rejected:** a client-side countdown (a student could change it or refresh to reset it).
- **Trade-off:** more server calls. The browser countdown is only a display that is re-synced from the server.
- **Fairness rule:** the deadline is the earlier of (start + duration) and the exam's end time, so nobody keeps working after the exam window closes.

## Randomization
- **Chosen:** at start, each student gets random questions and a shuffled option order, saved in `attempt_questions`. A refresh returns the same paper.
- **Rejected:** a shared pool shuffled in the browser (not stored, so a refresh would change the paper), and one fixed shuffle for the whole class (easy to copy).
- **Trade-off:** extra rows per attempt (one per question), in exchange for consistency and per-student papers.

## Autosave
- **Chosen:** each click is saved with one lightweight upsert (`INSERT ... ON CONFLICT DO UPDATE`), with a unique key on (attempt, question).
- **Rejected:** saving only at the end (loses everything on a power cut) and saving the whole paper on every click (heavy).
- **Verified by:** the simulated class load test.

## Duplicate and late submission
- **Chosen:** every change to an attempt first locks that attempt's row (`SELECT ... FOR UPDATE`) inside a transaction. Two requests for the same attempt are handled one after the other.
- **Result:** a double-clicked Submit gives one 200 and one 409, and a save arriving after the deadline is refused. The load test fires two simultaneous submits per student to prove this.

## Auto-submit
- **Chosen:** two mechanisms. First, any request touching an expired attempt submits it on the spot. Second, a background sweeper (every 30 seconds) submits expired attempts even if the student left.
- **Rejected:** relying on the browser to submit (it fails if the student closes the tab).
- **Trade-off:** the sweeper runs inside the server process, so it assumes one server.

## Activity monitoring
- **Chosen:** the browser reports tab switches; the server stores them with its own timestamps. `switch_limit` is the number of switches tolerated, and the next one auto-submits.
- **Double-fired events:** a switch within 2 seconds of the previous one is ignored, because browsers fire several events for one real switch.
- **Honest limits:** logs are evidence for the teacher, not proof. A harmless click on a notification can look like a switch, and a second device cannot be detected. Students can only report `tab_switch`, so they cannot forge `start`, `save` or `submit` events.

## Protecting past results
- Settings of an exam are locked once any student has started it, and it cannot be deleted.
- A question that appears in any attempt cannot be edited or deleted. Otherwise saved answers would point to changed options and old results would stop making sense.

## Grading
- The server grades at submission. A wrong answer costs 25% of that question's marks when negative marking is on (one constant in `services/attemptService.js`), unanswered questions cost nothing, and the total never goes below 0.
- Correct answers are never sent to the browser during an attempt. Students see them only after the teacher releases results.

## Rate limiting, CORS and headers
- **Chosen:** failed login and register attempts are limited to 10 per 15 minutes for each email and device (429 after that). Successful logins are never counted. CORS only allows the frontend's origin. Helmet adds safe HTTP headers.
- **Rejected:** a general requests-per-minute limit per IP. A whole class in a computer lab shares one IP address, so it would block students in the middle of an exam.
- **Trade-off:** the limit counter lives in server memory, so it resets when the server restarts and assumes a single server.

## Security
- Passwords are hashed with bcrypt. Login returns the same message for a wrong email and a wrong password.
- JWT tokens last 8 hours. Every route checks the token, then the role, then ownership (for example a teacher can only touch their own courses).
- Public registration only creates students. Teachers and admins are created by an admin.
- All SQL is parameterized.
## Backups, logging and continuous integration
- **Backups:** `pg_dump` and `psql` are run without a shell, so nothing can be injected. A restore saves a safety copy first and runs as a single transaction (all or nothing). Backup files are ignored by Git because they contain password hashes.
- **Logging:** one line per request with method, path, status, duration, user id and role. Passwords, tokens, bodies and query strings are never logged. Only important lines go to the console, so the log stays readable. An optional file holds the full audit trail.
- **Continuous integration:** GitHub Actions starts a PostgreSQL database, creates the tables, seeds the data, starts the server and runs every suite plus the load test on each push. A broken change is caught before it reaches the demo.

## Reopening and extending attempts
- **Chosen:** a teacher can add minutes to a running attempt, or reopen one that was auto-submitted by time-up or the switch limit. Saved answers are kept and the score is cleared until the student submits again. Every change is written to the event log with the reason. This resolves the "strict timing vs fairness" conflict (CP2) without weakening the server timer.
- **Switches after a reopen:** old tab-switch events are marked `excused`, not deleted. The student gets a fresh counter, and the teacher still sees every switch as evidence.
- **Not allowed:** reopening an attempt the student submitted themselves (that was their decision).

## Accounts: deactivate instead of delete
- **Chosen:** users are deactivated, not deleted, so past results and the audit trail stay intact. The authenticate middleware checks the database on every request, so deactivation and role changes apply immediately instead of waiting for a token to expire.
- **Trade-off:** one extra primary-key lookup per request, in exchange for immediate revocation. The load test shows it is not a problem at class scale.
- **Protections:** an admin cannot deactivate or demote their own account, and the last active admin cannot be removed. A role cannot change once the user has data.

## CSV import and export
- **Import:** all-or-nothing in one transaction, with a dry-run mode and row-numbered errors. Questions whose text already exists in the course are skipped, so importing twice is harmless.
- **Export:** values starting with = + - @ get a leading apostrophe, so a student named "=HYPERLINK(...)" cannot run a formula when a teacher opens the file in Excel (CSV injection). A BOM is added so Excel reads non-English names correctly.