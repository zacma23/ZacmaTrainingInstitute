const express = require('express');
const bcrypt = require('bcryptjs');
const { randomUUID } = require('crypto');
const { getPool } = require('../config/db');
const { authenticate, signToken, loginLimiter, recordAuditLog, isJwtConfigured } = require('../middleware/auth');
const { verifyFirebaseIdToken } = require('../services/firebaseAdmin');

const router = express.Router();

// Public check: whether an administrator account exists yet
router.get('/status', async (req, res) => {
  try {
    const pool = getPool();
    const [[row]] = await pool.query('SELECT COUNT(*) AS cnt FROM users');
    res.json({ initialized: row.cnt > 0, jwtConfigured: isJwtConfigured() });
  } catch (err) {
    res.status(503).json({
      error: 'Database status check failed.',
      detail: err.message,
    });
  }
});

// First-time Admin setup (ONLY works when users table is empty)
router.post('/setup-admin', loginLimiter, async (req, res) => {
  try {
    const { username, fullName, email, phone, password } = req.body || {};
    if (!username || !fullName || !password) {
      return res.status(400).json({ error: 'Username, full name, and password are required.' });
    }
    if (String(password).length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters long.' });
    }

    const pool = getPool();
    const [[row]] = await pool.query('SELECT COUNT(*) AS cnt FROM users');
    if (row.cnt > 0) {
      return res.status(403).json({ error: 'System is already initialized. Please sign in.' });
    }

    const rounds = parseInt(process.env.BCRYPT_ROUNDS || '10', 10);
    const passwordHash = await bcrypt.hash(String(password), rounds);
    const userId = randomUUID();
    const cleanUsername = String(username).trim().toLowerCase();
    const cleanEmail = email ? String(email).trim().toLowerCase() : null;
    const [roleRows] = await pool.query('SELECT id FROM roles WHERE code = ? LIMIT 1', ['admin']);
    const roleId = roleRows.length > 0 ? roleRows[0].id : null;

    await pool.query(
      `INSERT INTO users (id, username, fullName, email, phone, passwordHash, role, roleId, isActive)
       VALUES (?, ?, ?, ?, ?, ?, 'admin', ?, 1)`,
      [
        userId,
        cleanUsername,
        String(fullName).trim(),
        cleanEmail,
        phone ? String(phone).trim() : '',
        passwordHash,
        roleId,
      ]
    );

    const user = { id: userId, username: cleanUsername, fullName: String(fullName).trim(), role: 'admin' };
    const token = signToken(user);

    await recordAuditLog({
      user,
      action: 'INITIAL_ADMIN_SETUP',
      entityType: 'user',
      entityId: userId,
      ipAddress: req.ip,
    });

    res.status(201).json({ token, user });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Administrator setup failed.' });
  }
});

// Login
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required.' });
    }

    const pool = getPool();
    const [rows] = await pool.query(
      'SELECT id, username, fullName, email, phone, passwordHash, role, isActive FROM users WHERE username = ? LIMIT 1',
      [String(username).trim().toLowerCase()]
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    const user = rows[0];
    if (!user.isActive) {
      return res.status(403).json({ error: 'Account is deactivated. Contact an administrator.' });
    }

    if (!user.passwordHash || typeof user.passwordHash !== 'string') {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    const valid = await bcrypt.compare(String(password), user.passwordHash);
    if (!valid) {
      await recordAuditLog({
        user: { id: user.id, username: user.username, role: user.role },
        action: 'LOGIN_FAILED',
        entityType: 'user',
        entityId: user.id,
        ipAddress: req.ip,
      });
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    await pool.query('UPDATE users SET lastLoginAt = NOW() WHERE id = ?', [user.id]);

    const token = signToken(user);
    await recordAuditLog({
      user,
      action: 'LOGIN_SUCCESS',
      entityType: 'user',
      entityId: user.id,
      ipAddress: req.ip,
    });

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        fullName: user.fullName,
        email: user.email,
        phone: user.phone,
        role: user.role,
      },
    });
  } catch (err) {
    if (err.code === 'JWT_CONFIG_ERROR') {
      return res.status(500).json({ error: err.message });
    }
    res.status(500).json({ error: 'Authentication failed.', detail: err.message });
  }
});

router.get('/me', authenticate, (req, res) => {
  res.json({ user: req.user });
});

router.post('/change-password', authenticate, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword || String(newPassword).length < 8) {
      return res.status(400).json({ error: 'Current password and a new password (min 8 chars) are required.' });
    }

    const pool = getPool();
    const [rows] = await pool.query('SELECT passwordHash FROM users WHERE id = ? LIMIT 1', [req.user.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'User not found.' });

    const match = await bcrypt.compare(String(currentPassword), rows[0].passwordHash || '');
    if (!match) return res.status(401).json({ error: 'Current password is incorrect.' });

    const rounds = parseInt(process.env.BCRYPT_ROUNDS || '10', 10);
    const hash = await bcrypt.hash(String(newPassword), rounds);
    await pool.query('UPDATE users SET passwordHash = ? WHERE id = ?', [hash, req.user.id]);

    await recordAuditLog({
      user: req.user,
      action: 'CHANGE_PASSWORD',
      entityType: 'user',
      entityId: req.user.id,
      ipAddress: req.ip,
    });

    res.json({ message: 'Password updated successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Google Sign-In via Firebase ID Token
router.post('/google', loginLimiter, async (req, res) => {
  try {
    const authHeader = req.headers.authorization || '';
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    const idToken = (req.body && req.body.idToken) || bearerToken;
    if (!idToken) {
      return res.status(400).json({ error: 'Firebase ID token is required.' });
    }

    let decoded;
    try {
      decoded = await verifyFirebaseIdToken(idToken);
    } catch (verifyErr) {
      return res.status(401).json({ error: verifyErr.message || 'Invalid or expired Google sign-in token.' });
    }

    if (!decoded.email || decoded.email_verified !== true) {
      return res.status(403).json({ error: 'A verified Google email address is required.' });
    }

    const emailLower = String(decoded.email).trim().toLowerCase();
    const firebaseUid = String(decoded.uid).trim();
    const displayName = String(decoded.name || emailLower.split('@')[0] || 'Google User').trim().slice(0, 150);

    const pool = getPool();
    const [existingRows] = await pool.query(
      `SELECT id, username, firebaseUid, fullName, email, phone, role, isActive
       FROM users
       WHERE firebaseUid = ? OR LOWER(email) = ?
       ORDER BY (firebaseUid = ?) DESC
       LIMIT 1`,
      [firebaseUid, emailLower, firebaseUid]
    );

    let user;
    if (existingRows.length > 0) {
      user = existingRows[0];
      if (!user.isActive) {
        return res.status(403).json({ error: 'Account is deactivated. Contact an administrator.' });
      }
      await pool.query(
        'UPDATE users SET firebaseUid = ?, lastLoginAt = NOW() WHERE id = ?',
        [firebaseUid, user.id]
      );
    } else {
      const isBootstrappedAdmin = emailLower === 'zekimuluken@gmail.com';
      const assignedRole = isBootstrappedAdmin ? 'admin' : 'accountant';
      const [roleRows] = await pool.query('SELECT id FROM roles WHERE code = ? LIMIT 1', [assignedRole]);
      const roleId = roleRows.length > 0 ? roleRows[0].id : null;

      const userId = randomUUID();
      const baseSlug = emailLower.split('@')[0].replace(/[^a-z0-9_.-]/g, '').slice(0, 44) || 'google_user';
      const username = `${baseSlug}_${firebaseUid.slice(0, 12)}`.toLowerCase();
      const placeholderHash = await bcrypt.hash(randomUUID(), 10);

      await pool.query(
        `INSERT INTO users (id, username, firebaseUid, fullName, email, phone, passwordHash, role, roleId, isActive, lastLoginAt)
         VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, 1, NOW())`,
        [userId, username, firebaseUid, displayName, emailLower, placeholderHash, assignedRole, roleId]
      );

      user = {
        id: userId,
        username,
        firebaseUid,
        fullName: displayName,
        email: emailLower,
        phone: '',
        role: assignedRole,
      };
    }

    const token = signToken(user);
    await recordAuditLog({
      user,
      action: 'GOOGLE_LOGIN_SUCCESS',
      entityType: 'user',
      entityId: user.id,
      details: { firebaseUid, email: emailLower },
      ipAddress: req.ip,
    });

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        firebaseUid,
        fullName: user.fullName,
        email: user.email,
        phone: user.phone || '',
        role: user.role,
      },
    });
  } catch (err) {
    if (err.code === 'JWT_CONFIG_ERROR') {
      return res.status(500).json({ error: err.message });
    }
    res.status(500).json({ error: 'Google sign-in failed.', detail: err.message });
  }
});

router.post('/logout', authenticate, async (req, res) => {
  await recordAuditLog({
    user: req.user,
    action: 'LOGOUT',
    entityType: 'user',
    entityId: req.user.id,
    ipAddress: req.ip,
  });
  res.json({ message: 'Logged out.' });
});

module.exports = router;
