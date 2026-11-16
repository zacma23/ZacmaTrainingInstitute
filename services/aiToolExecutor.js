const { getPool } = require('../config/db');
const { computeEnrollmentFinancials } = require('./feeService');
const { getAddisTodayISO } = require('../utils/ethiopia');

async function buildAssistantContext(user) {
  const pool = getPool();

  const [settingRows] = await pool.query(
    "SELECT settingKey, settingValue FROM settings WHERE settingKey IN ('instituteName', 'instituteShortName')"
  );
  const settingsMap = Object.fromEntries(settingRows.map((r) => [r.settingKey, r.settingValue]));
  const instituteName = settingsMap.instituteName || 'Zacma Technology Institute';

  const [courses] = await pool.query(
    "SELECT code, name, durationValue, durationUnit, registrationFee, defaultFee FROM courses WHERE status = 'Active' ORDER BY name ASC LIMIT 25"
  );
  const coursesSummary = courses
    .map(
      (c) =>
        `- ${c.code} ${c.name} (${c.durationValue} ${c.durationUnit}): Tuition ${Number(c.defaultFee).toLocaleString()} ETB, Registration ${Number(c.registrationFee).toLocaleString()} ETB`
    )
    .join('\n');

  let statsSummary = '';
  if (user.role === 'admin') {
    const [[stAgg]] = await pool.query(
      "SELECT COUNT(*) AS totalStudents, SUM(CASE WHEN status = 'Active' THEN 1 ELSE 0 END) AS activeStudents FROM students WHERE status != 'Archived'"
    );
    const [[payAgg]] = await pool.query(
      "SELECT COALESCE(SUM(totalCourseFee), 0) AS expectedTotal FROM enrollments WHERE enrollmentStatus != 'Archived'"
    );
    const [[txAgg]] = await pool.query('SELECT COALESCE(SUM(amountPaid), 0) AS collectedTotal FROM transactions');
    const [[appPending]] = await pool.query(
      "SELECT COUNT(*) AS cnt FROM registration_applications WHERE status = 'PENDING_ADMIN_APPROVAL'"
    );
    const [[payPending]] = await pool.query(
      "SELECT COUNT(*) AS cnt FROM payment_submissions WHERE status = 'PENDING'"
    );
    statsSummary = [
      `Active Students: ${stAgg.activeStudents || 0} (Total non-archived: ${stAgg.totalStudents || 0})`,
      `Expected Tuition: ${Number(payAgg.expectedTotal || 0).toLocaleString()} ETB | Approved Collected: ${Number(txAgg.collectedTotal || 0).toLocaleString()} ETB`,
      `Pending Admin Approvals: ${appPending.cnt || 0} registrations, ${payPending.cnt || 0} payment submissions`,
    ].join('\n');
  }

  return {
    instituteName,
    userRole: user.role,
    coursesSummary,
    statsSummary,
  };
}

async function executeAssistantTool(toolName, args = {}, user) {
  const pool = getPool();
  const todayISO = getAddisTodayISO();

  if (toolName === 'search_students') {
    const q = String(args.query || '').trim().toLowerCase();
    const payFilter = String(args.paymentStatus || '').trim();

    let sql = `
      SELECT s.id, s.studentCode, s.fullName, s.phone, s.nationalIdNumber, s.status,
             e.id AS enrollmentId, e.totalCourseFee, e.assignedDueDate, c.name AS courseName
      FROM students s
      LEFT JOIN enrollments e ON e.studentId = s.id AND e.enrollmentStatus != 'Archived'
      LEFT JOIN courses c ON c.id = e.courseId
      WHERE s.status != 'Archived'
    `;
    const params = [];
    if (q) {
      const like = `%${q}%`;
      sql += ' AND (LOWER(s.fullName) LIKE ? OR LOWER(s.studentCode) LIKE ? OR LOWER(s.phone) LIKE ? OR LOWER(s.nationalIdNumber) LIKE ?)';
      params.push(like, like, like, like);
    }
    sql += ' ORDER BY s.createdAt DESC LIMIT 30';

    const [rows] = await pool.query(sql, params);
    const enrIds = rows.map((r) => r.enrollmentId).filter(Boolean);
    const [insts] = enrIds.length
      ? await pool.query('SELECT * FROM installments WHERE enrollmentId IN (?) ORDER BY installmentNumber ASC', [enrIds])
      : [[]];
    const [txns] = enrIds.length
      ? await pool.query('SELECT * FROM transactions WHERE enrollmentId IN (?) ORDER BY paymentDate ASC, createdAt ASC', [enrIds])
      : [[]];

    let mapped = rows.map((r) => {
      const fin = r.enrollmentId
        ? computeEnrollmentFinancials(
            { id: r.enrollmentId, totalCourseFee: Number(r.totalCourseFee || 0), assignedDueDate: r.assignedDueDate },
            insts.filter((i) => i.enrollmentId === r.enrollmentId),
            txns.filter((t) => t.enrollmentId === r.enrollmentId),
            todayISO
          )
        : { totalCourseFee: 0, totalPaid: 0, remainingBalance: 0, paymentStatus: 'Unpaid', isOverdue: false, overdueDays: 0 };

      return {
        studentCode: r.studentCode,
        fullName: r.fullName,
        phone: r.phone,
        nationalIdNumber: r.nationalIdNumber || '',
        status: r.status,
        courseName: r.courseName || 'Unassigned',
        totalCourseFee: fin.totalCourseFee,
        totalPaid: fin.totalPaid,
        remainingBalance: fin.remainingBalance,
        paymentStatus: fin.paymentStatus,
        isOverdue: fin.isOverdue,
        overdueDays: fin.overdueDays,
      };
    });

    if (payFilter) {
      if (payFilter.toLowerCase() === 'overdue') mapped = mapped.filter((m) => m.isOverdue);
      else mapped = mapped.filter((m) => m.paymentStatus.toLowerCase() === payFilter.toLowerCase());
    }

    return { count: mapped.length, students: mapped.slice(0, 12) };
  }

  if (toolName === 'get_student_financial_summary') {
    const idf = String(args.identifier || '').trim().toLowerCase();
    if (!idf) return { error: 'Student identifier is required.' };
    const like = `%${idf}%`;
    const [rows] = await pool.query(
      `SELECT s.*, e.id AS enrollmentId, e.totalCourseFee, e.assignedDueDate, c.name AS courseName, pp.name AS paymentPlanName
       FROM students s
       LEFT JOIN enrollments e ON e.studentId = s.id AND e.enrollmentStatus != 'Archived'
       LEFT JOIN courses c ON c.id = e.courseId
       LEFT JOIN payment_plans pp ON pp.id = e.paymentPlanId
       WHERE s.status != 'Archived' AND (LOWER(s.studentCode) LIKE ? OR LOWER(s.fullName) LIKE ? OR LOWER(s.nationalIdNumber) LIKE ?)
       LIMIT 1`,
      [like, like, like]
    );
    if (rows.length === 0) return { found: false, message: 'No matching student found.' };
    const s = rows[0];
    const [insts] = s.enrollmentId
      ? await pool.query('SELECT * FROM installments WHERE enrollmentId = ? ORDER BY installmentNumber ASC', [s.enrollmentId])
      : [[]];
    const [txns] = s.enrollmentId
      ? await pool.query('SELECT * FROM transactions WHERE enrollmentId = ? ORDER BY paymentDate ASC, createdAt ASC', [s.enrollmentId])
      : [[]];

    const fin = s.enrollmentId
      ? computeEnrollmentFinancials(
          { id: s.enrollmentId, totalCourseFee: Number(s.totalCourseFee || 0), assignedDueDate: s.assignedDueDate },
          insts,
          txns,
          todayISO
        )
      : { totalCourseFee: 0, totalPaid: 0, remainingBalance: 0, paymentStatus: 'Unpaid', isOverdue: false, overdueDays: 0, installments: [] };

    return {
      found: true,
      studentCode: s.studentCode,
      fullName: s.fullName,
      phone: s.phone,
      nationalIdNumber: s.nationalIdNumber || '',
      courseName: s.courseName,
      paymentPlanName: s.paymentPlanName,
      status: s.status,
      totalCourseFee: fin.totalCourseFee,
      totalPaid: fin.totalPaid,
      remainingBalance: fin.remainingBalance,
      paymentStatus: fin.paymentStatus,
      isOverdue: fin.isOverdue,
      overdueDays: fin.overdueDays,
      nextDueDate: fin.nextDueDate,
      nextDueAmount: fin.nextDueAmount,
      installments: (fin.installments || []).map((i) => ({
        title: i.title,
        dueDate: String(i.dueDate).slice(0, 10),
        expectedAmount: i.expectedAmount,
        remainingAmount: i.remainingAmount,
        status: i.status,
      })),
    };
  }

  if (toolName === 'list_courses_and_plans') {
    const cat = String(args.category || '').trim().toLowerCase();
    const [courses] = await pool.query(
      `SELECT c.code, c.name, c.category, c.durationValue, c.durationUnit, c.registrationFee, c.defaultFee, c.availablePlans, c.maxCapacity,
              (SELECT COUNT(*) FROM enrollments e WHERE e.courseId = c.id AND e.enrollmentStatus = 'Active') AS activeEnrolled
       FROM courses c
       WHERE c.status = 'Active'
       ORDER BY c.name ASC`
    );
    const filtered = cat ? courses.filter((c) => c.category.toLowerCase().includes(cat)) : courses;
    return {
      count: filtered.length,
      courses: filtered.map((c) => ({
        code: c.code,
        name: c.name,
        category: c.category,
        duration: `${c.durationValue} ${c.durationUnit}`,
        registrationFee: Number(c.registrationFee),
        tuitionFee: Number(c.defaultFee),
        activeEnrolled: Number(c.activeEnrolled || 0),
        maxCapacity: Number(c.maxCapacity || 0),
        availablePlans: typeof c.availablePlans === 'string' ? JSON.parse(c.availablePlans) : c.availablePlans,
      })),
    };
  }

  if (toolName === 'get_pending_queues') {
    const limitVal = Math.min(20, Math.max(1, Number(args.limit || 10)));
    const isAdmin = user.role === 'admin';

    const appSql = isAdmin
      ? `SELECT ra.applicationNumber, ra.fullName, ra.phone, ra.totalInitialSubmitted, ra.status, ra.submittedByName, c.name AS courseName
         FROM registration_applications ra JOIN courses c ON c.id = ra.courseId
         WHERE ra.status IN ('PENDING_ADMIN_APPROVAL', 'CORRECTION_REQUIRED')
         ORDER BY ra.createdAt DESC LIMIT ?`
      : `SELECT ra.applicationNumber, ra.fullName, ra.phone, ra.totalInitialSubmitted, ra.status, ra.adminComment, c.name AS courseName
         FROM registration_applications ra JOIN courses c ON c.id = ra.courseId
         WHERE ra.submittedByUserId = ? AND ra.status IN ('PENDING_ADMIN_APPROVAL', 'CORRECTION_REQUIRED', 'REJECTED')
         ORDER BY ra.createdAt DESC LIMIT ?`;
    const [apps] = await pool.query(appSql, isAdmin ? [limitVal] : [user.id, limitVal]);

    const paySql = isAdmin
      ? `SELECT ps.submissionRef, ps.amountSubmitted, ps.paymentMethod, ps.status, ps.submittedByName, s.fullName AS studentName, s.studentCode
         FROM payment_submissions ps JOIN students s ON s.id = ps.studentId
         WHERE ps.status = 'PENDING' ORDER BY ps.createdAt DESC LIMIT ?`
      : `SELECT ps.submissionRef, ps.amountSubmitted, ps.paymentMethod, ps.status, ps.rejectionReason, s.fullName AS studentName, s.studentCode
         FROM payment_submissions ps JOIN students s ON s.id = ps.studentId
         WHERE ps.submittedByUserId = ? AND ps.status IN ('PENDING', 'REJECTED') ORDER BY ps.createdAt DESC LIMIT ?`;
    const [pays] = await pool.query(paySql, isAdmin ? [limitVal] : [user.id, limitVal]);

    return {
      scope: isAdmin ? 'ALL_INSTITUTE' : 'OWN_SUBMISSIONS_ONLY',
      pendingRegistrations: apps,
      pendingPayments: pays,
    };
  }

  if (toolName === 'get_overdue_summary') {
    if (user.role !== 'admin') {
      return { accessDenied: true, reason: 'Overdue portfolio details are restricted to Administrators.' };
    }
    const limitVal = Math.min(25, Math.max(1, Number(args.limit || 10)));
    const [rows] = await pool.query(
      `SELECT s.studentCode, s.fullName, s.phone, e.id AS enrollmentId, e.totalCourseFee, e.assignedDueDate, c.name AS courseName
       FROM students s
       JOIN enrollments e ON e.studentId = s.id AND e.enrollmentStatus = 'Active'
       JOIN courses c ON c.id = e.courseId
       WHERE s.status = 'Active'`
    );
    const [insts] = await pool.query('SELECT * FROM installments ORDER BY installmentNumber ASC');
    const [txns] = await pool.query('SELECT * FROM transactions ORDER BY paymentDate ASC, createdAt ASC');

    const overdueList = rows
      .map((r) => {
        const fin = computeEnrollmentFinancials(
          { id: r.enrollmentId, totalCourseFee: Number(r.totalCourseFee || 0), assignedDueDate: r.assignedDueDate },
          insts.filter((i) => i.enrollmentId === r.enrollmentId),
          txns.filter((t) => t.enrollmentId === r.enrollmentId),
          todayISO
        );
        return {
          studentCode: r.studentCode,
          fullName: r.fullName,
          phone: r.phone,
          courseName: r.courseName,
          remainingBalance: fin.remainingBalance,
          overdueDays: fin.overdueDays,
          nextDueDate: fin.nextDueDate,
          isOverdue: fin.isOverdue,
        };
      })
      .filter((x) => x.isOverdue && x.remainingBalance > 0)
      .sort((a, b) => b.overdueDays - a.overdueDays)
      .slice(0, limitVal);

    return { overdueCount: overdueList.length, students: overdueList };
  }

  if (toolName === 'get_institute_kpis') {
    if (user.role !== 'admin') {
      return { accessDenied: true, reason: 'Global financial KPIs are restricted to Administrators.' };
    }
    const [[stAgg]] = await pool.query(
      "SELECT COUNT(*) AS total, SUM(status = 'Active') AS active, SUM(status = 'Graduated') AS graduated, SUM(status = 'Suspended') AS suspended FROM students WHERE status != 'Archived'"
    );
    const [[feeAgg]] = await pool.query(
      "SELECT COALESCE(SUM(totalCourseFee), 0) AS expectedTotal FROM enrollments WHERE enrollmentStatus != 'Archived'"
    );
    const [[txAgg]] = await pool.query(
      'SELECT COALESCE(SUM(amountPaid), 0) AS collectedTotal, COUNT(*) AS txCount FROM transactions'
    );
    const [[appPending]] = await pool.query(
      "SELECT COUNT(*) AS cnt FROM registration_applications WHERE status = 'PENDING_ADMIN_APPROVAL'"
    );
    const [[payPending]] = await pool.query(
      "SELECT COUNT(*) AS cnt FROM payment_submissions WHERE status = 'PENDING'"
    );

    const expected = Number(feeAgg.expectedTotal || 0);
    const collected = Number(txAgg.collectedTotal || 0);
    return {
      activeStudents: Number(stAgg.active || 0),
      graduatedStudents: Number(stAgg.graduated || 0),
      suspendedStudents: Number(stAgg.suspended || 0),
      expectedTuitionEtb: expected,
      approvedCollectedEtb: collected,
      outstandingEstimateEtb: Math.max(0, expected - collected),
      collectionRatePct: expected > 0 ? Number(((collected / expected) * 100).toFixed(1)) : 0,
      approvedTransactionsCount: Number(txAgg.txCount || 0),
      pendingRegistrations: Number(appPending.cnt || 0),
      pendingPaymentSubmissions: Number(payPending.cnt || 0),
    };
  }

  if (toolName === 'get_attendance_overview') {
    if (user.role !== 'admin') {
      return { accessDenied: true, reason: 'Attendance analytics are restricted to Administrators.' };
    }
    const courseFilter = String(args.courseName || '').trim().toLowerCase();
    const [rows] = await pool.query(
      `SELECT c.name AS courseName,
              COUNT(*) AS totalRecords,
              SUM(a.status IN ('PRESENT', 'LATE')) AS attendedCount,
              SUM(a.status = 'ABSENT') AS absentCount,
              SUM(a.status = 'EXCUSED') AS excusedCount
       FROM attendance a
       JOIN courses c ON c.id = a.courseId
       GROUP BY c.id, c.name
       ORDER BY c.name ASC`
    );
    const filtered = courseFilter ? rows.filter((r) => r.courseName.toLowerCase().includes(courseFilter)) : rows;
    return {
      courses: filtered.map((r) => ({
        courseName: r.courseName,
        totalRecords: Number(r.totalRecords || 0),
        attendedCount: Number(r.attendedCount || 0),
        absentCount: Number(r.absentCount || 0),
        excusedCount: Number(r.excusedCount || 0),
        attendanceRatePct: r.totalRecords > 0 ? Number(((r.attendedCount / r.totalRecords) * 100).toFixed(1)) : 0,
      })),
    };
  }

  return { error: `Unknown tool "${toolName}".` };
}

module.exports = {
  buildAssistantContext,
  executeAssistantTool,
};
