// Request logging.
// By default only the important lines go to the console: server errors (5xx), rate limiting (429),
// failed logins, and slow requests. Set LOG_LEVEL=all in .env to print every request, or LOG_LEVEL=off for none.
// Set LOG_FILE=logs/access.log to also write EVERY request to a file (an audit trail).
// Passwords, tokens and request bodies are never logged, and neither are query strings.

const fs = require('fs');
const path = require('path');

const level = (process.env.LOG_LEVEL || 'important').toLowerCase();
const SLOW_MS = Number(process.env.SLOW_REQUEST_MS) || 1000;

let fileStream = null;
if (process.env.LOG_FILE) {
  const full = path.resolve(process.env.LOG_FILE);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fileStream = fs.createWriteStream(full, { flags: 'a' });
}

function requestLogger(req, res, next) {
  if (level === 'off' && !fileStream) return next();

  const started = process.hrtime.bigint();

  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    const status = res.statusCode;
    const url = req.originalUrl.split('?')[0];
    const who = req.user ? `user=${req.user.id}(${req.user.role})` : 'anonymous';

    const flags = [];
    if (status >= 500) flags.push('ERROR');
    if (status === 429) flags.push('RATE-LIMITED');
    if (url === '/api/auth/login' && status >= 400) flags.push('FAILED-LOGIN');
    if (ms >= SLOW_MS) flags.push('SLOW');

    const line =
      `${new Date().toISOString()} ${req.method} ${url} ${status} ${Math.round(ms)}ms ` +
      `${who} ip=${req.ip}${flags.length > 0 ? ' [' + flags.join(' ') + ']' : ''}`;

    if (fileStream) fileStream.write(line + '\n');
    if (level !== 'off' && (level === 'all' || flags.length > 0)) console.log(line);
  });

  next();
}

module.exports = requestLogger;