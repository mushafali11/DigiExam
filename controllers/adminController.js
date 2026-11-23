const bcrypt = require('bcrypt');
const pool = require('../db/pool');

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLES = ['teacher', 'student', 'admin'];

// POST /api/admin/users
async function createUser(req, res) {
    try {
        const { name, email, password, role } = req.body;

        if (!name || !email || !password || !role) {
            return res.status(400).json({ message: 'Name, email, password and role are required' });
        }
        if (!ROLES.includes(role)) {
            return res.status(400).json({ message: 'Role must be teacher, student or admin' });
        }
        if (!emailRegex.test(email)) {
            return res.status(400).json({ message: 'Invalid email format' });
        }
        if (password.length < 6) {
            return res.status(400).json({ message: 'Password must be at least 6 characters' });
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
       RETURNING id, name, email, role`,
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
                'SELECT id, name, email, role FROM users WHERE role = $1 ORDER BY id',
                [role]
            )
            : await pool.query('SELECT id, name, email, role FROM users ORDER BY id');

        res.json({ users: result.rows });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
}

module.exports = { createUser, listUsers };