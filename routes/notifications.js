const express = require('express');
const { randomUUID } = require('crypto');
const { getPool } = require('../config/db');
const { authenticate, requireRole, recordAuditLog } = require('../middleware/auth');
const { runReminderCheck } = require('../services/reminderService');
const {
  getGatewayStatus,
  dispatchReminderMessage,
  dispatchEmailMessage,
  normalizeEmailAddress,
  normalizePhoneForProvider,
} = require('../services/messagingService');
const { computeEnrollmentFinancials } = require('../services/feeService');
const { getAddisTodayISO, formatETB } = require('../utils/ethiopia');

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

async function getMessagingSettings(pool) {
  const [rows] = await pool.query(
    "SELECT settingKey, settingValue FROM settings WHERE settingKey IN ('instituteName', 'instituteShortName', 'institutePhone', 'instituteEmail', 'smsFromNumber', 'smsSenderId', 'emailFromAddress', 'emailFromName')"
  );
  return Object.fromEntries(rows.map((r) => [r.settingKey, r.settingValue]));
}

function personalizeText(template, st, instituteName) {
  return String(template || '')
    .replace(/\{studentName\}/gi, st.fullName || 'Student')
    .replace(/\{studentCode\}/gi, st.studentCode || '')
    .replace(/\{courseName\}/gi, st.courseName || 'your course')
    .replace(/\{balance\}/gi, formatETB(st.remainingBalance || 0))
    .replace(/\{instituteName\}/gi, instituteName);
}

// List role-scoped notifications
router.get('/', async (req, res) => {
  try {
    const { filter, type } = req.query;
    const pool = getPool();
    const scope = buildScopeSql(req.user);

    let query = `
      SELECT n.*,
             s.fullName AS studentName, s.studentCode, s.phone, s.email,
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
    const msgSettings = await getMessagingSettings(pool);

    res.json({
      unreadCount: unreadRow.cnt,
      gateway: getGatewayStatus(msgSettings),
      notifications: items,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Send message / email to student(s) via configured phone provider or email provider (ADMIN ONLY)
router.post('/send-message', requireRole('admin'), async (req, res) => {
  try {
    const {
      targetMode = 'single',
      studentId = '',
      studentIds = [],
      courseId = '',
      channel = 'sms',
      senderPhone = '',
      senderEmail = '',
      subject = '',
      title = 'Institute Notification',
      message = '',
      notificationId = '',
    } = req.body || {};

    const cleanMessage = String(message || '').trim();
    if (!cleanMessage) {
      return res.status(400).json({ error: 'Message text is required.' });
    }
    if (!['sms', 'whatsapp', 'email', 'both'].includes(channel)) {
      return res.status(400).json({ error: 'Invalid messaging channel. Use sms, email, both, or whatsapp.' });
    }

    const cleanSenderPhone = String(senderPhone || '').trim();
    if (cleanSenderPhone && (channel === 'sms' || channel === 'whatsapp' || channel === 'both')) {
      const phoneCheck = normalizePhoneForProvider(cleanSenderPhone);
      if (!phoneCheck.valid) {
        return res.status(400).json({ error: `Invalid sender phone number: ${phoneCheck.error}` });
      }
    }

    const cleanSenderEmail = String(senderEmail || '').trim();
    if (cleanSenderEmail && (channel === 'email' || channel === 'both')) {
      const emailCheck = normalizeEmailAddress(cleanSenderEmail);
      if (!emailCheck.valid) {
        return res.status(400).json({ error: `Invalid sender email address: ${emailCheck.error}` });
      }
    }

    const pool = getPool();
    const todayISO = getAddisTodayISO();
    const settings = await getMessagingSettings(pool);
    const effectiveSettings = {
      ...settings,
      ...(cleanSenderPhone ? { smsFromNumber: cleanSenderPhone } : {}),
      ...(cleanSenderEmail ? { emailFromAddress: cleanSenderEmail } : {}),
    };
    const gateway = getGatewayStatus(effectiveSettings);
    const instituteName = settings.instituteName || 'Zacma Technology Institute';
    const activeFromPhone = gateway.sms.fromNumber || '';
    const activeFromEmail = gateway.email.fromEmail || '';
    const activeFromName = gateway.email.fromName || instituteName;
    const rawSubject = String(subject || title || 'Institute Notification').trim();

    let studentQuery = `
      SELECT s.id AS studentId, s.studentCode, s.fullName, s.phone, s.email, s.status AS studentStatus,
             e.id AS enrollmentId, e.courseId, e.totalCourseFee, e.registrationFee, e.courseStartDate,
             e.assignedDueDate, e.enrollmentStatus,
             c.name AS courseName
      FROM students s
      LEFT JOIN enrollments e ON e.studentId = s.id AND e.enrollmentStatus IN ('Active', 'Completed')
      LEFT JOIN courses c ON c.id = e.courseId
      WHERE s.status != 'Archived'
    `;
    const params = [];

    if (Array.isArray(studentIds) && studentIds.length > 0) {
      const cleanIds = studentIds.map((x) => String(x).trim()).filter(Boolean).slice(0, 200);
      studentQuery += ` AND s.id IN (${cleanIds.map(() => '?').join(',')})`;
      params.push(...cleanIds);
    } else if (targetMode === 'single') {
      if (!studentId) {
        return res.status(400).json({ error: 'Please select a student to message.' });
      }
      studentQuery += ' AND s.id = ?';
      params.push(studentId);
    } else if (targetMode === 'course') {
      if (!courseId) {
        return res.status(400).json({ error: 'Please select a course.' });
      }
      studentQuery += ' AND e.courseId = ?';
      params.push(courseId);
    } else if (targetMode === 'overdue' || targetMode === 'unpaid' || targetMode === 'all') {
      studentQuery += " AND s.status IN ('Active', 'Suspended')";
    } else {
      return res.status(400).json({ error: 'Unsupported targetMode.' });
    }

    studentQuery += ' ORDER BY s.fullName ASC LIMIT 250';
    const [rawRows] = await pool.query(studentQuery, params);

    const studentMap = new Map();
    for (const r of rawRows) {
      if (!studentMap.has(r.studentId)) {
        studentMap.set(r.studentId, r);
      }
    }
    let targets = Array.from(studentMap.values());

    if (targets.length === 0) {
      return res.status(404).json({ error: 'No matching students found for this audience.' });
    }

    const enrIds = targets.map((t) => t.enrollmentId).filter(Boolean);
    const instByEnr = new Map();
    const txnByEnr = new Map();
    if (enrIds.length > 0) {
      const placeholders = enrIds.map(() => '?').join(',');
      const [insts] = await pool.query(
        `SELECT * FROM installments WHERE enrollmentId IN (${placeholders}) ORDER BY installmentNumber ASC`,
        enrIds
      );
      const [txns] = await pool.query(
        `SELECT * FROM transactions WHERE enrollmentId IN (${placeholders}) ORDER BY paymentDate ASC, createdAt ASC`,
        enrIds
      );
      for (const i of insts) {
        if (!instByEnr.has(i.enrollmentId)) instByEnr.set(i.enrollmentId, []);
        instByEnr.get(i.enrollmentId).push(i);
      }
      for (const t of txns) {
        if (!txnByEnr.has(t.enrollmentId)) txnByEnr.set(t.enrollmentId, []);
        txnByEnr.get(t.enrollmentId).push(t);
      }
    }

    targets = targets
      .map((t) => {
        if (!t.enrollmentId) {
          return { ...t, remainingBalance: 0, isOverdue: false };
        }
        const fin = computeEnrollmentFinancials(
          t,
          instByEnr.get(t.enrollmentId) || [],
          txnByEnr.get(t.enrollmentId) || [],
          todayISO
        );
        return {
          ...t,
          remainingBalance: fin.remainingBalance,
          isOverdue: fin.isOverdue,
        };
      })
      .filter((t) => {
        if (targetMode === 'overdue') return t.isOverdue && t.remainingBalance > 0.009;
        if (targetMode === 'unpaid') return t.remainingBalance > 0.009;
        return true;
      })
      .slice(0, 200);

    if (targets.length === 0) {
      return res.status(404).json({ error: 'No students matched the selected balance/overdue filter.' });
    }

    const results = [];
    let sentCount = 0;
    let failedCount = 0;
    let notConfiguredCount = 0;

    for (const st of targets) {
      const personalized = personalizeText(cleanMessage, st, instituteName);
      const personalizedSubject = personalizeText(rawSubject, st, instituteName).slice(0, 190);

      let smsDispatch = null;
      let emailDispatch = null;
      let combinedSent = false;
      let channelStatus = 'FAILED';
      let detail = '';

      if (channel === 'sms' || channel === 'whatsapp') {
        smsDispatch = await dispatchReminderMessage({
          phone: st.phone,
          message: personalized,
          channel,
          fromNumber: activeFromPhone,
          senderId: settings.smsSenderId || '',
        });
        combinedSent = smsDispatch.sent;
        channelStatus = smsDispatch.channelStatus;
        detail = smsDispatch.detail;
      } else if (channel === 'email') {
        emailDispatch = await dispatchEmailMessage({
          toEmail: st.email,
          toName: st.fullName || 'Student',
          subject: personalizedSubject,
          message: personalized,
          fromEmail: activeFromEmail,
          fromName: activeFromName,
          replyTo: activeFromEmail,
          instituteName,
        });
        combinedSent = emailDispatch.sent;
        channelStatus = emailDispatch.channelStatus;
        detail = emailDispatch.detail;
      } else if (channel === 'both') {
        [smsDispatch, emailDispatch] = await Promise.all([
          dispatchReminderMessage({
            phone: st.phone,
            message: personalized,
            channel: 'sms',
            fromNumber: activeFromPhone,
            senderId: settings.smsSenderId || '',
          }),
          dispatchEmailMessage({
            toEmail: st.email,
            toName: st.fullName || 'Student',
            subject: personalizedSubject,
            message: personalized,
            fromEmail: activeFromEmail,
            fromName: activeFromName,
            replyTo: activeFromEmail,
            instituteName,
          }),
        ]);

        if (smsDispatch.sent && emailDispatch.sent) {
          combinedSent = true;
          channelStatus = 'SENT';
        } else if (smsDispatch.sent || emailDispatch.sent) {
          combinedSent = true;
          channelStatus = 'PARTIAL';
        } else if (
          smsDispatch.channelStatus === 'SMS_NOT_CONFIGURED' &&
          emailDispatch.channelStatus === 'EMAIL_NOT_CONFIGURED'
        ) {
          combinedSent = false;
          channelStatus = 'SMS_NOT_CONFIGURED';
        } else {
          combinedSent = false;
          channelStatus = 'FAILED';
        }
        detail = `SMS: ${smsDispatch.detail} | Email: ${emailDispatch.detail}`;
      }

      if (combinedSent) {
        sentCount++;
      } else if (
        channelStatus === 'SMS_NOT_CONFIGURED' ||
        channelStatus === 'WHATSAPP_NOT_CONFIGURED' ||
        channelStatus === 'EMAIL_NOT_CONFIGURED'
      ) {
        notConfiguredCount++;
      } else {
        failedCount++;
      }

      const logPrefix =
        channel === 'email'
          ? `[EMAIL -> ${st.email || 'no-email'}${activeFromEmail ? ` (From ${activeFromEmail})` : ''} | Subj: ${personalizedSubject}]`
          : channel === 'both'
            ? `[SMS -> ${st.phone}${activeFromPhone ? ` (From ${activeFromPhone})` : ''} & EMAIL -> ${st.email || 'no-email'}${activeFromEmail ? ` (From ${activeFromEmail})` : ''}]`
            : `[${channel.toUpperCase()} -> ${st.phone}${activeFromPhone ? ` (From ${activeFromPhone})` : ''}]`;

      const logTitle = (
        channel === 'email' || channel === 'both'
          ? personalizedSubject || title || 'Student Email Notification'
          : title || 'Student Phone Notification'
      )
        .trim()
        .slice(0, 190);

      if (notificationId && targets.length === 1) {
        await pool.query('UPDATE notifications SET channelStatus = ? WHERE id = ?', [channelStatus, notificationId]);
      } else {
        const msgId = randomUUID();
        const dedupeKey = `MSG:${st.studentId}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`;
        await pool.query(
          `INSERT INTO notifications
           (id, studentId, enrollmentId, targetRole, type, dedupeKey, title, message, amountDue, dueDate, overdueDays, channelStatus, isRead)
           VALUES (?, ?, ?, 'admin', 'STUDENT_MESSAGE', ?, ?, ?, ?, ?, 0, ?, 1)`,
          [
            msgId,
            st.studentId,
            st.enrollmentId || null,
            dedupeKey,
            logTitle,
            `${logPrefix} ${personalized}`,
            Number(st.remainingBalance || 0),
            todayISO,
            channelStatus,
          ]
        );
      }

      results.push({
        studentId: st.studentId,
        studentCode: st.studentCode,
        fullName: st.fullName,
        phone: st.phone,
        email: st.email || '',
        sent: combinedSent,
        channelStatus,
        smsStatus: smsDispatch ? smsDispatch.channelStatus : null,
        emailStatus: emailDispatch ? emailDispatch.channelStatus : null,
        detail,
      });
    }

    await recordAuditLog({
      user: req.user,
      action: 'SEND_STUDENT_MESSAGE',
      entityType: 'notification',
      entityId: targetMode === 'single' ? targets[0].studentId : targetMode,
      newValue: {
        channel,
        smsProvider: gateway.sms.provider,
        emailProvider: gateway.email.provider,
        fromNumber: activeFromPhone,
        fromEmail: activeFromEmail,
        totalTargeted: targets.length,
        sentCount,
        failedCount,
        notConfiguredCount,
      },
      ipAddress: req.ip,
    });

    const channelLabel = channel === 'both' ? 'SMS & Email' : channel.toUpperCase();
    const providerLabel =
      channel === 'email'
        ? gateway.email.provider
        : channel === 'both'
          ? `${gateway.sms.provider}/${gateway.email.provider}`
          : channel === 'whatsapp'
            ? gateway.whatsapp.provider
            : gateway.sms.provider;

    const summaryMsg =
      sentCount > 0
        ? `Sent ${sentCount} of ${targets.length} ${channelLabel} message(s) via ${providerLabel}.`
        : notConfiguredCount === targets.length
          ? `${channelLabel} provider is not configured on the server yet (${targets.length} message(s) logged as not configured).`
          : `Failed to deliver ${failedCount} of ${targets.length} ${channelLabel} message(s).`;

    const gatewayConfigured =
      channel === 'email'
        ? gateway.email.configured
        : channel === 'both'
          ? gateway.sms.configured || gateway.email.configured
          : channel === 'whatsapp'
            ? gateway.whatsapp.configured
            : gateway.sms.configured;

    res.json({
      message: summaryMsg,
      channel,
      provider: providerLabel,
      fromNumber: activeFromPhone,
      fromEmail: activeFromEmail,
      smsGateway: gateway.sms,
      emailGateway: gateway.email,
      gatewayConfigured,
      totalTargeted: targets.length,
      sentCount,
      failedCount,
      notConfiguredCount,
      results,
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

// Delete single notification (ADMIN ONLY)
router.delete('/:id', requireRole('admin'), async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.query('SELECT id, type, title FROM notifications WHERE id = ? LIMIT 1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Notification not found.' });

    await pool.query('DELETE FROM notifications WHERE id = ?', [req.params.id]);
    await recordAuditLog({
      user: req.user,
      action: 'DELETE_NOTIFICATION',
      entityType: 'notification',
      entityId: req.params.id,
      previousValue: { type: rows[0].type, title: rows[0].title },
      ipAddress: req.ip,
    });
    res.json({ message: 'Notification deleted.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Clear read or all notifications (ADMIN ONLY)
router.delete('/', requireRole('admin'), async (req, res) => {
  try {
    const pool = getPool();
    const scopeOnlyRead = String(req.query.onlyRead || '').toLowerCase() === 'true';
    const [result] = scopeOnlyRead
      ? await pool.query('DELETE FROM notifications WHERE isRead = 1')
      : await pool.query('DELETE FROM notifications');
    await recordAuditLog({
      user: req.user,
      action: 'CLEAR_NOTIFICATIONS',
      entityType: 'notification',
      details: { onlyRead: scopeOnlyRead, deletedCount: result.affectedRows || 0 },
      ipAddress: req.ip,
    });
    res.json({ message: `Cleared ${result.affectedRows || 0} notification(s).` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
