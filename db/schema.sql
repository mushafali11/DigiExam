-- DigiExam schema
-- WARNING: the DROP lines wipe all data. Fine during development.

DROP TABLE IF EXISTS attempt_events CASCADE;
DROP TABLE IF EXISTS answers CASCADE;
DROP TABLE IF EXISTS attempt_questions CASCADE;
DROP TABLE IF EXISTS attempts CASCADE;
DROP TABLE IF EXISTS exams CASCADE;
DROP TABLE IF EXISTS options CASCADE;
DROP TABLE IF EXISTS questions CASCADE;
DROP TABLE IF EXISTS enrollments CASCADE;
DROP TABLE IF EXISTS courses CASCADE;
DROP TABLE IF EXISTS users CASCADE;

-- M1: users
CREATE TABLE users (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(100) NOT NULL,
  email         VARCHAR(150) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          VARCHAR(10) NOT NULL CHECK (role IN ('teacher', 'student', 'admin')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- M2: courses and enrollments
CREATE TABLE courses (
  id         SERIAL PRIMARY KEY,
  code       VARCHAR(20) NOT NULL UNIQUE,
  title      VARCHAR(150) NOT NULL,
  teacher_id INTEGER NOT NULL REFERENCES users(id)
);

CREATE TABLE enrollments (
  id         SERIAL PRIMARY KEY,
  course_id  INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE (course_id, student_id)
);

-- M3: question bank
CREATE TABLE questions (
  id         SERIAL PRIMARY KEY,
  course_id  INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  text       TEXT NOT NULL,
  difficulty VARCHAR(10) NOT NULL DEFAULT 'medium'
             CHECK (difficulty IN ('easy', 'medium', 'hard')),
  marks      NUMERIC(5,2) NOT NULL DEFAULT 1 CHECK (marks > 0),
  created_by INTEGER NOT NULL REFERENCES users(id)
);

CREATE TABLE options (
  id          SERIAL PRIMARY KEY,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  text        TEXT NOT NULL,
  is_correct  BOOLEAN NOT NULL DEFAULT FALSE
);

-- M4: exams
CREATE TABLE exams (
  id               SERIAL PRIMARY KEY,
  course_id        INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title            VARCHAR(150) NOT NULL,
  duration_min     INTEGER NOT NULL CHECK (duration_min > 0),
  start_at         TIMESTAMPTZ NOT NULL,
  end_at           TIMESTAMPTZ NOT NULL,
  num_questions    INTEGER NOT NULL CHECK (num_questions > 0),
  switch_limit     INTEGER NOT NULL DEFAULT 3 CHECK (switch_limit >= 0),
  negative_marking BOOLEAN NOT NULL DEFAULT FALSE,
  release_results  BOOLEAN NOT NULL DEFAULT FALSE,
  easy_count       INTEGER NOT NULL DEFAULT 0 CHECK (easy_count >= 0),
  medium_count     INTEGER NOT NULL DEFAULT 0 CHECK (medium_count >= 0),
  hard_count       INTEGER NOT NULL DEFAULT 0 CHECK (hard_count >= 0),
  created_by       INTEGER NOT NULL REFERENCES users(id),
  CHECK (end_at > start_at)
);

-- M5: attempts
CREATE TABLE attempts (
  id            SERIAL PRIMARY KEY,
  exam_id       INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  student_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deadline_at   TIMESTAMPTZ NOT NULL,
  submitted_at  TIMESTAMPTZ,
  status        VARCHAR(15) NOT NULL DEFAULT 'in_progress'
                CHECK (status IN ('in_progress', 'submitted')),
  submit_reason VARCHAR(15)
                CHECK (submit_reason IN ('manual', 'time_up', 'switch_limit')),
  score         NUMERIC(7,2),
  UNIQUE (exam_id, student_id)
);

-- each student's randomized paper
CREATE TABLE attempt_questions (
  id           SERIAL PRIMARY KEY,
  attempt_id   INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  question_id  INTEGER NOT NULL REFERENCES questions(id),
  position     INTEGER NOT NULL,
  option_order INTEGER[] NOT NULL,
  UNIQUE (attempt_id, question_id),
  UNIQUE (attempt_id, position)
);

-- autosaved answers (one per attempt and question)
CREATE TABLE answers (
  id          SERIAL PRIMARY KEY,
  attempt_id  INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions(id),
  option_id   INTEGER NOT NULL REFERENCES options(id),
  saved_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (attempt_id, question_id)
);

-- M6: activity log
CREATE TABLE attempt_events (
  id         SERIAL PRIMARY KEY,
  attempt_id INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  type       VARCHAR(20) NOT NULL
             CHECK (type IN ('start', 'save', 'tab_switch', 'submit', 'auto_submit')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- indexes for speed (from the proposal)
CREATE INDEX idx_attempts_exam_student ON attempts (exam_id, student_id);
CREATE INDEX idx_events_attempt ON attempt_events (attempt_id);
CREATE INDEX idx_questions_course ON questions (course_id);
CREATE INDEX idx_options_question ON options (question_id);