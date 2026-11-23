require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const pool = require('./db/pool');
const { sweepExpiredAttempts } = require('./services/attemptService');

if (!process.env.JWT_SECRET) {
  console.error('JWT_SECRET is missing in .env, so the server cannot start');
  process.exit(1);
}

const app = express();

// Safe HTTP headers
app.use(helmet());

// Only these browser origins may call the API (set CORS_ORIGIN in .env to change it).
// Requests without an Origin header (Postman, PowerShell, tests) are always allowed.
const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:5173,http://localhost:3000')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      const err = new Error('Origin not allowed');
      err.type = 'cors';
      return callback(err);
    },
  })
);

app.use(express.json({ limit: '100kb' }));

// Some Express versions leave req.body undefined when no body is sent
app.use((req, res, next) => {
  if (req.body === undefined) req.body = {};
  next();
});

// Health check: confirms server and database are both working
app.get('/api/health', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW() AS now');
    res.json({ status: 'ok', dbTime: result.rows[0].now });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status: 'error', message: 'Database connection failed' });
  }
});

app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/admin', require('./routes/adminRoutes'));
app.use('/api/courses', require('./routes/courseRoutes'));
app.use('/api/questions', require('./routes/questionRoutes'));
app.use('/api/exams', require('./routes/examRoutes'));
app.use('/api/student', require('./routes/studentRoutes'));
app.use('/api/attempts', require('./routes/attemptRoutes'));

// Unknown URL
app.use((req, res) => {
  res.status(404).json({ message: 'Route not found' });
});

// Anything that was not handled elsewhere
app.use((err, req, res, next) => {
  if (err.type === 'cors') {
    return res.status(403).json({ message: 'This origin is not allowed' });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ message: 'Request body is not valid JSON' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ message: 'Request body is too large' });
  }
  console.error(err);
  res.status(500).json({ message: 'Server error' });
});

// Log problems instead of dying silently
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`DigiExam backend running on port ${PORT}`);
});

// Every 30 seconds, auto-submit attempts whose time has run out
setInterval(sweepExpiredAttempts, 30 * 1000);