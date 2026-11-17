const express = require('express');
const { getPool } = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { getAddisTodayISO, getAddisMonthISO, addMonthsISO } = require('../utils/ethiopia');
const { computeEnrollmentFinancials, round2 } = require('../services/feeService');

const router = express.Router();
router.use(authenticate);

router.get('/stats', async (req, res) => {
  try {
    const pool = getPool();
    const todayISO = getAddisTodayISO();
    const monthISO = getAddisMonthISO();

    // ACCOUNTANT SCOPED DASHBOARD (zero admin-only revenue totals or other accountants' records)
    if (req.user.role === 'accountant') {
      const uid = req.user.id;
      const [myApps] = await pool.query(
        `SELECT ra.*, c.name AS courseName, c.code AS courseCode
         FROM registration_applications ra
         JOIN courses c ON c.id = ra.courseId
         WHERE ra.submittedByUserId = ?
         ORDER BY ra.createdAt DESC`,
        [uid]
      );
      const [myPayments] = await pool.query(
        `SELECT ps.*, s.fullName AS studentName, s.studentCode, c.name AS courseName
         FROM payment_submissions ps
         JOIN students s ON s.id = ps.studentId
         JOIN enrollments e ON e.id = ps.enrollmentId
         JOIN courses c ON c.id = e.courseId
         WHERE ps.submittedByUserId = ?
         ORDER BY ps.createdAt DESC`,
        [uid]
      );

      const approvedRegs = myApps.filter((a) => a.status === 'APPROVED');
      const pendingRegs = myApps.filter((a) => a.status === 'PENDING_ADMIN_APPROVAL');
      const correctionRegs = myApps.filter((a) => a.status === 'CORRECTION_REQUIRED');
      const rejectedRegs = myApps.filter((a) => a.status === 'REJECTED');

      const pendingPays = myPayments.filter((p) => p.status === 'PENDING');
      const approvedPays = myPayments.filter((p) => p.status === 'APPROVED');
      const rejectedPays = myPayments.filter((p) => p.status === 'REJECTED');

      const todaysRegs = myApps.filter((a) => String(a.createdAt).slice(0, 10) === todayISO || String(a.registrationDate).slice(0, 10) === todayISO);
      const todaysPays = myPayments.filter((p) => String(p.createdAt).slice(0, 10) === todayISO || String(p.paymentDate).slice(0, 10) === todayISO);

      return res.json({
        role: 'accountant',
        kpis: {
          studentsRegisteredByMe: approvedRegs.length,
          pendingRegistrations: pendingRegs.length,
          correctionRegistrations: correctionRegs.length,
          approvedRegistrations: approvedRegs.length,
          rejectedRegistrations: rejectedRegs.length,
          pendingPayments: pendingPays.length,
          approvedPayments: approvedPays.length,
          rejectedPayments: rejectedPays.length,
          todaysRegistrations: todaysRegs.length,
          todaysPayments: todaysPays.length,
          pendingPaymentsAmount: round2(pendingPays.reduce((s, p) => s + Number(p.amountSubmitted), 0)),
        },
        recentApplications: myApps.slice(0, 8),
        recentPayments: myPayments.slice(0, 8),
      });
    }

    // ADMINISTRATOR COMPLETE DASHBOARD
    const [students] = await pool.query('SELECT * FROM students');
    const [courses] = await pool.query('SELECT * FROM courses');
    const [enrollments] = await pool.query(`
      SELECT e.*, c.name AS courseName, c.code AS courseCode
      FROM enrollments e
      JOIN courses c ON e.courseId = c.id
      WHERE e.enrollmentStatus != 'Archived'
    `);
    const [installments] = await pool.query('SELECT * FROM installments ORDER BY installmentNumber ASC');
    // Strictly verified/approved transactions ONLY — pending payment_submissions are NEVER included
    const [transactions] = await pool.query('SELECT * FROM transactions ORDER BY paymentDate ASC, createdAt ASC');

    const [regApps] = await pool.query(`
      SELECT ra.*, c.name AS courseName, c.code AS courseCode
      FROM registration_applications ra
      JOIN courses c ON c.id = ra.courseId
      ORDER BY ra.createdAt DESC
    `);
    const [paySubs] = await pool.query(`
      SELECT ps.*, s.fullName AS studentName, s.studentCode, c.name AS courseName
      FROM payment_submissions ps
      JOIN students s ON s.id = ps.studentId
      JOIN enrollments e ON e.id = ps.enrollmentId
      JOIN courses c ON c.id = e.courseId
      ORDER BY ps.createdAt DESC
    `);

    // Attendance metrics (today & current month)
    const [todayAttRows] = await pool.query(
      'SELECT status, COUNT(*) AS cnt FROM attendance WHERE attendanceDate = ? GROUP BY status',
      [todayISO]
    );
    const todayAttMap = Object.fromEntries(todayAttRows.map((r) => [r.status, Number(r.cnt)]));
    const todayAttTotal = Object.values(todayAttMap).reduce((a, b) => a + b, 0);

    const [monthAttRows] = await pool.query(
      "SELECT status, COUNT(*) AS cnt FROM attendance WHERE to_char(attendanceDate, 'YYYY-MM') = ? GROUP BY status",
      [monthISO]
    );
    const monthAttMap = Object.fromEntries(monthAttRows.map((r) => [r.status, Number(r.cnt)]));
    const monthAttTotal = Object.values(monthAttMap).reduce((a, b) => a + b, 0);
    const monthAttPresentOrLate = (monthAttMap.PRESENT || 0) + (monthAttMap.LATE || 0);
    const monthlyAttendancePct = monthAttTotal > 0 ? Math.round((monthAttPresentOrLate / monthAttTotal) * 1000) / 10 : 0;

    const nonArchivedStudents = students.filter((s) => s.status !== 'Archived');
    const totalStudents = nonArchivedStudents.length;
    const activeStudents = nonArchivedStudents.filter((s) => s.status === 'Active').length;
    const graduatedStudents = nonArchivedStudents.filter((s) => s.status === 'Graduated').length;

    let totalExpectedFees = 0;
    let totalCollectedRevenue = round2(transactions.reduce((s, t) => s + Number(t.amountPaid || 0), 0));
    let totalOutstandingBalances = 0;
    let fullyPaidStudents = 0;
    let partiallyPaidStudents = 0;
    let unpaidStudents = 0;
    let overdueStudentsCount = 0;

    const courseDistributionMap = {};
    const outstandingList = [];
    const studentMap = Object.fromEntries(students.map((s) => [s.id, s]));

    for (const enr of enrollments) {
      const stu = studentMap[enr.studentId];
      if (!stu || stu.status === 'Archived') continue;

      const enrInsts = installments.filter((i) => i.enrollmentId === enr.id);
      const enrTxns = transactions.filter((t) => t.enrollmentId === enr.id);
      const fin = computeEnrollmentFinancials(enr, enrInsts, enrTxns, todayISO);

      totalExpectedFees = round2(totalExpectedFees + fin.totalCourseFee);
      totalOutstandingBalances = round2(totalOutstandingBalances + fin.remainingBalance);

      if (fin.paymentStatus === 'Paid') fullyPaidStudents++;
      else if (fin.paymentStatus === 'Partially Paid') partiallyPaidStudents++;
      else unpaidStudents++;

      if (fin.isOverdue) overdueStudentsCount++;

      if (!courseDistributionMap[enr.courseName]) {
        courseDistributionMap[enr.courseName] = {
          courseName: enr.courseName,
          studentCount: 0,
          expectedFee: 0,
          collected: 0,
          outstanding: 0,
        };
      }
      courseDistributionMap[enr.courseName].studentCount++;
      courseDistributionMap[enr.courseName].expectedFee = round2(courseDistributionMap[enr.courseName].expectedFee + fin.totalCourseFee);
      courseDistributionMap[enr.courseName].collected = round2(courseDistributionMap[enr.courseName].collected + fin.totalCashCollected);
      courseDistributionMap[enr.courseName].outstanding = round2(courseDistributionMap[enr.courseName].outstanding + fin.remainingBalance);

      if (fin.remainingBalance > 0.009) {
        outstandingList.push({
          studentId: stu.id,
          studentCode: stu.studentCode,
          fullName: stu.fullName,
          phone: stu.phone,
          courseName: enr.courseName,
          totalCourseFee: fin.totalCourseFee,
          totalPaid: fin.totalPaid,
          remainingBalance: fin.remainingBalance,
          nextDueDate: fin.nextDueDate,
          isOverdue: fin.isOverdue,
          overdueDays: fin.overdueDays,
          paymentStatus: fin.paymentStatus,
        });
      }
    }

    const paymentsCollectedToday = round2(
      transactions
        .filter((t) => String(t.paymentDate).slice(0, 10) === todayISO)
        .reduce((s, t) => s + Number(t.amountPaid), 0)
    );
    const paymentsCollectedThisMonth = round2(
      transactions
        .filter((t) => String(t.paymentDate).slice(0, 7) === monthISO)
        .reduce((s, t) => s + Number(t.amountPaid), 0)
    );

    const pendingRegistrationsCount = regApps.filter((a) => a.status === 'PENDING_ADMIN_APPROVAL').length;
    const correctionRegistrationsCount = regApps.filter((a) => a.status === 'CORRECTION_REQUIRED').length;
    const rejectedRegistrationsCount = regApps.filter((a) => a.status === 'REJECTED').length;

    const pendingPaySubs = paySubs.filter((p) => p.status === 'PENDING');
    const pendingPaymentApprovalsCount = pendingPaySubs.length;
    const pendingPaymentSubmissionsAmount = round2(pendingPaySubs.reduce((s, p) => s + Number(p.amountSubmitted || 0), 0));

    const monthlySeries = [];
    for (let offset = -5; offset <= 0; offset++) {
      const mDate = addMonthsISO(`${monthISO}-01`, offset);
      const ym = mDate.slice(0, 7);
      const labelDate = new Date(`${ym}-01T00:00:00Z`);
      const label = labelDate.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
      const sum = round2(
        transactions
          .filter((t) => String(t.paymentDate).slice(0, 7) === ym)
          .reduce((acc, t) => acc + Number(t.amountPaid), 0)
      );
      monthlySeries.push({ month: ym, label, collected: sum });
    }

    const [recentTransactions] = await pool.query(`
      SELECT t.id, t.transactionId, t.amountPaid, t.paymentDate, t.paymentMethod, t.transactionReference,
             t.receivedByName, t.createdAt,
             s.id AS studentId, s.fullName AS studentName, s.studentCode,
             c.name AS courseName,
             r.receiptNumber
      FROM transactions t
      JOIN students s ON t.studentId = s.id
      JOIN enrollments e ON t.enrollmentId = e.id
      JOIN courses c ON e.courseId = c.id
      LEFT JOIN receipts r ON r.transactionId = t.id
      ORDER BY t.createdAt DESC, t.paymentDate DESC
      LIMIT 8
    `);

    outstandingList.sort((a, b) => b.overdueDays - a.overdueDays || b.remainingBalance - a.remainingBalance);

    res.json({
      role: 'admin',
      kpis: {
        totalStudents,
        activeStudents,
        graduatedStudents,
        pendingRegistrationsCount,
        correctionRegistrationsCount,
        rejectedRegistrationsCount,
        pendingPaymentApprovalsCount,
        pendingPaymentSubmissionsAmount,
        totalCourses: courses.length,
        activeCourses: courses.filter((c) => c.status === 'Active').length,
        totalExpectedFees,
        totalCollectedPayments: totalCollectedRevenue,
        totalOutstandingBalances,
        fullyPaidStudents,
        partiallyPaidStudents,
        unpaidStudents,
        overdueStudentsCount,
        paymentsCollectedToday,
        paymentsCollectedThisMonth,
        todaysAttendanceMarked: todayAttTotal,
        todaysAttendancePresent: (todayAttMap.PRESENT || 0) + (todayAttMap.LATE || 0),
        monthlyAttendancePercentage: monthlyAttendancePct,
      },
      charts: {
        monthlyCollection: monthlySeries,
        paymentStatusDistribution: {
          fullyPaid: fullyPaidStudents,
          partiallyPaid: partiallyPaidStudents,
          unpaid: unpaidStudents,
          overdue: overdueStudentsCount,
        },
        courseDistribution: Object.values(courseDistributionMap).sort((a, b) => b.studentCount - a.studentCount),
      },
      outstandingPayments: outstandingList.slice(0, 10),
      recentTransactions,
      recentRegistrations: regApps.slice(0, 6),
      recentRejectedApplications: regApps.filter((a) => a.status === 'REJECTED' || a.status === 'CORRECTION_REQUIRED').slice(0, 6),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
