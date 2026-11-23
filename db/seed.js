require('dotenv').config();
const bcrypt = require('bcrypt');
const pool = require('./pool');

async function seed() {
  // 1. Users
  const users = [
    ['Admin', 'admin@digiexam.com', 'admin123', 'admin'],
    ['Teacher One', 'teacher@digiexam.com', 'teacher123', 'teacher'],
    ['Student One', 'student1@digiexam.com', 'student123', 'student'],
    ['Student Two', 'student2@digiexam.com', 'student123', 'student'],
  ];

  for (const [name, email, password, role] of users) {
    const hash = await bcrypt.hash(password, 10);
    await pool.query(
      `INSERT INTO users (name, email, password_hash, role)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO NOTHING`,
      [name, email, hash, role]
    );
  }

  // 2. A course taught by the teacher
  const teacher = (
    await pool.query("SELECT id FROM users WHERE email = 'teacher@digiexam.com'")
  ).rows[0];

  await pool.query(
    `INSERT INTO courses (code, title, teacher_id)
     VALUES ('CSC336', 'Web Technologies', $1)
     ON CONFLICT (code) DO NOTHING`,
    [teacher.id]
  );

  const course = (
    await pool.query("SELECT id, teacher_id FROM courses WHERE code = 'CSC336'")
  ).rows[0];

  // 3. Enrol the two students
  for (const email of ['student1@digiexam.com', 'student2@digiexam.com']) {
    await pool.query(
      `INSERT INTO enrollments (course_id, student_id)
       SELECT $1::int, id FROM users WHERE email = $2
       ON CONFLICT (course_id, student_id) DO NOTHING`,
      [course.id, email]
    );
  }

  // 4. Sample questions (only if the course has none yet)
  const existing = await pool.query(
    'SELECT COUNT(*)::int AS total FROM questions WHERE course_id = $1',
    [course.id]
  );

  if (existing.rows[0].total === 0) {
    const levels = ['easy', 'medium', 'hard'];

    for (let i = 1; i <= 10; i++) {
      const q = await pool.query(
        `INSERT INTO questions (course_id, text, difficulty, marks, created_by)
         VALUES ($1, $2, $3, 1, $4) RETURNING id`,
        [course.id, `Sample question ${i}: which option is correct?`, levels[i % 3], course.teacher_id]
      );

      const correct = i % 4;
      for (let j = 0; j < 4; j++) {
        await pool.query(
          'INSERT INTO options (question_id, text, is_correct) VALUES ($1, $2, $3)',
          [q.rows[0].id, `Option ${j + 1} for question ${i}`, j === correct]
        );
      }
    }
    console.log('10 sample questions added');
  }

  console.log('Seed done');
  await pool.end();
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});