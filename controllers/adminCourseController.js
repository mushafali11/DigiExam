const pool = require('../db/pool');
const toId = require('../utils/toId');

function isText(value) {
    return typeof value === 'string';
}

// PATCH /api/courses/:id   (admin)  body: any of { code, title, teacher_id }
async function updateCourse(req, res) {
    try {
        const courseId = toId(req.params.id);
        if (!courseId) return res.status(400).json({ message: 'Invalid course id' });

        const body = req.body;
        const sets = [];
        const params = [];
        const add = (column, value) => {
            params.push(value);
            sets.push(`${column} = $${params.length}`);
        };

        if (body.code !== undefined) {
            if (!isText(body.code) || !body.code.trim() || body.code.trim().length > 20) {
                return res.status(400).json({ message: 'Code must be 1 to 20 characters' });
            }
            add('code', body.code.trim().toUpperCase());
        }
        if (body.title !== undefined) {
            if (!isText(body.title) || !body.title.trim() || body.title.trim().length > 150) {
                return res.status(400).json({ message: 'Title must be 1 to 150 characters' });
            }
            add('title', body.title.trim());
        }
        if (body.teacher_id !== undefined) {
            const teacherId = toId(body.teacher_id);
            const teacher = teacherId
                ? await pool.query("SELECT id FROM users WHERE id = $1 AND role = 'teacher' AND is_active", [teacherId])
                : { rows: [] };
            if (teacher.rows.length === 0) {
                return res.status(400).json({ message: 'teacher_id must belong to an active teacher' });
            }
            add('teacher_id', teacherId);
        }
        if (sets.length === 0) {
            return res.status(400).json({ message: 'Send at least one of: code, title, teacher_id' });
        }

        params.push(courseId);
        const result = await pool.query(
            `UPDATE courses SET ${sets.join(', ')} WHERE id = $${params.length}
       RETURNING id, code, title, teacher_id`,
            params
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Course not found' });
        }
        res.json({ course: result.rows[0] });
    } catch (err) {
        if (err.code === '23505') {
            return res.status(409).json({ message: 'A course with this code already exists' });
        }
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
}

// DELETE /api/courses/:id   (admin) - only while the course has no exams
async function deleteCourse(req, res) {
    try {
        const courseId = toId(req.params.id);
        if (!courseId) return res.status(400).json({ message: 'Invalid course id' });

        const exams = await pool.query('SELECT 1 FROM exams WHERE course_id = $1 LIMIT 1', [courseId]);
        if (exams.rows.length > 0) {
            return res.status(409).json({
                message: 'This course has exams, so it cannot be deleted. Remove its exams first',
            });
        }

        const result = await pool.query('DELETE FROM courses WHERE id = $1 RETURNING id', [courseId]);
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Course not found' });
        }
        res.json({ message: 'Course deleted (its questions and enrolments were removed too)' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
}

module.exports = { updateCourse, deleteCourse };