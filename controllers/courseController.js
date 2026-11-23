const pool = require('../db/pool');
const toId = require('../utils/toId');

function isText(value) {
    return typeof value === 'string';
}

// POST /api/courses  (admin)
async function createCourse(req, res) {
    try {
        const { code, title } = req.body;
        const teacherId = toId(req.body.teacher_id);

        if (!isText(code) || !isText(title) || !code.trim() || !title.trim() || !teacherId) {
            return res.status(400).json({ message: 'Code, title and teacher_id are required' });
        }
        if (code.trim().length > 20) {
            return res.status(400).json({ message: 'Code must be at most 20 characters' });
        }
        if (title.trim().length > 150) {
            return res.status(400).json({ message: 'Title must be at most 150 characters' });
        }

        const teacher = await pool.query(
            "SELECT id FROM users WHERE id = $1 AND role = 'teacher'",
            [teacherId]
        );
        if (teacher.rows.length === 0) {
            return res.status(400).json({ message: 'teacher_id must belong to a teacher' });
        }

        const result = await pool.query(
            `INSERT INTO courses (code, title, teacher_id)
       VALUES ($1, $2, $3)
       RETURNING id, code, title, teacher_id`,
            [code.trim().toUpperCase(), title.trim(), teacherId]
        );

        res.status(201).json({ course: result.rows[0] });
    } catch (err) {
        if (err.code === '23505') {
            return res.status(409).json({ message: 'A course with this code already exists' });
        }
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
}

// GET /api/courses  (admin: all, teacher: own, student: enrolled)
async function listCourses(req, res) {
    try {
        const { id, role } = req.user;
        let result;

        if (role === 'admin') {
            result = await pool.query(
                `SELECT c.id, c.code, c.title, c.teacher_id, u.name AS teacher_name
         FROM courses c JOIN users u ON u.id = c.teacher_id
         ORDER BY c.id`
            );
        } else if (role === 'teacher') {
            result = await pool.query(
                `SELECT c.id, c.code, c.title, c.teacher_id, u.name AS teacher_name
         FROM courses c JOIN users u ON u.id = c.teacher_id
         WHERE c.teacher_id = $1
         ORDER BY c.id`,
                [id]
            );
        } else {
            result = await pool.query(
                `SELECT c.id, c.code, c.title, c.teacher_id, u.name AS teacher_name
         FROM courses c
         JOIN enrollments e ON e.course_id = c.id
         JOIN users u ON u.id = c.teacher_id
         WHERE e.student_id = $1
         ORDER BY c.id`,
                [id]
            );
        }

        res.json({ courses: result.rows });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
}

// POST /api/courses/:id/enrollments  (admin)  body: { student_id }
async function enrollStudent(req, res) {
    try {
        const courseId = toId(req.params.id);
        const studentId = toId(req.body.student_id);

        if (!courseId || !studentId) {
            return res.status(400).json({ message: 'Valid course id and student_id are required' });
        }

        const course = await pool.query('SELECT id FROM courses WHERE id = $1', [courseId]);
        if (course.rows.length === 0) {
            return res.status(404).json({ message: 'Course not found' });
        }

        const student = await pool.query(
            "SELECT id FROM users WHERE id = $1 AND role = 'student'",
            [studentId]
        );
        if (student.rows.length === 0) {
            return res.status(400).json({ message: 'student_id must belong to a student' });
        }

        const result = await pool.query(
            `INSERT INTO enrollments (course_id, student_id)
       VALUES ($1, $2)
       RETURNING id, course_id, student_id`,
            [courseId, studentId]
        );

        res.status(201).json({ enrollment: result.rows[0] });
    } catch (err) {
        if (err.code === '23505') {
            return res.status(409).json({ message: 'Student is already enrolled' });
        }
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
}

// GET /api/courses/:id/students  (admin, or the teacher of that course)
async function listCourseStudents(req, res) {
    try {
        const courseId = toId(req.params.id);
        if (!courseId) {
            return res.status(400).json({ message: 'Invalid course id' });
        }

        const course = await pool.query('SELECT id, teacher_id FROM courses WHERE id = $1', [courseId]);
        if (course.rows.length === 0) {
            return res.status(404).json({ message: 'Course not found' });
        }

        // A teacher may only see students of their own course
        if (req.user.role === 'teacher' && course.rows[0].teacher_id !== req.user.id) {
            return res.status(403).json({ message: 'This is not your course' });
        }

        const result = await pool.query(
            `SELECT u.id, u.name, u.email
       FROM enrollments e JOIN users u ON u.id = e.student_id
       WHERE e.course_id = $1
       ORDER BY u.name`,
            [courseId]
        );

        res.json({ students: result.rows });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
}

// DELETE /api/courses/:id/enrollments/:studentId  (admin)
async function removeStudent(req, res) {
    try {
        const courseId = toId(req.params.id);
        const studentId = toId(req.params.studentId);

        if (!courseId || !studentId) {
            return res.status(400).json({ message: 'Invalid ids' });
        }

        const result = await pool.query(
            'DELETE FROM enrollments WHERE course_id = $1 AND student_id = $2 RETURNING id',
            [courseId, studentId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Enrollment not found' });
        }

        res.json({ message: 'Student removed from course' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
}

module.exports = {
    createCourse,
    listCourses,
    enrollStudent,
    listCourseStudents,
    removeStudent,
};