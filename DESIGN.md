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

## Security
- Passwords are hashed with bcrypt. Login returns the same message for a wrong email and a wrong password.
- JWT tokens last 8 hours. Every route checks the token, then the role, then ownership (for example a teacher can only touch their own courses).
- Public registration only creates students. Teachers and admins are created by an admin.
- All SQL is parameterized.