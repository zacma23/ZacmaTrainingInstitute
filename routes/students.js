const express = require('express');
const { randomUUID } = require('crypto');
const { getPool, withTransaction } = require('../config/db');
const { authenticate, requireRole, recordAuditLog } = require('../middleware/auth');
const { getAddisTodayISO, validateEthiopianPhone, addMonthsISO, addDaysISO } = require('../utils/ethiopia');
const { generateInstallmentSchedule, computeEnrollmentFinancials, generateNextStudentCode } = require('../services/feeService');
const { runReminderCheck } = require('../services/reminderService');

const router = express.Router();
router.use(authenticate);

// GET all students with computed financial summary & filters
router.get('/', async (req, res) => {
  try {
    const { search, studentName, studentId, courseId, paymentStatus, studentStatus, includeArchived } = req.query;
    const pool = getPool();
    const todayISO = getAddisTodayISO();

    let query = `
      SELECT s.*,
             e.id AS enrollmentId, e.courseId, e.paymentPlanId, e.courseStartDate,
             e.expectedGraduationDate, e.totalCourseFee, e.assignedDueDate, e.enrollmentStatus,
             c.name AS courseName, c.code AS courseCode, c.durationValue, c.durationUnit,
             pp.code AS paymentPlanCode, pp.name AS paymentPlanName
      FROM students s
      LEFT JOIN enrollments e ON e.studentId = s.id AND e.enrollmentStatus != 'Archived'
      LEFT JOIN courses c ON c.id = e.courseId
      LEFT JOIN payment_plans pp ON pp.id = e.paymentPlanId
      WHERE 1=1
    `;
    const params = [];

    if (studentStatus) {
      query += ' AND s.status = ?';
      params.push(studentStatus);
    } else if (includeArchived !== 'true') {
      query += " AND s.status != 'Archived'";
    }

    if (courseId) {
      query += ' AND e.courseId = ?';
      params.push(courseId);
    }

    if (studentName && String(studentName).trim()) {
      const sn = `%${String(studentName).trim().toLowerCase()}%`;
      query += ' AND (LOWER(s.fullName) LIKE ? OR LOWER(s.phone) LIKE ? OR LOWER(s.altPhone) LIKE ?)';
      params.push(sn, sn, sn);
    }

    if (studentId && String(studentId).trim()) {
      const sid = `%${String(studentId).trim().toLowerCase()}%`;
      query += ' AND (LOWER(s.studentCode) LIKE ? OR LOWER(s.id) LIKE ?)';
      params.push(sid, sid);
    }

    if (search && String(search).trim()) {
      const s = `%${String(search).trim().toLowerCase()}%`;
      query += ' AND (LOWER(s.fullName) LIKE ? OR LOWER(s.studentCode) LIKE ? OR LOWER(s.id) LIKE ? OR LOWER(s.phone) LIKE ? OR LOWER(s.altPhone) LIKE ?)';
      params.push(s, s, s, s, s);
    }

    query += ' ORDER BY s.createdAt DESC';

    const [rows] = await pool.query(query, params);
    const [allInstallments] = await pool.query('SELECT * FROM installments ORDER BY installmentNumber ASC');
    const [allTransactions] = await pool.query('SELECT * FROM transactions ORDER BY paymentDate ASC, createdAt ASC');

    let result = rows.map((row) => {
      const enr = {
        id: row.enrollmentId,
        totalCourseFee: Number(row.totalCourseFee || 0),
        assignedDueDate: row.assignedDueDate,
      };
      const insts = allInstallments.filter((i) => i.enrollmentId === row.enrollmentId);
      const txns = allTransactions.filter((t) => t.enrollmentId === row.enrollmentId);
      const fin = row.enrollmentId
        ? computeEnrollmentFinancials(enr, insts, txns, todayISO)
        : {
            totalCourseFee: 0,
            totalPaid: 0,
            remainingBalance: 0,
            paymentStatus: 'Unpaid',
            isOverdue: false,
            overdueDays: 0,
            nextDueDate: null,
            nextDueAmount: 0,
            installments: [],
          };

      return {
        ...row,
        totalCourseFee: fin.totalCourseFee,
        totalPaid: fin.totalPaid,
        remainingBalance: fin.remainingBalance,
        paymentStatus: fin.paymentStatus,
        isOverdue: fin.isOverdue,
        overdueDays: fin.overdueDays,
        nextDueDate: fin.nextDueDate,
        nextDueAmount: fin.nextDueAmount,
        installments: fin.installments,
      };
    });

    if (paymentStatus) {
      if (paymentStatus === 'Overdue') {
        result = result.filter((r) => r.isOverdue);
      } else {
        result = result.filter((r) => r.paymentStatus === paymentStatus);
      }
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET single student complete financial profile
router.get('/:id', async (req, res) => {
  try {
    const pool = getPool();
    const todayISO = getAddisTodayISO();

    const [rows] = await pool.query(
      `SELECT s.*,
              e.id AS enrollmentId, e.courseId, e.paymentPlanId, e.courseStartDate,
              e.expectedGraduationDate, e.totalCourseFee, e.assignedDueDate, e.enrollmentStatus,
              c.name AS courseName, c.code AS courseCode, c.description AS courseDescription,
              c.durationValue, c.durationUnit,
              pp.code AS paymentPlanCode, pp.name AS paymentPlanName
       FROM students s
       LEFT JOIN enrollments e ON e.studentId = s.id AND e.enrollmentStatus != 'Archived'
       LEFT JOIN courses c ON c.id = e.courseId
       LEFT JOIN payment_plans pp ON pp.id = e.paymentPlanId
       WHERE s.id = ?
       LIMIT 1`,
      [req.params.id]
    );

    if (rows.length === 0) return res.status(404).json({ error: 'Student not found.' });
    const row = rows[0];

    const [installments] = row.enrollmentId
      ? await pool.query('SELECT * FROM installments WHERE enrollmentId = ? ORDER BY installmentNumber ASC', [row.enrollmentId])
      : [[]];

    const [transactions] = await pool.query(
      `SELECT t.*, r.receiptNumber, r.previousBalance, r.remainingBalance AS receiptRemainingBalance
       FROM transactions t
       LEFT JOIN receipts r ON r.transactionId = t.id
       WHERE t.studentId = ?
       ORDER BY t.paymentDate DESC, t.createdAt DESC`,
      [row.id]
    );

    const fin = row.enrollmentId
      ? computeEnrollmentFinancials(
          { id: row.enrollmentId, totalCourseFee: row.totalCourseFee, assignedDueDate: row.assignedDueDate },
          installments,
          [...transactions].reverse(),
          todayISO
        )
      : {
          totalCourseFee: 0,
          totalPaid: 0,
          remainingBalance: 0,
          paymentStatus: 'Unpaid',
          isOverdue: false,
          overdueDays: 0,
          nextDueDate: null,
          nextDueAmount: 0,
          installments: [],
        };

    const [pendingSubs] = await pool.query(
      req.user.role === 'admin'
        ? "SELECT id, submissionRef, amountSubmitted, paymentDate, paymentMethod, status, submittedByName, createdAt FROM payment_submissions WHERE studentId = ? AND status = 'PENDING' ORDER BY createdAt DESC"
        : "SELECT id, submissionRef, amountSubmitted, paymentDate, paymentMethod, status, submittedByName, createdAt FROM payment_submissions WHERE studentId = ? AND submittedByUserId = ? ORDER BY createdAt DESC",
      req.user.role === 'admin' ? [row.id] : [row.id, req.user.id]
    );

    res.json({
      ...row,
      ...fin,
      transactions: req.user.role === 'admin' ? transactions : [],
      paymentSubmissions: pendingSubs,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST register new student directly (ADMIN ONLY — Accountants must use /api/applications)
router.post('/', requireRole('admin'), async (req, res) => {
  try {
    const {
      fullName,
      gender,
      phone,
      altPhone,
      email,
      region,
      city,
      address,
      emergencyContactName,
      emergencyContactPhone,
      emergencyContactRelation,
      documentsNote,
      batchName,
      courseId,
      registrationDate,
      courseStartDate,
      expectedGraduationDate,
      totalCourseFee,
      paymentPlanCode,
      assignedDueDate,
      status,
      notes,
      customInstallments,
    } = req.body || {};

    if (!fullName || !phone || !courseId) {
      return res.status(400).json({ error: 'Full name, phone number, and course are required.' });
    }

    const phoneCheck = validateEthiopianPhone(String(phone));
    if (!phoneCheck.valid) {
      return res.status(400).json({ error: phoneCheck.error });
    }

    let normalizedAltPhone = '';
    if (altPhone && String(altPhone).trim() !== '') {
      const altCheck = validateEthiopianPhone(String(altPhone));
      if (!altCheck.valid) {
        return res.status(400).json({ error: `Alternative phone invalid: ${altCheck.error}` });
      }
      normalizedAltPhone = altCheck.normalized;
    }

    const created = await withTransaction(async (conn) => {
      const [courses] = await conn.query('SELECT * FROM courses WHERE id = ? LIMIT 1', [courseId]);
      if (courses.length === 0) throw new Error('Selected course does not exist.');
      const course = courses[0];

      const planCode = paymentPlanCode || 'full';
      const [plans] = await conn.query('SELECT * FROM payment_plans WHERE code = ? LIMIT 1', [planCode]);
      if (plans.length === 0) throw new Error('Selected payment plan does not exist.');
      const plan = plans[0];

      const todayISO = getAddisTodayISO();
      const regDate = registrationDate || todayISO;
      const startDate = courseStartDate || regDate;
      const gradDate =
        expectedGraduationDate ||
        (course.durationUnit === 'weeks'
          ? addDaysISO(startDate, course.durationValue * 7)
          : addMonthsISO(startDate, course.durationValue));
      const dueDate = assignedDueDate || startDate;
      const feeAmount = totalCourseFee !== undefined && totalCourseFee !== '' ? Number(totalCourseFee) : Number(course.defaultFee);

      if (Number.isNaN(feeAmount) || feeAmount <= 0) {
        throw new Error('Total course fee must be greater than 0.');
      }

      const studentId = randomUUID();
      const enrollmentId = randomUUID();
      const studentCode = await generateNextStudentCode(conn);

      await conn.query(
        `INSERT INTO students
         (id, studentCode, fullName, gender, phone, altPhone, email, region, city, address,
          emergencyContactName, emergencyContactPhone, emergencyContactRelation, documentsNote,
          registrationDate, status, notes, registeredByUserId, approvedByUserId, approvedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [
          studentId,
          studentCode,
          String(fullName).trim(),
          gender || '',
          phoneCheck.normalized,
          normalizedAltPhone,
          String(email || '').trim(),
          String(region || 'Addis Ababa').trim(),
          String(city || 'Addis Ababa').trim(),
          String(address || '').trim(),
          String(emergencyContactName || '').trim(),
          String(emergencyContactPhone || '').trim(),
          String(emergencyContactRelation || '').trim(),
          String(documentsNote || '').trim(),
          regDate,
          status || 'Active',
          String(notes || '').trim(),
          req.user.id,
          req.user.id,
        ]
      );

      await conn.query(
        `INSERT INTO enrollments
         (id, studentId, courseId, paymentPlanId, batchName, courseStartDate, expectedGraduationDate, registrationFee, totalCourseFee, assignedDueDate, enrollmentStatus)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          enrollmentId,
          studentId,
          course.id,
          plan.id,
          String(batchName || 'Batch A').trim(),
          startDate,
          gradDate,
          Number(course.registrationFee || 0),
          feeAmount,
          dueDate,
          status === 'Graduated' ? 'Completed' : 'Active',
        ]
      );

      const schedule = generateInstallmentSchedule({
        enrollmentId,
        studentId,
        totalCourseFee: feeAmount,
        planCode: plan.code,
        firstDueDate: dueDate,
        customInstallments,
      });

      for (const inst of schedule) {
        await conn.query(
          `INSERT INTO installments (id, enrollmentId, studentId, installmentNumber, title, expectedAmount, dueDate, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [inst.id, inst.enrollmentId, inst.studentId, inst.installmentNumber, inst.title, inst.expectedAmount, inst.dueDate, inst.notes]
        );
      }

      await recordAuditLog(
        {
          user: req.user,
          action: 'REGISTER_STUDENT',
          entityType: 'student',
          entityId: studentId,
          newValue: { studentCode, fullName: String(fullName).trim(), course: course.name, totalCourseFee: feeAmount, plan: plan.code },
          details: { studentCode, fullName: String(fullName).trim(), course: course.name, totalCourseFee: feeAmount, plan: plan.code },
          ipAddress: req.ip,
        },
        conn
      );

      return { id: studentId, studentCode, enrollmentId, totalCourseFee: feeAmount, installments: schedule };
    });

    // Run reminder check asynchronously in background
    runReminderCheck().catch(() => {});

    res.status(201).json(created);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PUT update student info & enrollment metadata (ADMIN ONLY)
router.put('/:id', requireRole('admin'), async (req, res) => {
  try {
    const {
      fullName,
      gender,
      phone,
      altPhone,
      email,
      region,
      city,
      address,
      emergencyContactName,
      emergencyContactPhone,
      emergencyContactRelation,
      batchName,
      courseId,
      courseStartDate,
      expectedGraduationDate,
      totalCourseFee,
      paymentPlanCode,
      assignedDueDate,
      status,
      notes,
      regenerateSchedule,
    } = req.body || {};

    let normalizedPhone = null;
    if (phone) {
      const check = validateEthiopianPhone(String(phone));
      if (!check.valid) return res.status(400).json({ error: check.error });
      normalizedPhone = check.normalized;
    }

    let normalizedAlt = undefined;
    if (altPhone !== undefined) {
      if (String(altPhone).trim() === '') normalizedAlt = '';
      else {
        const altCheck = validateEthiopianPhone(String(altPhone));
        if (!altCheck.valid) return res.status(400).json({ error: `Alternative phone invalid: ${altCheck.error}` });
        normalizedAlt = altCheck.normalized;
      }
    }

    await withTransaction(async (conn) => {
      const [students] = await conn.query('SELECT * FROM students WHERE id = ? LIMIT 1', [req.params.id]);
      if (students.length === 0) throw new Error('Student not found.');
      const cur = students[0];

      await conn.query(
        `UPDATE students
         SET fullName = ?, gender = ?, phone = ?, altPhone = ?, email = ?, region = ?, city = ?, address = ?,
             emergencyContactName = ?, emergencyContactPhone = ?, emergencyContactRelation = ?,
             status = ?, notes = ?
         WHERE id = ?`,
        [
          fullName ? String(fullName).trim() : cur.fullName,
          gender !== undefined ? gender : cur.gender,
          normalizedPhone || cur.phone,
          normalizedAlt !== undefined ? normalizedAlt : cur.altPhone,
          email !== undefined ? String(email).trim() : cur.email,
          region ? String(region).trim() : cur.region,
          city ? String(city).trim() : cur.city,
          address !== undefined ? String(address).trim() : cur.address,
          emergencyContactName !== undefined ? String(emergencyContactName).trim() : cur.emergencyContactName,
          emergencyContactPhone !== undefined ? String(emergencyContactPhone).trim() : cur.emergencyContactPhone,
          emergencyContactRelation !== undefined ? String(emergencyContactRelation).trim() : cur.emergencyContactRelation,
          status || cur.status,
          notes !== undefined ? String(notes).trim() : cur.notes,
          req.params.id,
        ]
      );

      const [enrollments] = await conn.query(
        "SELECT * FROM enrollments WHERE studentId = ? AND enrollmentStatus != 'Archived' LIMIT 1",
        [req.params.id]
      );

      if (enrollments.length > 0) {
        const enr = enrollments[0];
        let nextPlanId = enr.paymentPlanId;
        let nextPlanCode = null;
        if (paymentPlanCode) {
          const [plans] = await conn.query('SELECT * FROM payment_plans WHERE code = ? LIMIT 1', [paymentPlanCode]);
          if (plans.length > 0) {
            nextPlanId = plans[0].id;
            nextPlanCode = plans[0].code;
          }
        } else {
          const [plans] = await conn.query('SELECT code FROM payment_plans WHERE id = ? LIMIT 1', [enr.paymentPlanId]);
          nextPlanCode = plans[0]?.code || 'full';
        }

        const nextFee = totalCourseFee !== undefined && totalCourseFee !== '' ? Number(totalCourseFee) : Number(enr.totalCourseFee);
        if (Number.isNaN(nextFee) || nextFee <= 0) throw new Error('Total course fee must be positive.');

        const nextDue = assignedDueDate || enr.assignedDueDate;
        const nextEnrStatus = status === 'Graduated' ? 'Completed' : status === 'Archived' ? 'Archived' : 'Active';

        await conn.query(
          `UPDATE enrollments
           SET courseId = ?, paymentPlanId = ?, batchName = ?, courseStartDate = ?, expectedGraduationDate = ?,
               totalCourseFee = ?, assignedDueDate = ?, enrollmentStatus = ?
           WHERE id = ?`,
          [
            courseId || enr.courseId,
            nextPlanId,
            batchName ? String(batchName).trim() : enr.batchName,
            courseStartDate || enr.courseStartDate,
            expectedGraduationDate || enr.expectedGraduationDate,
            nextFee,
            nextDue,
            nextEnrStatus,
            enr.id,
          ]
        );

        // Regenerate installments ONLY if explicitly requested or fee/plan changed and user confirms
        if (regenerateSchedule === true) {
          await conn.query('DELETE FROM installments WHERE enrollmentId = ?', [enr.id]);
          const schedule = generateInstallmentSchedule({
            enrollmentId: enr.id,
            studentId: req.params.id,
            totalCourseFee: nextFee,
            planCode: nextPlanCode,
            firstDueDate: nextDue,
          });
          for (const inst of schedule) {
            await conn.query(
              `INSERT INTO installments (id, enrollmentId, studentId, installmentNumber, title, expectedAmount, dueDate, notes)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              [inst.id, inst.enrollmentId, inst.studentId, inst.installmentNumber, inst.title, inst.expectedAmount, inst.dueDate, inst.notes]
            );
          }
        }
      }

      await recordAuditLog(
        {
          user: req.user,
          action: 'UPDATE_STUDENT',
          entityType: 'student',
          entityId: req.params.id,
          previousValue: { fullName: cur.fullName, status: cur.status, phone: cur.phone },
          newValue: { fullName: fullName || cur.fullName, status: status || cur.status, phone: normalizedPhone || cur.phone },
          details: { fullName: fullName || cur.fullName, status: status || cur.status },
          ipAddress: req.ip,
        },
        conn
      );
    });

    res.json({ message: 'Student record updated.' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Archive student safely (Admin only) — preserves financial history
router.post('/:id/archive', requireRole('admin'), async (req, res) => {
  try {
    await withTransaction(async (conn) => {
      const [rows] = await conn.query('SELECT id, studentCode, fullName FROM students WHERE id = ? LIMIT 1', [req.params.id]);
      if (rows.length === 0) throw new Error('Student not found.');

      await conn.query("UPDATE students SET status = 'Archived' WHERE id = ?", [req.params.id]);
      await conn.query("UPDATE enrollments SET enrollmentStatus = 'Archived' WHERE studentId = ?", [req.params.id]);

      await recordAuditLog(
        {
          user: req.user,
          action: 'ARCHIVE_STUDENT',
          entityType: 'student',
          entityId: req.params.id,
          details: { studentCode: rows[0].studentCode, fullName: rows[0].fullName },
          ipAddress: req.ip,
        },
        conn
      );
    });
    res.json({ message: 'Student archived safely. All financial records preserved.' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Restore archived student (Admin only)
router.post('/:id/restore', requireRole('admin'), async (req, res) => {
  try {
    await withTransaction(async (conn) => {
      await conn.query("UPDATE students SET status = 'Active' WHERE id = ?", [req.params.id]);
      await conn.query("UPDATE enrollments SET enrollmentStatus = 'Active' WHERE studentId = ?", [req.params.id]);
      await recordAuditLog(
        {
          user: req.user,
          action: 'RESTORE_STUDENT',
          entityType: 'student',
          entityId: req.params.id,
          ipAddress: req.ip,
        },
        conn
      );
    });
    res.json({ message: 'Student restored to Active status.' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Delete student (Admin full privilege — cleanly deletes student and all linked records inside a transaction with audit log)
router.delete('/:id', requireRole('admin'), async (req, res) => {
  try {
    const deleted = await withTransaction(async (conn) => {
      const [rows] = await conn.query('SELECT id, studentCode, fullName, phone FROM students WHERE id = ? LIMIT 1 FOR UPDATE', [req.params.id]);
      if (rows.length === 0) {
        const err = new Error('Student not found.');
        err.status = 404;
        throw err;
      }
      const student = rows[0];

      // Clear references on registration applications so historical audit applications don't fail FK checks
      await conn.query(
        `UPDATE registration_applications
         SET approvedStudentId = NULL, approvedEnrollmentId = NULL, approvedTransactionId = NULL, approvedReceiptId = NULL
         WHERE approvedStudentId = ?`,
        [student.id]
      );

      await conn.query('DELETE FROM notifications WHERE studentId = ?', [student.id]);
      await conn.query('DELETE FROM attendance WHERE studentId = ?', [student.id]);
      await conn.query('DELETE FROM receipts WHERE studentId = ?', [student.id]);
      await conn.query('DELETE FROM transactions WHERE studentId = ?', [student.id]);
      await conn.query('DELETE FROM payment_submissions WHERE studentId = ?', [student.id]);
      await conn.query('DELETE FROM installments WHERE studentId = ?', [student.id]);
      await conn.query('DELETE FROM enrollments WHERE studentId = ?', [student.id]);
      await conn.query('DELETE FROM students WHERE id = ?', [student.id]);

      await recordAuditLog(
        {
          user: req.user,
          action: 'DELETE_STUDENT',
          entityType: 'student',
          entityId: student.id,
          previousValue: { studentCode: student.studentCode, fullName: student.fullName, phone: student.phone },
          reason: String((req.body && req.body.reason) || 'Deleted by administrator').trim(),
          details: { studentCode: student.studentCode, fullName: student.fullName },
          ipAddress: req.ip,
        },
        conn
      );

      return student;
    });

    res.json({ message: `Student "${deleted.fullName}" (${deleted.studentCode}) and all linked records deleted.` });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

module.exports = router;
