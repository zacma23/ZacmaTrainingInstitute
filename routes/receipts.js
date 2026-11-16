const express = require('express');
const { getPool } = require('../config/db');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);
router.use(requireRole('admin'));

// GET official issued receipts directory (ADMIN ONLY)
router.get('/', async (req, res) => {
  try {
    const { search, startDate, endDate } = req.query;
    const pool = getPool();

    let query = `
      SELECT r.*,
             t.transactionId AS txnCode, t.paymentDate, t.paymentMethod, t.transactionReference,
             t.receivedByName, t.paymentCategory,
             s.fullName AS studentName, s.studentCode, s.phone AS studentPhone,
             c.name AS courseName, c.code AS courseCode
      FROM receipts r
      JOIN transactions t ON t.id = r.transactionId
      JOIN students s ON s.id = r.studentId
      JOIN enrollments e ON e.id = r.enrollmentId
      JOIN courses c ON c.id = e.courseId
      WHERE 1=1
    `;
    const params = [];

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
        LOWER(r.receiptNumber) LIKE ? OR
        LOWER(t.transactionId) LIKE ? OR
        LOWER(s.fullName) LIKE ? OR
        LOWER(s.studentCode) LIKE ?
      )`;
      params.push(s, s, s, s);
    }

    query += ' ORDER BY r.issuedAt DESC';
    const [rows] = await pool.query(query, params);
    res.json(
      rows.map((r) => ({
        ...r,
        amountPaid: Number(r.amountPaid),
        previousBalance: Number(r.previousBalance),
        remainingBalance: Number(r.remainingBalance),
      }))
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
