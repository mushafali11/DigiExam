# DigiExam Backend

REST API for DigiExam, a secure online quiz and exam platform (CSC336 Web Technologies semester project, Team 16).

Stack: Node.js, Express, PostgreSQL (`pg`), JWT, bcrypt.

## Setup

1. Install Node.js 18+ and PostgreSQL.
2. Create the database:
   ```
   psql -U postgres -c "CREATE DATABASE digiexam;"
   ```
3. Install packages:
   ```
   cd backend
   npm install
   ```
4. Copy `.env.example` to `.env` and fill in your PostgreSQL password and a JWT secret.
5. Create the tables (this wipes existing data):
   ```
   psql -U postgres -d digiexam -f db/schema.sql
   ```
6. Add sample data:
   ```
   node db/seed.js
   ```
7. Start the server:
   ```
   npm run dev
   ```
   Open http://localhost:5000/api/health. You should see `{"status":"ok", ...}`.

Run all commands from inside the `backend` folder.

## Demo accounts

| Role | Email | Password |
|---|---|---|
| Admin | admin@digiexam.com | admin123 |
| Teacher | teacher@digiexam.com | teacher123 |
| Student | student1@digiexam.com | student123 |
| Student | student2@digiexam.com | student123 |

The seed also creates course CSC336 (taught by the teacher, both students enrolled) with 10 sample questions.

## Folder structure

- `routes/` : URLs and which role may use them
- `controllers/` : the logic for each route
- `middleware/` : login check and role check
- `services/` : attempt locking, grading and the auto-submit sweeper
- `db/` : connection pool, `schema.sql`, `seed.js`
- `tests/` : the simulated class load test

## Documents

- `API.md` : every endpoint (for the frontend)
- `DESIGN.md` : design choices, alternatives rejected and trade-offs

## Load test


With the server running:

```
node tests/loadTest.js 30
```

It simulates 30 students starting the same exam at once, answering and submitting (each submits twice at the same instant). It prints response times and PASS/FAIL checks.

## Automated tests

```
npm test
```

Runs the edge-case test suite against the running server.

## Live demo checklist

1. Log in as the teacher, create an exam (short duration, switch limit 2).
2. Log in as two students in two browsers: each gets a different paper (question order and option order).
3. Refresh a student's page mid-attempt: same paper, saved answers still there, timer continues.
4. Switch tabs three times: warnings, then auto-submit on the third.
5. Leave another student's attempt until time runs out: it is auto-submitted.
6. Teacher: activity report and timeline (switch evidence), results table.
7. Teacher releases results: the student sees the score and review. Teacher opens the analytics page.

## Known limitations

- Tab-switch logs are evidence, not proof (a second device cannot be detected).
- The auto-submit sweeper runs inside the server process, so it assumes a single server.
- No login rate limiting yet.