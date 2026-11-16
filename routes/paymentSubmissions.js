const express = require('express');
const { randomUUID } = require('crypto');
const { getPool, withTransaction } = require('../config/db');
const { authenticate, requireRole, recordAuditLog } = require('../middleware/auth');
const { getAddisTodayISO, formatETB } = require('../utils/ethiopia');
const {
  computeEnrollmentFinancials,
  generateNextReceiptNumber,
  generateTransactionId,
  generateSubmissionRef,
  round2,
} = require('../services/feeService');
const { createWorkflowNotification, runReminderCheck } = require('../services/reminderService');

const router = express.Router();
router.use(authenticate);

const VALID_METHODS = ['Cash', 'Bank Transfer', 'Mobile Money', 'Other'];

// GET list payment submissions (Admin sees all; Accountant sees ONLY their own)
router.get('/', async (req, res) => {
  try {
    const { status, studentId, search } = req.query;
    const pool = getPool();

    let query = `
      SELECT ps.*,
             s.fullName AS studentName, s.studentCode, s.phone AS studentPhone,
             c.name AS courseName, c.code AS courseCode,
             rev.fullName AS reviewedByName,
             t.transactionId AS approvedTransactionCode,
             r.receiptNumber AS approvedReceiptNumber
      FROM payment_submissions ps
      JOIN students s ON s.id = ps.studentId
      JOIN enrollments e ON e.id = ps.enrollmentId
      JOIN courses c ON c.id = e.courseId
      LEFT JOIN users rev ON rev.id = ps.reviewedByUserId
      LEFT JOIN transactions t ON t.id = ps.approvedTransactionId
      LEFT JOIN receipts r ON r.id = ps.approvedReceiptId
      WHERE 1=1
    `;
    const params = [];

    if (req.user.role !== 'admin') {
      query += ' AND ps.submittedByUserId = ?';
      params.push(req.user.id);
    }
    if (status) {
      query += ' AND ps.status = ?';
      params.push(status);
    }
    if (studentId) {
      query += ' AND ps.studentId = ?';
      params.push(studentId);
    }
    if (search) {
      const s = `%${String(search).trim().toLowerCase()}%`;
      query += ` AND (
        LOWER(ps.submissionRef) LIKE ? OR
        LOWER(ps.transactionReference) LIKE ? OR
        LOWER(s.fullName) LIKE ? OR
        LOWER(s.studentCode) LIKE ?
      )`;
      params.push(s, s, s, s);
    }

    query += ' ORDER BY ps.createdAt DESC';
    const [rows] = await pool.query(query, params);
    res.json(
      rows.map((r) => ({
        ...r,
        amountSubmitted: Number(r.amountSubmitted),
      }))
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET non-official submission confirmation (Accountant own or Admin any)
router.get('/:id/confirmation', async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT ps.*,
              s.fullName AS studentName, s.studentCode, s.phone AS studentPhone,
              c.name AS courseName, c.code AS courseCode,
              e.totalCourseFee
       FROM payment_submissions ps
       JOIN students s ON s.id = ps.studentId
       JOIN enrollments e ON e.id = ps.enrollmentId
       JOIN courses c ON c.id = e.courseId
       WHERE ps.id = ? LIMIT 1`,
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Payment submission not found.' });
    const sub = rows[0];

    if (req.user.role !== 'admin' && sub.submittedByUserId !== req.user.id) {
      return res.status(403).json({ error: 'Access denied. You can only view confirmations for your own submissions.' });
    }

    const [settingsRows] = await pool.query('SELECT settingKey, settingValue FROM settings');
    const settings = Object.fromEntries(settingsRows.map((r) => [r.settingKey, r.settingValue]));

    res.json({
      isOfficialReceipt: false,
      disclaimer: 'PAYMENT SUBMISSION CONFIRMATION — NOT AN OFFICIAL RECEIPT. Official receipt is issued only after Administrator approval.',
      confirmationType: 'PAYMENT_SUBMISSION',
      submission: {
        ...sub,
        amountSubmitted: Number(sub.amountSubmitted),
        totalCourseFee: Number(sub.totalCourseFee),
      },
      institute: settings,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST submit a new payment for administrator approval (Accountant or Admin)
// IMPORTANT: Inserts ONLY into payment_submissions (status = 'PENDING'). NEVER touches transactions/receipts or official revenue.
router.post('/', async (req, res) => {
  try {
    const { studentId, amountSubmitted, paymentDate, paymentMethod, transactionReference, notes } = req.body || {};
    if (!studentId || !amountSubmitted || !paymentDate || !paymentMethod) {
      return res.status(400).json({ error: 'Student, amount, payment date, and payment method are required.' });
    }
    if (!VALID_METHODS.includes(paymentMethod)) {
      return res.status(400).json({ error: 'Invalid payment method.' });
    }

    const parsedAmount = round2(amountSubmitted);
    if (Number.isNaN(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({ error: 'Submitted payment amount must be greater than 0 ETB.' });
    }

    const created = await withTransaction(async (conn) => {
      const [enrs] = await conn.query(
        `SELECT e.*, s.fullName, s.studentCode, s.status AS studentStatus, c.name AS courseName
         FROM enrollments e
         JOIN students s ON s.id = e.studentId
         JOIN courses c ON c.id = e.courseId
         WHERE e.studentId = ? AND e.enrollmentStatus != 'Archived' AND s.status != 'Archived'
         ORDER BY e.createdAt DESC
         LIMIT 1
         FOR UPDATE`,
        [studentId]
      );
      if (enrs.length === 0) {
        throw new Error('Active enrollment not found for this student.');
      }
      const enr = enrs[0];

      // Check current official balance from approved transactions only
      const [txns] = await conn.query('SELECT * FROM transactions WHERE enrollmentId = ?', [enr.id]);
      const fin = computeEnrollmentFinancials(enr, [], txns, getAddisTodayISO());

      if (fin.remainingBalance <= 0.009) {
        throw new Error('This student has already fully paid their course tuition fee.');
      }
      if (parsedAmount > fin.remainingBalance + 0.009) {
        throw new Error(
          `Submitted amount (${parsedAmount.toFixed(2)} ETB) exceeds remaining official balance (${fin.remainingBalance.toFixed(2)} ETB).`
        );
      }

      const id = randomUUID();
      const submissionRef = generateSubmissionRef('PSUB');

      await conn.query(
        `INSERT INTO payment_submissions (
           id, submissionRef, studentId, enrollmentId, submittedByUserId, submittedByName,
           amountSubmitted, paymentDate, paymentMethod, transactionReference, notes, status
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')`,
        [
          id,
          submissionRef,
          studentId,
          enr.id,
          req.user.id,
          req.user.fullName,
          parsedAmount,
          String(paymentDate).slice(0, 10),
          paymentMethod,
          String(transactionReference || '').trim(),
          String(notes || '').trim(),
        ]
      );

      await createWorkflowNotification(
        {
          studentId,
          enrollmentId: enr.id,
          paymentSubmissionId: id,
          targetRole: 'admin',
          type: 'NEW_PAYMENT_SUBMISSION',
          title: `Payment Pending Approval — ${enr.fullName}`,
          message: `${req.user.fullName} submitted ${formatETB(parsedAmount)} (${paymentMethod}) for ${enr.studentCode} (${submissionRef}).`,
          amountDue: parsedAmount,
          dueDate: String(paymentDate).slice(0, 10),
        },
        conn
      );

      await recordAuditLog(
        {
          user: req.user,
          action: 'SUBMIT_PAYMENT_FOR_APPROVAL',
          entityType: 'payment_submission',
          entityId: id,
          newValue: {
            submissionRef,
            studentCode: enr.studentCode,
            amountSubmitted: parsedAmount,
            paymentMethod,
            status: 'PENDING',
          },
          details: { submissionRef, studentCode: enr.studentCode, amountSubmitted: parsedAmount },
          ipAddress: req.ip,
        },
        conn
      );

      return {
        id,
        submissionRef,
        status: 'PENDING',
        studentId,
        studentName: enr.fullName,
        studentCode: enr.studentCode,
        courseName: enr.courseName,
        amountSubmitted: parsedAmount,
        paymentDate: String(paymentDate).slice(0, 10),
        paymentMethod,
        remainingBalanceBeforeApproval: fin.remainingBalance,
      };
    });

    res.status(201).json(created);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST approve a pending payment submission (ADMIN ONLY)
// Atomically transitions PENDING -> APPROVED, records official transaction, generates official receipt, recalculates balance.
router.post('/:id/approve', requireRole('admin'), async (req, res) => {
  try {
    const comment = String((req.body && req.body.comment) || '').trim();

    const approved = await withTransaction(async (conn) => {
      const [subs] = await conn.query('SELECT * FROM payment_submissions WHERE id = ? LIMIT 1 FOR UPDATE', [req.params.id]);
      if (subs.length === 0) throw new Error('Payment submission not found.');
      const sub = subs[0];

      if (sub.status !== 'PENDING') {
        const err = new Error(`Payment submission ${sub.submissionRef} has already been processed (status: ${sub.status}).`);
        err.status = 409;
        throw err;
      }

      // Lock enrollment row to prevent concurrent over-payment approval
      const [enrs] = await conn.query(
        `SELECT e.*, s.fullName, s.studentCode, c.name AS courseName
         FROM enrollments e
         JOIN students s ON s.id = e.studentId
         JOIN courses c ON c.id = e.courseId
         WHERE e.id = ? LIMIT 1 FOR UPDATE`,
        [sub.enrollmentId]
      );
      if (enrs.length === 0) throw new Error('Associated enrollment not found.');
      const enr = enrs[0];

      const [existingTxns] = await conn.query('SELECT * FROM transactions WHERE enrollmentId = ?', [enr.id]);
      const finBefore = computeEnrollmentFinancials(enr, [], existingTxns, getAddisTodayISO());
      const amount = round2(sub.amountSubmitted);

      if (amount > finBefore.remainingBalance + 0.009) {
        throw new Error(
          `Cannot approve: amount (${amount.toFixed(2)} ETB) exceeds current remaining balance (${finBefore.remainingBalance.toFixed(2)} ETB).`
        );
      }

      const txnUuid = randomUUID();
      const transactionId = generateTransactionId();
      const receiptUuid = randomUUID();
      const receiptNumber = await generateNextReceiptNumber(conn);
      const remainingAfter = round2(Math.max(0, finBefore.remainingBalance - amount));

      await conn.query(
        `INSERT INTO transactions (
           id, transactionId, studentId, enrollmentId, submissionId,
           paymentCategory, registrationAmount, tuitionAmount, amountPaid,
           paymentDate, paymentMethod, transactionReference,
           receivedByUserId, receivedByName, approvedByUserId, approvedAt, notes
         ) VALUES (?, ?, ?, ?, ?, 'COURSE_FEE', 0, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?)`,
        [
          txnUuid,
          transactionId,
          sub.studentId,
          sub.enrollmentId,
          sub.id,
          amount,
          amount,
          String(sub.paymentDate).slice(0, 10),
          sub.paymentMethod,
          sub.transactionReference || '',
          sub.submittedByUserId,
          sub.submittedByName,
          req.user.id,
          sub.notes || `Approved submission ${sub.submissionRef}`,
        ]
      );

      await conn.query(
        `INSERT INTO receipts (
           id, receiptNumber, transactionId, studentId, enrollmentId,
           amountPaid, previousBalance, remainingBalance, issuedBy, approvedByUserId
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          receiptUuid,
          receiptNumber,
          txnUuid,
          sub.studentId,
          sub.enrollmentId,
          amount,
          finBefore.remainingBalance,
          remainingAfter,
          req.user.fullName,
          req.user.id,
        ]
      );

      await conn.query(
        `UPDATE payment_submissions
         SET status = 'APPROVED', reviewedByUserId = ?, reviewedAt = NOW(),
             approvedTransactionId = ?, approvedReceiptId = ?
         WHERE id = ?`,
        [req.user.id, txnUuid, receiptUuid, sub.id]
      );

      if (remainingAfter <= 0.009) {
        await conn.query(
          "UPDATE notifications SET isRead = 1, readAt = NOW(), readByUserId = ? WHERE enrollmentId = ? AND targetRole = 'admin' AND isRead = 0",
          [req.user.id, enr.id]
        );
      }

      await createWorkflowNotification(
        {
          studentId: sub.studentId,
          enrollmentId: sub.enrollmentId,
          paymentSubmissionId: sub.id,
          targetRole: 'accountant',
          targetUserId: sub.submittedByUserId,
          type: 'PAYMENT_APPROVED',
          title: `Payment Approved — ${enr.fullName}`,
          message: `Submission ${sub.submissionRef} (${formatETB(amount)}) was approved by ${req.user.fullName}. Official Receipt: ${receiptNumber}.`,
          amountDue: amount,
          dueDate: String(sub.paymentDate).slice(0, 10),
        },
        conn
      );

      await recordAuditLog(
        {
          user: req.user,
          action: 'APPROVE_PAYMENT',
          entityType: 'payment_submission',
          entityId: sub.id,
          previousValue: { status: 'PENDING', remainingBalance: finBefore.remainingBalance },
          newValue: { status: 'APPROVED', transactionId, receiptNumber, remainingBalance: remainingAfter },
          reason: comment || 'Approved by administrator',
          details: { submissionRef: sub.submissionRef, studentCode: enr.studentCode, amountPaid: amount, receiptNumber },
          ipAddress: req.ip,
        },
        conn
      );

      return {
        message: 'Payment approved and official receipt generated.',
        submissionRef: sub.submissionRef,
        transactionUuid: txnUuid,
        transactionId,
        receiptNumber,
        amountPaid: amount,
        remainingBalance: remainingAfter,
      };
    });

    runReminderCheck().catch(() => {});
    res.json(approved);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

// POST reject a pending payment submission (ADMIN ONLY)
router.post('/:id/reject', requireRole('admin'), async (req, res) => {
  try {
    const reason = String((req.body && req.body.reason) || '').trim();
    if (!reason || reason.length < 3) {
      return res.status(400).json({ error: 'A rejection reason (minimum 3 characters) is required.' });
    }

    await withTransaction(async (conn) => {
      const [subs] = await conn.query('SELECT * FROM payment_submissions WHERE id = ? LIMIT 1 FOR UPDATE', [req.params.id]);
      if (subs.length === 0) throw new Error('Payment submission not found.');
      const sub = subs[0];

      if (sub.status !== 'PENDING') {
        const err = new Error(`Payment submission ${sub.submissionRef} has already been processed (status: ${sub.status}).`);
        err.status = 409;
        throw err;
      }

      const [students] = await conn.query('SELECT fullName, studentCode FROM students WHERE id = ? LIMIT 1', [sub.studentId]);
      const studentName = students[0]?.fullName || 'Student';

      await conn.query(
        `UPDATE payment_submissions
         SET status = 'REJECTED', rejectionReason = ?, reviewedByUserId = ?, reviewedAt = NOW()
         WHERE id = ?`,
        [reason, req.user.id, sub.id]
      );

      await createWorkflowNotification(
        {
          studentId: sub.studentId,
          enrollmentId: sub.enrollmentId,
          paymentSubmissionId: sub.id,
          targetRole: 'accountant',
          targetUserId: sub.submittedByUserId,
          type: 'PAYMENT_REJECTED',
          title: `Payment Rejected — ${studentName}`,
          message: `Submission ${sub.submissionRef} (${formatETB(sub.amountSubmitted)}) was rejected by ${req.user.fullName}. Reason: ${reason}`,
          amountDue: Number(sub.amountSubmitted),
          dueDate: String(sub.paymentDate).slice(0, 10),
        },
        conn
      );

      await recordAuditLog(
        {
          user: req.user,
          action: 'REJECT_PAYMENT',
          entityType: 'payment_submission',
          entityId: sub.id,
          previousValue: { status: 'PENDING' },
          newValue: { status: 'REJECTED' },
          reason,
          details: { submissionRef: sub.submissionRef, studentCode: students[0]?.studentCode, amountSubmitted: Number(sub.amountSubmitted) },
          ipAddress: req.ip,
        },
        conn
      );
    });

    res.json({ message: 'Payment submission rejected and accountant notified.' });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

module.exports = router;
