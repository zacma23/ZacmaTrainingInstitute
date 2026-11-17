const express = require('express');
const ExcelJS = require('exceljs');
const { getPool } = require('../config/db');
const { authenticate, requireRole } = require('../middleware/auth');
const { getAddisTodayISO, addDaysISO, escapeCsvCell } = require('../utils/ethiopia');
const { computeEnrollmentFinancials, round2 } = require('../services/feeService');

const router = express.Router();
router.use(authenticate);
router.use(requireRole('admin'));

async function buildReportData(reportType, queryParams = {}) {
  const pool = getPool();
  const todayISO = getAddisTodayISO();
  const { date, month, year, studentId } = queryParams;

  if (['daily', 'weekly', 'monthly', 'annual'].includes(reportType)) {
    let startDate = todayISO;
    let endDate = todayISO;
    let title = 'Daily Collection Report';

    if (reportType === 'daily') {
      startDate = date || todayISO;
      endDate = startDate;
      title = `Daily Collection Report (${startDate})`;
    } else if (reportType === 'weekly') {
      endDate = date || todayISO;
      startDate = addDaysISO(endDate, -6);
      title = `Weekly Collection Report (${startDate} to ${endDate})`;
    } else if (reportType === 'monthly') {
      const ym = month || todayISO.slice(0, 7);
      startDate = `${ym}-01`;
      endDate = `${ym}-31`;
      title = `Monthly Collection Report (${ym})`;
    } else if (reportType === 'annual') {
      const yr = year || todayISO.slice(0, 4);
      startDate = `${yr}-01-01`;
      endDate = `${yr}-12-31`;
      title = `Annual Collection Report (${yr})`;
    }

    const [rows] = await pool.query(
      `SELECT t.transactionId, r.receiptNumber, t.paymentDate, s.studentCode, s.fullName AS studentName,
              c.name AS courseName, t.paymentMethod, t.transactionReference, t.amountPaid, t.receivedByName
       FROM transactions t
       JOIN students s ON t.studentId = s.id
       JOIN enrollments e ON t.enrollmentId = e.id
       JOIN courses c ON e.courseId = c.id
       LEFT JOIN receipts r ON r.transactionId = t.id
       WHERE t.paymentDate >= ? AND t.paymentDate <= ?
       ORDER BY t.paymentDate DESC, t.createdAt DESC`,
      [startDate, endDate]
    );

    const totalCollected = round2(rows.reduce((s, r) => s + Number(r.amountPaid), 0));

    return {
      title,
      columns: ['Txn ID', 'Receipt No', 'Date', 'Student ID', 'Student Name', 'Course', 'Method', 'Reference', 'Amount (ETB)', 'Received By'],
      rows: rows.map((r) => [
        r.transactionId,
        r.receiptNumber || '—',
        String(r.paymentDate).slice(0, 10),
        r.studentCode,
        r.studentName,
        r.courseName,
        r.paymentMethod,
        r.transactionReference || '—',
        Number(r.amountPaid).toFixed(2),
        r.receivedByName,
      ]),
      summary: { totalRecords: rows.length, totalAmountETB: totalCollected },
    };
  }

  if (reportType === 'outstanding' || reportType === 'overdue') {
    const [enrollments] = await pool.query(`
      SELECT e.*, s.studentCode, s.fullName, s.phone, s.status AS studentStatus,
             c.name AS courseName, pp.name AS paymentPlanName
      FROM enrollments e
      JOIN students s ON e.studentId = s.id
      JOIN courses c ON e.courseId = c.id
      JOIN payment_plans pp ON e.paymentPlanId = pp.id
      WHERE e.enrollmentStatus != 'Archived' AND s.status != 'Archived'
    `);
    const [allInsts] = await pool.query('SELECT * FROM installments ORDER BY installmentNumber ASC');
    const [allTxns] = await pool.query('SELECT * FROM transactions ORDER BY paymentDate ASC, createdAt ASC');

    let list = enrollments.map((enr) => {
      const fin = computeEnrollmentFinancials(
        enr,
        allInsts.filter((i) => i.enrollmentId === enr.id),
        allTxns.filter((t) => t.enrollmentId === enr.id),
        todayISO
      );
      return { enr, fin };
    });

    if (reportType === 'outstanding') {
      list = list.filter((x) => x.fin.remainingBalance > 0.009);
    } else {
      list = list.filter((x) => x.fin.isOverdue);
    }

    list.sort((a, b) => b.fin.overdueDays - a.fin.overdueDays || b.fin.remainingBalance - a.fin.remainingBalance);
    const totalOutstanding = round2(list.reduce((s, x) => s + x.fin.remainingBalance, 0));

    return {
      title: reportType === 'overdue' ? 'Overdue Students Report' : 'Outstanding Balance Report',
      columns: ['Student ID', 'Full Name', 'Phone', 'Course', 'Plan', 'Total Fee (ETB)', 'Paid (ETB)', 'Balance (ETB)', 'Next Due Date', 'Overdue Days', 'Status'],
      rows: list.map(({ enr, fin }) => [
        enr.studentCode,
        enr.fullName,
        enr.phone,
        enr.courseName,
        enr.paymentPlanName,
        fin.totalCourseFee.toFixed(2),
        fin.totalPaid.toFixed(2),
        fin.remainingBalance.toFixed(2),
        fin.nextDueDate || '—',
        String(fin.overdueDays),
        fin.isOverdue ? 'Overdue' : fin.paymentStatus,
      ]),
      summary: { totalRecords: list.length, totalAmountETB: totalOutstanding },
    };
  }

  if (reportType === 'course-revenue') {
    const [rows] = await pool.query(`
      SELECT c.code, c.name AS courseName, c.defaultFee,
             COUNT(DISTINCT CASE WHEN s.status != 'Archived' THEN e.id END) AS totalEnrollments,
             COALESCE(SUM(CASE WHEN s.status != 'Archived' THEN e.totalCourseFee ELSE 0 END), 0) AS expectedRevenue
      FROM courses c
      LEFT JOIN enrollments e ON e.courseId = c.id AND e.enrollmentStatus != 'Archived'
      LEFT JOIN students s ON s.id = e.studentId
      GROUP BY c.id, c.code, c.name, c.defaultFee
      ORDER BY expectedRevenue DESC
    `);

    const [paidByCourse] = await pool.query(`
      SELECT e.courseId, c.name AS courseName, COALESCE(SUM(t.amountPaid), 0) AS collectedRevenue
      FROM transactions t
      JOIN enrollments e ON t.enrollmentId = e.id
      JOIN courses c ON e.courseId = c.id
      GROUP BY e.courseId, c.name
    `);
    const paidMap = Object.fromEntries(paidByCourse.map((p) => [p.courseName, Number(p.collectedRevenue)]));

    let totalCollected = 0;
    const formattedRows = rows.map((r) => {
      const expected = Number(r.expectedRevenue || 0);
      const collected = paidMap[r.courseName] || 0;
      const outstanding = Math.max(0, expected - collected);
      totalCollected = round2(totalCollected + collected);
      return [
        r.code,
        r.courseName,
        String(r.totalEnrollments),
        Number(r.defaultFee).toFixed(2),
        expected.toFixed(2),
        collected.toFixed(2),
        outstanding.toFixed(2),
      ];
    });

    return {
      title: 'Course-Wise Revenue Report',
      columns: ['Course Code', 'Course Name', 'Enrollments', 'Standard Fee (ETB)', 'Expected Revenue (ETB)', 'Collected (ETB)', 'Outstanding (ETB)'],
      rows: formattedRows,
      summary: { totalRecords: formattedRows.length, totalAmountETB: totalCollected },
    };
  }

  if (reportType === 'payment-methods') {
    const [rows] = await pool.query(`
      SELECT paymentMethod, COUNT(*) AS txnCount, COALESCE(SUM(amountPaid), 0) AS totalAmount,
             MIN(paymentDate) AS firstDate, MAX(paymentDate) AS lastDate
      FROM transactions
      GROUP BY paymentMethod
      ORDER BY totalAmount DESC
    `);
    const totalCollected = round2(rows.reduce((s, r) => s + Number(r.totalAmount), 0));

    return {
      title: 'Payment Method Breakdown Report',
      columns: ['Payment Method', 'Transaction Count', 'Total Collected (ETB)', 'Share (%)', 'Earliest Payment', 'Latest Payment'],
      rows: rows.map((r) => {
        const amt = Number(r.totalAmount);
        const pct = totalCollected > 0 ? ((amt / totalCollected) * 100).toFixed(1) : '0.0';
        return [
          r.paymentMethod,
          String(r.txnCount),
          amt.toFixed(2),
          `${pct}%`,
          r.firstDate ? String(r.firstDate).slice(0, 10) : '—',
          r.lastDate ? String(r.lastDate).slice(0, 10) : '—',
        ];
      }),
      summary: { totalRecords: rows.length, totalAmountETB: totalCollected },
    };
  }

  if (reportType === 'student-history') {
    let query = `
      SELECT t.transactionId, r.receiptNumber, t.paymentDate, s.studentCode, s.fullName AS studentName,
             c.name AS courseName, t.paymentMethod, t.transactionReference, t.amountPaid, t.receivedByName, t.notes
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
    query += ' ORDER BY s.fullName ASC, t.paymentDate DESC';

    const [rows] = await pool.query(query, params);
    const totalCollected = round2(rows.reduce((s, r) => s + Number(r.amountPaid), 0));

    return {
      title: 'Student Payment History Report',
      columns: ['Txn ID', 'Receipt No', 'Date', 'Student ID', 'Student Name', 'Course', 'Method', 'Reference', 'Amount (ETB)', 'Received By', 'Notes'],
      rows: rows.map((r) => [
        r.transactionId,
        r.receiptNumber || '—',
        String(r.paymentDate).slice(0, 10),
        r.studentCode,
        r.studentName,
        r.courseName,
        r.paymentMethod,
        r.transactionReference || '—',
        Number(r.amountPaid).toFixed(2),
        r.receivedByName,
        r.notes || '—',
      ]),
      summary: { totalRecords: rows.length, totalAmountETB: totalCollected },
    };
  }

  if (reportType === 'attendance') {
    const { courseId, month } = queryParams;
    let where = "WHERE s.status != 'Archived'";
    const params = [];
    if (courseId) {
      where += ' AND a.courseId = ?';
      params.push(courseId);
    }
    if (month) {
      where += " AND DATE_FORMAT(a.attendanceDate, '%Y-%m') = ?";
      params.push(String(month).slice(0, 7));
    }

    const [rows] = await pool.query(
      `SELECT s.studentCode, s.fullName AS studentName, c.name AS courseName,
              COUNT(*) AS totalDays,
              SUM(CASE WHEN a.status IN ('PRESENT', 'LATE') THEN 1 ELSE 0 END) AS daysPresent,
              SUM(CASE WHEN a.status = 'ABSENT' THEN 1 ELSE 0 END) AS daysAbsent,
              SUM(CASE WHEN a.status = 'LATE' THEN 1 ELSE 0 END) AS daysLate,
              SUM(CASE WHEN a.status = 'EXCUSED' THEN 1 ELSE 0 END) AS daysExcused
       FROM attendance a
       JOIN students s ON s.id = a.studentId
       JOIN courses c ON c.id = a.courseId
       ${where}
       GROUP BY s.id, s.studentCode, s.fullName, c.id, c.name
       ORDER BY s.fullName ASC`,
      params
    );

    const formatted = rows.map((r) => {
      const total = Number(r.totalDays || 0);
      const present = Number(r.daysPresent || 0);
      const pct = total > 0 ? ((present / total) * 100).toFixed(1) + '%' : '0.0%';
      return [
        r.studentCode,
        r.studentName,
        r.courseName,
        String(total),
        String(present),
        String(r.daysAbsent || 0),
        String(r.daysLate || 0),
        String(r.daysExcused || 0),
        pct,
      ];
    });

    return {
      title: month ? `Student Attendance Report (${month})` : 'Student Attendance Report',
      columns: ['Student ID', 'Student Name', 'Course', 'Total Training Days', 'Days Present', 'Days Absent', 'Late', 'Excused', 'Attendance %'],
      rows: formatted,
      summary: { totalRecords: formatted.length, totalAmountETB: 0 },
    };
  }

  throw new Error(`Unsupported report type: ${reportType}`);
}

router.get('/:type', async (req, res) => {
  try {
    const data = await buildReportData(req.params.type, req.query);
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/:type/export', async (req, res) => {
  try {
    const format = (req.query.format || 'csv').toLowerCase();
    const data = await buildReportData(req.params.type, req.query);
    const safeName = req.params.type.replace(/[^a-z0-9-]/gi, '_');

    if (format === 'xlsx') {
      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'BirrLedger Student Fee Management';
      workbook.created = new Date();
      const sheet = workbook.addWorksheet(safeName.slice(0, 30));

      sheet.addRow([data.title]);
      sheet.addRow([`Generated: ${getAddisTodayISO()} (EAT)`]);
      sheet.addRow([]);
      const headerRow = sheet.addRow(data.columns);
      headerRow.font = { bold: true };
      for (const row of data.rows) {
        sheet.addRow(row);
      }

      sheet.columns.forEach((col) => {
        col.width = 18;
      });

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}_report.xlsx"`);
      await workbook.xlsx.write(res);
      return res.end();
    }

    // Default: CSV
    const lines = [
      data.columns.map(escapeCsvCell).join(','),
      ...data.rows.map((r) => r.map(escapeCsvCell).join(',')),
    ];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}_report.csv"`);
    res.send('\uFEFF' + lines.join('\n'));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
