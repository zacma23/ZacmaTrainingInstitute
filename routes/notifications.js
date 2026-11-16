const express = require('express');
const { getPool } = require('../config/db');
const { authenticate, requireRole, recordAuditLog } = require('../middleware/auth');
const { runReminderCheck } = require('../services/reminderService');
const { getGatewayStatus } = require('../services/messagingService');

const router = express.Router();
router.use(authenticate);

function buildScopeSql(user) {
  if (user.role === 'admin') {
    return { sql: "n.targetRole IN ('all', 'admin')", params: [] };
  }
  return {
    sql: "n.targetRole = 'accountant' AND (n.targetUserId IS NULL OR n.targetUserId = ?)",
    params: [user.id],
  };
}

// List role-scoped notifications
router.get('/', async (req, res) => {
  try {
    const { filter, type } = req.query;
    const pool = getPool();
    const scope = buildScopeSql(req.user);

    let query = `
      SELECT n.*,
             s.fullName AS studentName, s.studentCode, s.phone,
             c.name AS courseName
      FROM notifications n
      LEFT JOIN students s ON n.studentId = s.id
      LEFT JOIN enrollments e ON n.enrollmentId = e.id
      LEFT JOIN courses c ON e.courseId = c.id
      WHERE (s.id IS NULL OR s.status != 'Archived')
        AND ${scope.sql}
    `;
    const params = [...scope.params];

    if (filter === 'unread') {
      query += ' AND n.isRead = 0';
    } else if (filter === 'read') {
      query += ' AND n.isRead = 1';
    }

    if (type) {
      query += ' AND n.type = ?';
      params.push(type);
    }

    query += ' ORDER BY n.isRead ASC, n.createdAt DESC, n.overdueDays DESC';

    const [items] = await pool.query(query, params);
    const [[unreadRow]] = await pool.query(
      `SELECT COUNT(*) AS cnt FROM notifications n WHERE n.isRead = 0 AND ${scope.sql}`,
      scope.params
    );

    res.json({
      unreadCount: unreadRow.cnt,
      gateway: getGatewayStatus(),
      notifications: items,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Trigger scheduled reminder check manually (ADMIN ONLY)
router.post('/check', requireRole('admin'), async (req, res) => {
  try {
    const result = await runReminderCheck();
    res.json({ message: 'Payment reminder scan completed.', ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mark single visible notification as read
router.patch('/:id/read', async (req, res) => {
  try {
    const pool = getPool();
    const scope = buildScopeSql(req.user);
    await pool.query(
      `UPDATE notifications n SET n.isRead = 1, n.readAt = NOW(), n.readByUserId = ?
       WHERE n.id = ? AND ${scope.sql}`,
      [req.user.id, req.params.id, ...scope.params]
    );
    res.json({ message: 'Notification marked as read.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mark all visible notifications as read
router.patch('/read-all', async (req, res) => {
  try {
    const pool = getPool();
    const scope = buildScopeSql(req.user);
    await pool.query(
      `UPDATE notifications n SET n.isRead = 1, n.readAt = NOW(), n.readByUserId = ?
       WHERE n.isRead = 0 AND ${scope.sql}`,
      [req.user.id, ...scope.params]
    );
    await recordAuditLog({
      user: req.user,
      action: 'MARK_ALL_NOTIFICATIONS_READ',
      entityType: 'notification',
      ipAddress: req.ip,
    });
    res.json({ message: 'All notifications marked as read.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
