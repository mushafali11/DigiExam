const bcrypt = require('bcrypt');
const pool = require('../db/pool');
const toId = require('../utils/toId');

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLES = ['teacher', 'student', 'admin'];

function isText(value) {
    return typeof value === 'string';
}

// POST /api/admin/users
async function createUser(req, res) {
    try {
        const { name, email, password, role } = req.body;

        if (!isText(name) || !isText(email) || !isText(password) || !isText(role) ||
            !name.trim() || !email.trim() || !password || !role) {
            return res.status(400).json({ message: 'Name, email, password and role are required' });
        }
        if (!ROLES.includes(role)) {
            return res.status(400).json({ message: 'Role must be teacher, student or admin' });
        }
        if (name.trim().length > 100) {
            return res.status(400).json({ message: 'Name must be at most 100 characters' });
        }
        if (email.trim().length > 150 || !emailRegex.test(email.trim())) {
            return res.status(400).json({ message: 'Invalid email format' });
        }
        if (password.length < 6 || password.length > 72) {
            return res.status(400).json({ message: 'Password must be 6 to 72 characters' });
        }

        const cleanEmail = email.trim().toLowerCase();

        const existing = await pool.query('SELECT id FROM users WHERE email = $1', [cleanEmail]);
        if (existing.rows.length > 0) {
            return res.status(409).json({ message: 'Email already registered' });
        }

        const hash = await bcrypt.hash(password, 10);
        const result = await pool.query(
            `INSERT INTO users (name, email, password_hash, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, email, role, is_active`,
            [name.trim(), cleanEmail, hash, role]
        );

        res.status(201).json({ user: result.rows[0] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
}

// GET /api/admin/users  (optional filter: ?role=teacher)
async function listUsers(req, res) {
    try {
        const { role } = req.query;

        if (role && !ROLES.includes(role)) {
            return res.status(400).json({ message: 'Invalid role filter' });
        }

        const result = role
            ? await pool.query(
                'SELECT id, name, email, role, is_active FROM users WHERE role = $1 ORDER BY id',
                [role]
            )
            : await pool.query('SELECT id, name, email, role, is_active FROM users ORDER BY id');

        res.json({ users: result.rows });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
}

// PATCH /api/admin/users/:id   body: any of { name, email, role, is_active, password }
async function updateUser(req, res) {
    const userId = toId(req.params.id);
    if (!userId) return res.status(400).json({ message: 'Invalid user id' });

    const body = req.body;
    const changes = {};

    if (body.name !== undefined) {
        if (!isText(body.name) || !body.name.trim() || body.name.trim().length > 100) {
            return res.status(400).json({ message: 'Name must be 1 to 100 characters' });
        }
        changes.name = body.name.trim();
    }
    if (body.email !== undefined) {
        if (!isText(body.email) || body.email.trim().length > 150 || !emailRegex.test(body.email.trim())) {
            return res.status(400).json({ message: 'Invalid email format' });
        }
        changes.email = body.email.trim().toLowerCase();
    }
    if (body.role !== undefined) {
        if (!isText(body.role) || !ROLES.includes(body.role)) {
            return res.status(400).json({ message: 'Role must be teacher, student or admin' });
        }
        changes.role = body.role;
    }
    if (body.is_active !== undefined) {
        if (typeof body.is_active !== 'boolean') {
            return res.status(400).json({ message: 'is_active must be true or false' });
        }
        changes.is_active = body.is_active;
    }
    if (body.password !== undefined) {
        if (!isText(body.password) || body.password.length < 6 || body.password.length > 72) {
            return res.status(400).json({ message: 'Password must be 6 to 72 characters' });
        }
        changes.password = body.password;
    }
    if (Object.keys(changes).length === 0) {
        return res.status(400).json({
            message: 'Send at least one of: name, email, role, is_active, password',
        });
    }

    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');

        const found = await client.query(
            'SELECT id, role, is_active FROM users WHERE id = $1 FOR UPDATE',
            [userId]
        );
        if (found.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'User not found' });
        }
        const current = found.rows[0];
        const newRole = changes.role !== undefined ? changes.role : current.role;
        const newActive = changes.is_active !== undefined ? changes.is_active : current.is_active;

        // Nobody can lock themselves out
        if (userId === req.user.id && (newRole !== current.role || newActive === false)) {
            await client.query('ROLLBACK');
            return res.status(409).json({
                message: 'You cannot deactivate or change the role of your own account',
            });
        }

        // There must always be one active admin
        if (current.role === 'admin' && current.is_active && (newRole !== 'admin' || newActive === false)) {
            const others = await client.query(
                "SELECT COUNT(*)::int AS total FROM users WHERE role = 'admin' AND is_active AND id <> $1",
                [userId]
            );
            if (others.rows[0].total === 0) {
                await client.query('ROLLBACK');
                return res.status(409).json({ message: 'There must always be at least one active admin' });
            }
        }

        // A role cannot change once the user has data (courses, enrolments, attempts, questions, exams)
        if (newRole !== current.role) {
            const usage = await client.query(
                `SELECT (SELECT COUNT(*) FROM courses WHERE teacher_id = $1)::int
              + (SELECT COUNT(*) FROM enrollments WHERE student_id = $1)::int
              + (SELECT COUNT(*) FROM attempts WHERE student_id = $1)::int
              + (SELECT COUNT(*) FROM questions WHERE created_by = $1)::int
              + (SELECT COUNT(*) FROM exams WHERE created_by = $1)::int AS total`,
                [userId]
            );
            if (usage.rows[0].total > 0) {
                await client.query('ROLLBACK');
                return res.status(409).json({
                    message: 'This user already has courses, enrolments, attempts or exams, so the role cannot be changed',
                });
            }
        }

        if (changes.email !== undefined) {
            const taken = await client.query('SELECT id FROM users WHERE email = $1 AND id <> $2', [
                changes.email,
                userId,
            ]);
            if (taken.rows.length > 0) {
                await client.query('ROLLBACK');
                return res.status(409).json({ message: 'Email already registered' });
            }
        }

        const sets = [];
        const params = [];
        const add = (column, value) => {
            params.push(value);
            sets.push(`${column} = $${params.length}`);
        };
        if (changes.name !== undefined) add('name', changes.name);
        if (changes.email !== undefined) add('email', changes.email);
        if (changes.role !== undefined) add('role', changes.role);
        if (changes.is_active !== undefined) add('is_active', changes.is_active);
        if (changes.password !== undefined) add('password_hash', await bcrypt.hash(changes.password, 10));

        params.push(userId);
        const updated = await client.query(
            `UPDATE users SET ${sets.join(', ')} WHERE id = $${params.length}
       RETURNING id, name, email, role, is_active`,
            params
        );
        await client.query('COMMIT');

        res.json({ user: updated.rows[0] });
    } catch (err) {
        if (client) await client.query('ROLLBACK').catch(() => { });
        if (err.code === '23505') {
            return res.status(409).json({ message: 'Email already registered' });
        }
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    } finally {
        if (client) client.release();
    }
}

module.exports = { createUser, listUsers, updateUser };