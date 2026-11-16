const express = require('express');
const { randomUUID } = require('crypto');
const { getPool, withTransaction } = require('../config/db');
const { authenticate, requireRole, recordAuditLog } = require('../middleware/auth');
const { getAddisTodayISO } = require('../utils/ethiopia');
const {
  computeEnrollmentFinancials,
  generateNextReceiptNumber,
  generateTransactionId,
  round2,
} = require('../services/feeService');
const { runReminderCheck } = require('../services/reminderService');

const router = express.Router();
router.use(authenticate);
router.use(requireRole('admin'));

// GET all transactions with rich filtering
router.get('/', async (req, res) => {
  try {
    const { studentId, paymentMethod, startDate, endDate, search } = req.query;
    const pool = getPool();

    let query = `
      SELECT t.*,
             s.fullName AS studentName, s.studentCode, s.phone AS studentPhone,
             c.name AS courseName,
             r.receiptNumber, r.previousBalance, r.remainingBalance
      FROM transactions t
      JOIN students s ON t.studentId = s.id
      JOIN enrollments e ON t.enrollmentId = e.id
      JOIN courses c ON e.courseId = c.id
      LEFT JOIN receipts r ON r.transactionId = t.id
      WHERE 1=1
    `;
    const params = [];

    if (studentId) {
      query += ' AND t.studentId = ?';
      params.push(studentId);
    }
    if (paymentMethod) {
      query += ' AND t.paymentMethod = ?';
      params.push(paymentMethod);
    }
    if (startDate) {
      query += ' AND t.paymentDate >= ?';
      params.push(startDate);
    }
    if (endDate) {
      query += ' AND t.paymentDate <= ?';
      params.push(endDate);
    }
    if (search) {
      const s = `%${String(search).trim().toLowerCase()}%`;
      query += ` AND (
        LOWER(t.transactionId) LIKE ? OR
        LOWER(COALESCE(r.receiptNumber, '')) LIKE ? OR
        LOWER(t.transactionReference) LIKE ? OR
        LOWER(s.fullName) LIKE ? OR
        LOWER(s.studentCode) LIKE ?
      )`;
      params.push(s, s, s, s, s);
    }

    query += ' ORDER BY t.paymentDate DESC, t.createdAt DESC';

    const [txns] = await pool.query(query, params);
    res.json(txns);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST record new payment (uses MySQL transaction + row locking to protect financial integrity)
router.post('/', async (req, res) => {
  try {
    const {
      studentId,
      amountPaid,
      paymentDate,
      paymentMethod,
      transactionReference,
      receivedByName,
      notes,
      isAdjustment,
      adjustmentReason,
    } = req.body || {};

    if (!studentId || !amountPaid || !paymentDate || !paymentMethod) {
      return res.status(400).json({
        error: 'Student, payment amount, payment date, and payment method are required.',
      });
    }

    const validMethods = ['Cash', 'Bank Transfer', 'Mobile Money', 'Other'];
    if (!validMethods.includes(paymentMethod)) {
      return res.status(400).json({ error: 'Invalid payment method.' });
    }

    const parsedAmount = round2(amountPaid);
    if (Number.isNaN(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({ error: 'Payment amount must be greater than 0 ETB.' });
    }

    const adjustmentFlag = Boolean(isAdjustment);
    if (adjustmentFlag && req.user.role !== 'admin') {
      return res.status(403).json({
        error: 'Only an Administrator can authorize an over-balance fee adjustment.',
      });
    }
    if (adjustmentFlag && (!adjustmentReason || String(adjustmentReason).trim().length < 4)) {
      return res.status(400).json({
        error: 'Please provide an explicit adjustment reason for an authorized over-balance payment.',
      });
    }

    const result = await withTransaction(async (conn) => {
      // Lock student's active enrollment row
      const [enrs] = await conn.query(
        `SELECT e.*, s.fullName, s.studentCode, s.phone, s.region, s.city, s.address,
                c.name AS courseName, c.code AS courseCode
         FROM enrollments e
         JOIN students s ON s.id = e.studentId
         JOIN courses c ON c.id = e.courseId
         WHERE e.studentId = ? AND e.enrollmentStatus != 'Archived'
         ORDER BY e.createdAt DESC
         LIMIT 1
         FOR UPDATE`,
        [studentId]
      );

      if (enrs.length === 0) {
        throw new Error('Active enrollment not found for this student.');
      }

      const enr = enrs[0];
      const [existingTxns] = await conn.query(
        'SELECT amountPaid FROM transactions WHERE enrollmentId = ?',
        [enr.id]
      );
      const previouslyPaid = round2(existingTxns.reduce((sum, t) => sum + Number(t.amountPaid), 0));
      const totalCourseFee = round2(enr.totalCourseFee);
      const previousBalance = round2(Math.max(0, totalCourseFee - previouslyPaid));

      if (!adjustmentFlag && previousBalance <= 0.009) {
        throw new Error('This student has already settled their full course fee.');
      }

      if (!adjustmentFlag && parsedAmount > previousBalance + 0.009) {
        throw new Error(
          `Amount (${parsedAmount.toFixed(2)} ETB) exceeds remaining balance (${previousBalance.toFixed(2)} ETB).`
        );
      }

      const newTotalPaid = round2(previouslyPaid + parsedAmount);
      const remainingBalance = round2(Math.max(0, totalCourseFee - newTotalPaid));

      const txnUuid = randomUUID();
      const transactionId = generateTransactionId();
      const receiverName = (receivedByName && String(receivedByName).trim()) || req.user.fullName;

      await conn.query(
        `INSERT INTO transactions
         (id, transactionId, studentId, enrollmentId, amountPaid, paymentDate, paymentMethod, transactionReference, receivedByUserId, receivedByName, isAdjustment, adjustmentReason, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          txnUuid,
          transactionId,
          studentId,
          enr.id,
          parsedAmount,
          String(paymentDate).slice(0, 10),
          paymentMethod,
          String(transactionReference || '').trim(),
          req.user.id,
          receiverName,
          adjustmentFlag ? 1 : 0,
          adjustmentFlag ? String(adjustmentReason).trim() : '',
          String(notes || '').trim(),
        ]
      );

      const receiptUuid = randomUUID();
      const receiptNumber = await generateNextReceiptNumber(conn);

      await conn.query(
        `INSERT INTO receipts
         (id, receiptNumber, transactionId, studentId, enrollmentId, amountPaid, previousBalance, remainingBalance, issuedBy)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          receiptUuid,
          receiptNumber,
          txnUuid,
          studentId,
          enr.id,
          parsedAmount,
          previousBalance,
          remainingBalance,
          receiverName,
        ]
      );

      // Mark unread notifications for this enrollment as read if fully paid
      if (remainingBalance <= 0.009) {
        await conn.query(
          'UPDATE notifications SET isRead = 1, readAt = NOW(), readByUserId = ? WHERE enrollmentId = ? AND isRead = 0',
          [req.user.id, enr.id]
        );
      }

      await recordAuditLog(
        {
          user: req.user,
          action: adjustmentFlag ? 'RECORD_PAYMENT_ADJUSTMENT' : 'RECORD_PAYMENT',
          entityType: 'transaction',
          entityId: txnUuid,
          details: {
            transactionId,
            receiptNumber,
            studentCode: enr.studentCode,
            studentName: enr.fullName,
            amountPaid: parsedAmount,
            paymentMethod,
            remainingBalance,
          },
          ipAddress: req.ip,
        },
        conn
      );

      // Fetch updated installments & financials
      const [installments] = await conn.query(
        'SELECT * FROM installments WHERE enrollmentId = ? ORDER BY installmentNumber ASC',
        [enr.id]
      );
      const [allTxns] = await conn.query(
        'SELECT * FROM transactions WHERE enrollmentId = ? ORDER BY paymentDate ASC, createdAt ASC',
        [enr.id]
      );
      const financials = computeEnrollmentFinancials(enr, installments, allTxns, getAddisTodayISO());

      return {
        id: txnUuid,
        transactionId,
        receiptNumber,
        studentId,
        studentName: enr.fullName,
        studentCode: enr.studentCode,
        courseName: enr.courseName,
        amountPaid: parsedAmount,
        previousBalance,
        remainingBalance,
        paymentDate: String(paymentDate).slice(0, 10),
        paymentMethod,
        transactionReference: String(transactionReference || '').trim(),
        receivedByName: receiverName,
        notes: String(notes || '').trim(),
        financials,
      };
    });

    runReminderCheck().catch(() => {});
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET printable receipt payload by transaction ID or receiptNumber
router.get('/:id/receipt', async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT r.*, t.transactionId AS txnCode, t.paymentDate, t.paymentMethod, t.transactionReference, t.notes,
              t.receivedByName, t.isAdjustment, t.adjustmentReason,
              s.fullName AS studentName, s.studentCode, s.phone AS studentPhone, s.region, s.city, s.address,
              c.name AS courseName, c.code AS courseCode,
              e.totalCourseFee
       FROM receipts r
       JOIN transactions t ON r.transactionId = t.id
       JOIN students s ON r.studentId = s.id
       JOIN enrollments e ON r.enrollmentId = e.id
       JOIN courses c ON e.courseId = c.id
       WHERE t.id = ? OR r.receiptNumber = ?
       LIMIT 1`,
      [req.params.id, req.params.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Receipt not found.' });
    }

    const [settingsRows] = await pool.query('SELECT settingKey, settingValue FROM settings');
    const settings = Object.fromEntries(settingsRows.map((r) => [r.settingKey, r.settingValue]));

    res.json({ receipt: rows[0], institute: settings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete transaction and linked receipt (ADMIN FULL PRIVILEGE — logs complete audit snapshot)
router.delete('/:id', requireRole('admin'), async (req, res) => {
  try {
    const deleted = await withTransaction(async (conn) => {
      const [rows] = await conn.query(
        'SELECT * FROM transactions WHERE id = ? LIMIT 1 FOR UPDATE',
        [req.params.id]
      );
      if (rows.length === 0) {
        const err = new Error('Transaction not found.');
        err.status = 404;
        throw err;
      }
      const txn = rows[0];

      await conn.query(
        'UPDATE payment_submissions SET approvedTransactionId = NULL, approvedReceiptId = NULL WHERE approvedTransactionId = ?',
        [txn.id]
      );
      await conn.query(
        'UPDATE registration_applications SET approvedTransactionId = NULL, approvedReceiptId = NULL WHERE approvedTransactionId = ?',
        [txn.id]
      );

      await conn.query('DELETE FROM receipts WHERE transactionId = ?', [txn.id]);
      await conn.query('DELETE FROM transactions WHERE id = ?', [txn.id]);

      await recordAuditLog(
        {
          user: req.user,
          action: 'DELETE_TRANSACTION',
          entityType: 'transaction',
          entityId: txn.id,
          previousValue: {
            transactionId: txn.transactionId,
            studentId: txn.studentId,
            amountPaid: Number(txn.amountPaid),
            paymentDate: txn.paymentDate,
            paymentMethod: txn.paymentMethod,
          },
          reason: String((req.body && req.body.reason) || 'Deleted by administrator').trim(),
          details: { transactionCode: txn.transactionId, amountPaid: Number(txn.amountPaid) },
          ipAddress: req.ip,
        },
        conn
      );

      return txn;
    });

    res.json({ message: `Transaction ${deleted.transactionId} deleted cleanly.` });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

module.exports = router;
