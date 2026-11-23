const jwt = require('jsonwebtoken');
const pool = require('../db/pool');

// Checks the token AND the database, so deactivating a user or changing a role
// takes effect immediately (one fast lookup per request).
async function authenticate(req, res, next) {
  const header = req.headers.authorization;

  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Login required' });
  }

  let payload;
  try {
    payload = jwt.verify(header.split(' ')[1], process.env.JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ message: 'Invalid or expired token' });
  }

  try {
    const result = await pool.query('SELECT id, role, is_active FROM users WHERE id = $1', [
      payload.id,
    ]);
    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({ message: 'This account no longer exists' });
    }
    if (!user.is_active) {
      return res.status(401).json({ message: 'This account has been deactivated' });
    }

    req.user = { id: user.id, role: user.role };
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
}

// Allows only certain roles, e.g. requireRole('teacher', 'admin')
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ message: 'You do not have permission' });
    }
    next();
  };
}

module.exports = { authenticate, requireRole };