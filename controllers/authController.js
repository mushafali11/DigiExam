const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function makeToken(user) {
  return jwt.sign(
    { id: user.id, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '8h' }
  );
}

function isText(value) {
  return typeof value === 'string';
}

// POST /api/auth/register  (students only)
async function register(req, res) {
  try {
    const { name, email, password } = req.body;

    if (!isText(name) || !isText(email) || !isText(password) ||
      !name.trim() || !email.trim() || !password) {
      return res.status(400).json({ message: 'Name, email and password are required' });
    }
    if (name.trim().length > 100) {
      return res.status(400).json({ message: 'Name must be at most 100 characters' });
    }
    if (email.trim().length > 150 || !emailRegex.test(email.trim())) {
      return res.status(400).json({ message: 'Invalid email format' });
    }
    // bcrypt only uses the first 72 characters, so longer passwords are refused
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
       VALUES ($1, $2, $3, 'student')
       RETURNING id, name, email, role`,
      [name.trim(), cleanEmail, hash]
    );

    const user = result.rows[0];
    res.status(201).json({ token: makeToken(user), user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
}

// POST /api/auth/login
async function login(req, res) {
  try {
    const { email, password } = req.body;

    if (!isText(email) || !isText(password) || !email.trim() || !password) {
      return res.status(400).json({ message: 'Email and password are required' });
    }

    const result = await pool.query(
      'SELECT id, name, email, role, is_active, password_hash FROM users WHERE email = $1',
      [email.trim().toLowerCase()]
    );

    // Same message for wrong email and wrong password, so attackers learn nothing
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    // Only someone who knows the password is told the account is deactivated
    if (!user.is_active) {
      return res.status(403).json({
        message: 'This account has been deactivated. Contact your administrator',
      });
    }

    delete user.password_hash;
    delete user.is_active;
    res.json({ token: makeToken(user), user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
}

// GET /api/auth/me  (returns the logged-in user)
async function me(req, res) {
  try {
    const result = await pool.query(
      'SELECT id, name, email, role FROM users WHERE id = $1',
      [req.user.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }
    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
}

// POST /api/auth/change-password   body: { current_password, new_password }
// A wrong current password returns 403 (not 401), so the front-end does not log the user out.
async function changePassword(req, res) {
  try {
    const { current_password, new_password } = req.body;

    if (!isText(current_password) || !isText(new_password) || !current_password || !new_password) {
      return res.status(400).json({ message: 'current_password and new_password are required' });
    }
    if (new_password.length < 6 || new_password.length > 72) {
      return res.status(400).json({ message: 'New password must be 6 to 72 characters' });
    }
    if (new_password === current_password) {
      return res.status(400).json({ message: 'The new password must be different from the current one' });
    }

    const result = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (
      result.rows.length === 0 ||
      !(await bcrypt.compare(current_password, result.rows[0].password_hash))
    ) {
      return res.status(403).json({ message: 'The current password is incorrect' });
    }

    const hash = await bcrypt.hash(new_password, 10);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.user.id]);

    res.json({ message: 'Password changed' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
}

module.exports = { register, login, me, changePassword };