const express = require('express');
const { randomUUID } = require('crypto');
const { getPool, withTransaction } = require('../config/db');
const { authenticate, requireRole, recordAuditLog } = require('../middleware/auth');
const { getAddisTodayISO } = require('../utils/ethiopia');
const { computeEnrollmentFinancials, round2 } = require('../services/feeService');
const { runReminderCheck } = require('../services/reminderService');

const router = express.Router();
router.use(authenticate);
router.use(requireRole('admin'));

// GET global installment tracker across all active students
router.get('/', async (req, res) => {
  try {
    const { status, courseId, search } = req.query;
    const pool = getPool();
    const todayISO = getAddisTodayISO();

    let query = `
      SELECT e.*, s.fullName, s.studentCode, s.phone, s.status AS studentStatus,
             c.name AS courseName, pp.name AS paymentPlanName
      FROM enrollments e
      JOIN students s ON s.id = e.studentId
      JOIN courses c ON c.id = e.courseId
      JOIN payment_plans pp ON pp.id = e.paymentPlanId
      WHERE e.enrollmentStatus != 'Archived' AND s.status != 'Archived'
    `;
    const params = [];
    if (courseId) {
      query += ' AND e.courseId = ?';
      params.push(courseId);
    }
    if (search) {
      const s = `%${String(search).trim().toLowerCase()}%`;
      query += ' AND (LOWER(s.fullName) LIKE ? OR LOWER(s.studentCode) LIKE ? OR LOWER(s.phone) LIKE ?)';
      params.push(s, s, s);
    }

    const [enrollments] = await pool.query(query, params);
    const [allInstallments] = await pool.query('SELECT * FROM installments ORDER BY installmentNumber ASC');
    const [allTransactions] = await pool.query('SELECT * FROM transactions ORDER BY paymentDate ASC, createdAt ASC');

    let items = [];
    for (const enr of enrollments) {
      const insts = allInstallments.filter((i) => i.enrollmentId === enr.id);
      const txns = allTransactions.filter((t) => t.enrollmentId === enr.id);
      const fin = computeEnrollmentFinancials(enr, insts, txns, todayISO);

      for (const inst of fin.installments) {
        items.push({
          ...inst,
          studentName: enr.fullName,
          studentCode: enr.studentCode,
          phone: enr.phone,
          courseName: enr.courseName,
          paymentPlanName: enr.paymentPlanName,
          totalCourseFee: fin.totalCourseFee,
          enrollmentRemaining: fin.remainingBalance,
        });
      }
    }

    if (status) {
      if (status === 'Overdue') items = items.filter((i) => i.status === 'Overdue');
      else if (status === 'Due Today') items = items.filter((i) => i.status.startsWith('Due Today'));
      else if (status === 'Due Soon') items = items.filter((i) => i.status.startsWith('Due Soon'));
      else if (status === 'Paid') items = items.filter((i) => i.status === 'Paid');
      else if (status === 'Unpaid') items = items.filter((i) => i.remainingAmount > 0);
    }

    items.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.installmentNumber - b.installmentNumber);
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT adjust installment schedule for an enrollment (Admin only)
router.put('/enrollment/:enrollmentId', requireRole('admin'), async (req, res) => {
  try {
    const { installments, reason } = req.body || {};
    if (!Array.isArray(installments) || installments.length === 0) {
      return res.status(400).json({ error: 'At least one installment row is required.' });
    }

    await withTransaction(async (conn) => {
      const [enrs] = await conn.query('SELECT * FROM enrollments WHERE id = ? LIMIT 1', [req.params.enrollmentId]);
      if (enrs.length === 0) throw new Error('Enrollment not found.');
      const enr = enrs[0];

      const totalFee = round2(enr.totalCourseFee);
      let newSum = 0;

      const normalized = installments.map((row, idx) => {
        const expected = round2(row.expectedAmount);
        if (Number.isNaN(expected) || expected <= 0) {
          throw new Error(`Installment #${idx + 1} expected amount must be greater than 0.`);
        }
        if (!row.dueDate) {
          throw new Error(`Installment #${idx + 1} due date is required.`);
        }
        newSum = round2(newSum + expected);
        return {
          id: randomUUID(),
          enrollmentId: enr.id,
          studentId: enr.studentId,
          installmentNumber: idx + 1,
          title: String(row.title || `Installment ${idx + 1}`).trim(),
          expectedAmount: expected,
          dueDate: String(row.dueDate).slice(0, 10),
          notes: String(row.notes || '').trim(),
        };
      });

      if (Math.abs(newSum - totalFee) > 0.01) {
        throw new Error(
          `Adjusted installments sum (${newSum.toFixed(2)} ETB) must equal total course fee (${totalFee.toFixed(2)} ETB).`
        );
      }

      await conn.query('DELETE FROM installments WHERE enrollmentId = ?', [enr.id]);
      for (const item of normalized) {
        await conn.query(
          `INSERT INTO installments (id, enrollmentId, studentId, installmentNumber, title, expectedAmount, dueDate, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [item.id, item.enrollmentId, item.studentId, item.installmentNumber, item.title, item.expectedAmount, item.dueDate, item.notes]
        );
      }

      // Update assignedDueDate to earliest installment due date
      await conn.query('UPDATE enrollments SET assignedDueDate = ? WHERE id = ?', [normalized[0].dueDate, enr.id]);

      await recordAuditLog(
        {
          user: req.user,
          action: 'ADJUST_INSTALLMENTS',
          entityType: 'enrollment',
          entityId: enr.id,
          details: { studentId: enr.studentId, count: normalized.length, reason: reason || 'Admin schedule adjustment' },
          ipAddress: req.ip,
        },
        conn
      );
    });

    runReminderCheck().catch(() => {});
    res.json({ message: 'Installment schedule adjusted successfully.' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
