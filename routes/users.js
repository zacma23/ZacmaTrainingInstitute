const express = require('express');
const bcrypt = require('bcryptjs');
const { randomUUID } = require('crypto');
const { getPool } = require('../config/db');
const { authenticate, requireRole, recordAuditLog } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);
router.use(requireRole('admin'));

router.get('/users', async (req, res) => {
  try {
    const pool = getPool();
    const [users] = await pool.query(
      'SELECT id, username, fullName, email, phone, role, isActive, lastLoginAt, createdAt FROM users ORDER BY createdAt ASC'
    );
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/users', async (req, res) => {
  try {
    const { username, fullName, email, phone, password, role } = req.body || {};
    if (!username || !fullName || !password) {
      return res.status(400).json({ error: 'Username, full name, and password are required.' });
    }
    if (String(password).length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }

    const pool = getPool();
    const cleanUser = String(username).trim().toLowerCase();
    const [dup] = await pool.query('SELECT id FROM users WHERE username = ? LIMIT 1', [cleanUser]);
    if (dup.length > 0) return res.status(409).json({ error: 'Username already exists.' });

    const rounds = parseInt(process.env.BCRYPT_ROUNDS || '10', 10);
    const hash = await bcrypt.hash(String(password), rounds);
    const id = randomUUID();
    const validRole = role === 'admin' ? 'admin' : 'accountant';

    await pool.query(
      `INSERT INTO users (id, username, fullName, email, phone, passwordHash, role, isActive)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        id,
        cleanUser,
        String(fullName).trim(),
        email ? String(email).trim() : null,
        String(phone || '').trim(),
        hash,
        validRole,
      ]
    );

    await recordAuditLog({
      user: req.user,
      action: 'CREATE_USER',
      entityType: 'user',
      entityId: id,
      details: { username: cleanUser, role: validRole },
      ipAddress: req.ip,
    });

    res.status(201).json({ id, username: cleanUser, fullName: String(fullName).trim(), role: validRole });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/users/:id', async (req, res) => {
  try {
    const { fullName, email, phone, role, isActive } = req.body || {};
    if (req.params.id === req.user.id && isActive === false) {
      return res.status(400).json({ error: 'You cannot deactivate your own active session account.' });
    }

    const pool = getPool();
    const [rows] = await pool.query('SELECT * FROM users WHERE id = ? LIMIT 1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'User not found.' });
    const cur = rows[0];

    await pool.query(
      `UPDATE users SET fullName = ?, email = ?, phone = ?, role = ?, isActive = ? WHERE id = ?`,
      [
        fullName ? String(fullName).trim() : cur.fullName,
        email !== undefined ? (String(email).trim() || null) : cur.email,
        phone !== undefined ? String(phone).trim() : cur.phone,
        role === 'admin' || role === 'accountant' ? role : cur.role,
        isActive !== undefined ? (isActive ? 1 : 0) : cur.isActive,
        req.params.id,
      ]
    );

    await recordAuditLog({
      user: req.user,
      action: 'UPDATE_USER',
      entityType: 'user',
      entityId: req.params.id,
      details: { role: role || cur.role, isActive: isActive !== undefined ? isActive : cur.isActive },
      ipAddress: req.ip,
    });

    res.json({ message: 'User account updated.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/users/:id/reset-password', async (req, res) => {
  try {
    const { newPassword } = req.body || {};
    if (!newPassword || String(newPassword).length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters.' });
    }
    const rounds = parseInt(process.env.BCRYPT_ROUNDS || '10', 10);
    const hash = await bcrypt.hash(String(newPassword), rounds);
    const pool = getPool();
    await pool.query('UPDATE users SET passwordHash = ? WHERE id = ?', [hash, req.params.id]);

    await recordAuditLog({
      user: req.user,
      action: 'RESET_USER_PASSWORD',
      entityType: 'user',
      entityId: req.params.id,
      ipAddress: req.ip,
    });

    res.json({ message: 'Password reset successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/audit-logs', async (req, res) => {
  try {
    const limit = Math.min(250, Math.max(10, parseInt(req.query.limit || '80', 10)));
    const { action, userRole, search } = req.query;
    const pool = getPool();

    let query = 'SELECT * FROM audit_logs WHERE 1=1';
    const params = [];

    if (action) {
      query += ' AND action = ?';
      params.push(action);
    }
    if (userRole) {
      query += ' AND userRole = ?';
      params.push(userRole);
    }
    if (search) {
      const s = `%${String(search).trim().toLowerCase()}%`;
      query += ' AND (LOWER(username) LIKE ? OR LOWER(action) LIKE ? OR LOWER(entityType) LIKE ? OR LOWER(COALESCE(reason, \'\')) LIKE ?)';
      params.push(s, s, s, s);
    }

    query += ' ORDER BY createdAt DESC LIMIT ?';
    params.push(limit);

    const [logs] = await pool.query(query, params);
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
