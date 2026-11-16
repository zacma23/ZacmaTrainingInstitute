const { randomUUID } = require('crypto');
const { getPool } = require('../config/db');
const logger = require('../config/logger');
const { getAddisTodayISO, diffDaysISO, formatETB } = require('../utils/ethiopia');
const { computeEnrollmentFinancials } = require('./feeService');
const { getGatewayStatus } = require('./messagingService');

async function getReminderDaysBefore(pool) {
  const [rows] = await pool.query(
    "SELECT settingValue FROM settings WHERE settingKey = 'reminderDaysBefore' LIMIT 1"
  );
  const parsed = rows.length > 0 ? parseInt(rows[0].settingValue, 10) : 3;
  return Number.isNaN(parsed) ? 3 : parsed;
}

/**
 * Scans all Active enrollments & installments in MySQL and generates deduplicated
 * reminders for: DUE_TODAY, DUE_SOON (<= N days), OVERDUE, and UNPAID_INSTALLMENT.
 */
async function runReminderCheck() {
  const pool = getPool();
  const todayISO = getAddisTodayISO();
  const reminderDays = await getReminderDaysBefore(pool);
  const gateway = getGatewayStatus();
  const defaultChannelStatus = gateway.whatsapp.configured || gateway.sms.configured
    ? 'IN_APP_ONLY'
    : 'WHATSAPP_NOT_CONFIGURED';

  const [enrollments] = await pool.query(`
    SELECT e.*, s.fullName, s.studentCode, s.phone, s.status AS studentStatus,
           c.name AS courseName
    FROM enrollments e
    JOIN students s ON e.studentId = s.id
    JOIN courses c ON e.courseId = c.id
    WHERE e.enrollmentStatus = 'Active' AND s.status IN ('Active', 'Suspended')
  `);

  if (enrollments.length === 0) {
    return { checkedEnrollments: 0, createdNotifications: 0 };
  }

  const [allInstallments] = await pool.query('SELECT * FROM installments ORDER BY installmentNumber ASC');
  const [allTransactions] = await pool.query('SELECT * FROM transactions ORDER BY paymentDate ASC, createdAt ASC');

  let createdNotifications = 0;

  for (const enr of enrollments) {
    const insts = allInstallments.filter((i) => i.enrollmentId === enr.id);
    const txns = allTransactions.filter((t) => t.enrollmentId === enr.id);
    const fin = computeEnrollmentFinancials(enr, insts, txns, todayISO);

    if (fin.remainingBalance <= 0.009) continue;

    for (const inst of fin.installments) {
      if (inst.remainingAmount <= 0.009) continue;

      const daysPastDue = diffDaysISO(inst.dueDate, todayISO);
      const daysUntilDue = diffDaysISO(todayISO, inst.dueDate);

      let type = null;
      let title = '';
      let message = '';
      let overdueDays = 0;

      if (daysPastDue > 0) {
        type = 'OVERDUE';
        overdueDays = daysPastDue;
        title = `Overdue Installment (${overdueDays}d) — ${enr.fullName}`;
        message = `${enr.fullName} (${enr.studentCode}) has an overdue ${inst.title} payment of ${formatETB(inst.remainingAmount)} for ${enr.courseName} (due ${inst.dueDate}).`;
      } else if (daysPastDue === 0) {
        type = 'DUE_TODAY';
        title = `Payment Due Today — ${enr.fullName}`;
        message = `${enr.fullName} (${enr.studentCode}) has a ${inst.title} installment of ${formatETB(inst.remainingAmount)} due today (${inst.dueDate}) for ${enr.courseName}.`;
      } else if (daysUntilDue > 0 && daysUntilDue <= reminderDays) {
        type = 'DUE_SOON';
        title = `Payment Due in ${daysUntilDue} Day(s) — ${enr.fullName}`;
        message = `${enr.fullName} (${enr.studentCode}) has ${formatETB(inst.remainingAmount)} (${inst.title}) due on ${inst.dueDate} for ${enr.courseName}.`;
      }

      if (!type) continue;

      // Deterministic dedupeKey prevents duplicate notifications for the same installment state/cycle
      const cycleKey = type === 'OVERDUE' ? `${todayISO.slice(0, 7)}` : inst.dueDate;
      const dedupeKey = `${enr.id}:${inst.id}:${type}:${cycleKey}`;

      // Check if an existing notification for this installment & type exists; if OVERDUE, update overdueDays & amountDue cleanly
      const [existing] = await pool.query(
        'SELECT id FROM notifications WHERE dedupeKey = ? LIMIT 1',
        [dedupeKey]
      );

      if (existing.length > 0) {
        if (type === 'OVERDUE') {
          await pool.query(
            'UPDATE notifications SET overdueDays = ?, amountDue = ?, title = ?, message = ? WHERE id = ?',
            [overdueDays, inst.remainingAmount, title, message, existing[0].id]
          );
        }
        continue;
      }

      await pool.query(
        `INSERT INTO notifications
         (id, studentId, enrollmentId, installmentId, targetRole, type, dedupeKey, title, message, amountDue, dueDate, overdueDays, channelStatus, isRead)
         VALUES (?, ?, ?, ?, 'admin', ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        [
          randomUUID(),
          enr.studentId,
          enr.id,
          inst.id,
          type,
          dedupeKey,
          title,
          message,
          inst.remainingAmount,
          inst.dueDate,
          overdueDays,
          defaultChannelStatus,
        ]
      );
      createdNotifications++;
    }
  }

  logger.info('Automated payment reminder check completed', {
    checkedEnrollments: enrollments.length,
    createdNotifications,
  });

  return { checkedEnrollments: enrollments.length, createdNotifications };
}

async function createWorkflowNotification(
  {
    studentId = null,
    enrollmentId = null,
    applicationId = null,
    paymentSubmissionId = null,
    targetRole = 'admin',
    targetUserId = null,
    type,
    title,
    message,
    amountDue = 0,
    dueDate = null,
  },
  conn = null
) {
  const db = conn || getPool();
  const todayISO = getAddisTodayISO();
  const id = randomUUID();
  const dedupeKey = `WF:${type}:${applicationId || paymentSubmissionId || id}:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`;

  await db.query(
    `INSERT INTO notifications
     (id, studentId, enrollmentId, applicationId, paymentSubmissionId, targetRole, targetUserId, type, dedupeKey, title, message, amountDue, dueDate, overdueDays, channelStatus, isRead)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'IN_APP_ONLY', 0)`,
    [
      id,
      studentId,
      enrollmentId,
      applicationId,
      paymentSubmissionId,
      targetRole,
      targetUserId,
      type,
      dedupeKey,
      title,
      message,
      Number(amountDue || 0),
      dueDate || todayISO,
    ]
  );
  return id;
}

module.exports = {
  runReminderCheck,
  createWorkflowNotification,
};
