const rl = require('express-rate-limit');

// Works across versions of express-rate-limit
const rateLimit = rl.rateLimit || rl;
const ipKey = rl.ipKeyGenerator || ((ip) => ip);

const WINDOW_MINUTES = 15;
const MAX_FAILURES = Number(process.env.AUTH_MAX_FAILURES) || 10;

// Counts only FAILED login/register requests (status 400 or above),
// separately for each email + device, so one student's typos never block others.
const failedAuthLimiter = rateLimit({
    windowMs: WINDOW_MINUTES * 60 * 1000,
    limit: MAX_FAILURES,
    skipSuccessfulRequests: true,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
        return `${ipKey(req.ip)}|${email}`;
    },
    message: { message: `Too many failed attempts. Try again in ${WINDOW_MINUTES} minutes` },
});

module.exports = { failedAuthLimiter };