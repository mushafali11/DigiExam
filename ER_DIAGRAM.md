# DigiExam ER Diagram

```mermaid
erDiagram
  USERS ||--o{ COURSES : "teaches"
  USERS ||--o{ ENROLLMENTS : "enrolled as"
  COURSES ||--o{ ENROLLMENTS : "has"
  COURSES ||--o{ QUESTIONS : "contains"
  COURSES ||--o{ EXAMS : "has"
  QUESTIONS ||--|{ OPTIONS : "has"
  EXAMS ||--o{ ATTEMPTS : "has"
  USERS ||--o{ ATTEMPTS : "makes"
  ATTEMPTS ||--|{ ATTEMPT_QUESTIONS : "paper"
  QUESTIONS ||--o{ ATTEMPT_QUESTIONS : "used in"
  ATTEMPTS ||--o{ ANSWERS : "saves"
  QUESTIONS ||--o{ ANSWERS : "answered in"
  OPTIONS ||--o{ ANSWERS : "chosen in"
  ATTEMPTS ||--o{ ATTEMPT_EVENTS : "logs"

  USERS {
    int id PK
    string name
    string email UK
    string password_hash
    string role
    timestamptz created_at
  }
  COURSES {
    int id PK
    string code UK
    string title
    int teacher_id FK
  }
  ENROLLMENTS {
    int id PK
    int course_id FK
    int student_id FK
  }
  QUESTIONS {
    int id PK
    int course_id FK
    text text
    string difficulty
    numeric marks
    int created_by FK
  }
  OPTIONS {
    int id PK
    int question_id FK
    text text
    boolean is_correct
  }
  EXAMS {
    int id PK
    int course_id FK
    string title
    int duration_min
    timestamptz start_at
    timestamptz end_at
    int num_questions
    int switch_limit
    boolean negative_marking
    boolean release_results
    int created_by FK
  }
  ATTEMPTS {
    int id PK
    int exam_id FK
    int student_id FK
    timestamptz started_at
    timestamptz deadline_at
    timestamptz submitted_at
    string status
    string submit_reason
    numeric score
  }
  ATTEMPT_QUESTIONS {
    int id PK
    int attempt_id FK
    int question_id FK
    int position
    int_array option_order
  }
  ANSWERS {
    int id PK
    int attempt_id FK
    int question_id FK
    int option_id FK
    timestamptz saved_at
  }
  ATTEMPT_EVENTS {
    int id PK
    int attempt_id FK
    string type
    timestamptz created_at
  }
```

## Relationships

| Relationship | Meaning |
|---|---|
| users to courses | A teacher teaches many courses. Each course has one teacher |
| users and courses via enrollments | Students and courses are many-to-many. Unique on (course_id, student_id) |
| courses to questions and exams | Both belong to exactly one course |
| questions to options | Each question has 2 to 6 options, exactly one correct (enforced in the API) |
| exams to attempts | One attempt per student per exam. Unique on (exam_id, student_id) |
| attempts to attempt_questions | Stores each student's own random paper and shuffled option order. Unique on (attempt_id, question_id) and (attempt_id, position) |
| attempts to answers | One saved answer per question per attempt. Unique on (attempt_id, question_id) |
| attempts to attempt_events | The audit trail: start, save, tab_switch, submit, auto_submit |

## Important constraints

- `users.role` is teacher, student or admin.
- `questions.difficulty` is easy, medium or hard, and marks must be above 0.
- `exams.end_at` must be after `start_at`.
- `attempts.status` is in_progress or submitted. `submit_reason` is manual, time_up or switch_limit.
- Deleting a course, exam or attempt cascades to its child rows. A question used in an attempt cannot be deleted (foreign key), and the API blocks editing it too.
- Indexes: attempts(exam_id, student_id), attempt_events(attempt_id), questions(course_id), options(question_id).