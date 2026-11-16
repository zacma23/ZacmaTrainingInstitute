const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { randomUUID } = require('crypto');
const { getPool } = require('../config/db');
const logger = require('../config/logger');

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error('JWT_SECRET environment variable must be set (minimum 16 characters).');
  }
  return secret;
}

function signToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      username: user.username,
      fullName: user.fullName,
      role: user.role,
    },
    getJwtSecret(),
    { expiresIn: process.env.JWT_EXPIRES_IN || '12h' }
  );
}

async function authenticate(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    let token = '';
    if (authHeader.startsWith('Bearer ')) {
      token = authHeader.slice(7).trim();
    }
    if (!token) {
      return res.status(401).json({ error: 'Authentication required. Please log in.' });
    }

    const payload = jwt.verify(token, getJwtSecret());
    const pool = getPool();
    const [rows] = await pool.query(
      'SELECT id, username, fullName, email, phone, role, isActive FROM users WHERE id = ? LIMIT 1',
      [payload.sub]
    );

    if (rows.length === 0 || !rows[0].isActive) {
      return res.status(401).json({ error: 'User account is inactive or no longer exists.' });
    }

    req.user = rows[0];
    return next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Session expired. Please sign in again.' });
    }
    return res.status(401).json({ error: 'Invalid authentication token.' });
  }
}

function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required.' });
    }
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        error: `Access denied. Requires ${allowedRoles.join(' or ')} privileges.`,
      });
    }
    return next();
  };
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 25,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please wait 15 minutes and try again.' },
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' },
});

async function recordAuditLog(
  { user, action, entityType, entityId = null, previousValue = null, newValue = null, reason = '', details = {}, ipAddress = '' },
  conn = null
) {
  try {
    const db = conn || getPool();
    await db.query(
      `INSERT INTO audit_logs (id, userId, username, userRole, action, entityType, entityId, previousValue, newValue, reason, details, ipAddress)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        user ? user.id : null,
        user ? user.username : 'system',
        user ? user.role : 'system',
        action,
        entityType,
        entityId,
        previousValue !== null && previousValue !== undefined ? JSON.stringify(previousValue) : null,
        newValue !== null && newValue !== undefined ? JSON.stringify(newValue) : null,
        reason ? String(reason).trim() : '',
        JSON.stringify(details || {}),
        ipAddress || '',
      ]
    );
  } catch (err) {
    logger.error('Failed to write audit log', { action, error: err.message });
  }
}

module.exports = {
  signToken,
  authenticate,
  requireRole,
  loginLimiter,
  apiLimiter,
  recordAuditLog,
};
