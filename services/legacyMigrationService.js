const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { withTransaction } = require('../config/db');
const { recordAuditLog } = require('../middleware/auth');
const { generateInstallmentSchedule, generateNextReceiptNumber } = require('./feeService');
const logger = require('../config/logger');

function mapLegacyMode(mode) {
  const m = String(mode || '').trim().toLowerCase();
  if (m === 'cash') return 'Cash';
  if (m === 'bank transfer') return 'Bank Transfer';
  if (m === 'upi' || m === 'mobile money') return 'Mobile Money';
  return 'Other';
}

function buildLegacyRef(t) {
  const parts = [];
  if (t.receiptNumber) parts.push(`Receipt: ${t.receiptNumber}`);
  if (t.billNumber) parts.push(`Bill: ${t.billNumber}`);
  if (t.upiNumber) parts.push(`UPI: ${t.upiNumber}`);
  if (t.upiTransactionId) parts.push(`UPI Txn: ${t.upiTransactionId}`);
  if (t.bankTransactionId) parts.push(`Bank Ref: ${t.bankTransactionId}`);
  return parts.join(' | ');
}

/**
 * Safely imports legacy records from data/db.json into the normalized MySQL schema.
 * Idempotent: skips existing student IDs/codes and transaction IDs.
 */
async function migrateLegacyJsonData(actorUser = null) {
  const legacyPath = path.join(__dirname, '..', 'data', 'db.json');
  if (!fs.existsSync(legacyPath)) {
    return { message: 'No legacy data/db.json file found.', importedStudents: 0, importedTransactions: 0, skipped: 0 };
  }

  const raw = fs.readFileSync(legacyPath, 'utf8');
  const data = JSON.parse(raw);

  const summary = await withTransaction(async (conn) => {
    let importedStudents = 0;
    let importedTransactions = 0;
    let skipped = 0;

    // Fetch Full Payment plan
    const [plans] = await conn.query("SELECT * FROM payment_plans WHERE code = 'full' LIMIT 1");
    if (plans.length === 0) throw new Error('Payment plan catalog not initialized.');
    const fullPlan = plans[0];

    const studentIdMap = {};

    for (const st of data.students || []) {
      const code = String(st.rollNumber || st.id).trim().toUpperCase();
      const [existing] = await conn.query(
        'SELECT id FROM students WHERE id = ? OR studentCode = ? LIMIT 1',
        [st.id, code]
      );

      if (existing.length > 0) {
        studentIdMap[st.id] = existing[0].id;
        skipped++;
        continue;
      }

      // Ensure course exists
      const courseName = String(st.course || 'General Training').trim();
      let [courseRows] = await conn.query('SELECT * FROM courses WHERE name = ? LIMIT 1', [courseName]);
      let courseId;
      if (courseRows.length === 0) {
        courseId = randomUUID();
        const courseCode = courseName.replace(/[^A-Za-z0-9]/g, '').slice(0, 6).toUpperCase() + '-01';
        await conn.query(
          `INSERT INTO courses (id, code, name, description, durationValue, durationUnit, defaultFee, availablePlans, status)
           VALUES (?, ?, ?, ?, 6, 'months', ?, ?, 'Active')`,
          [courseId, courseCode, courseName, 'Imported legacy program', Number(st.feeAmount || 10000), JSON.stringify(['full', '2_months', '3_months', 'custom'])]
        );
      } else {
        courseId = courseRows[0].id;
      }

      const regDate = st.createdAt ? String(st.createdAt).slice(0, 10) : String(st.dueDate || '2026-03-01').slice(0, 10);
      const dueDate = String(st.dueDate || regDate).slice(0, 10);
      const feeAmount = Number(st.feeAmount || 0);

      await conn.query(
        `INSERT INTO students (id, studentCode, fullName, gender, phone, altPhone, email, region, city, address, registrationDate, status, notes)
         VALUES (?, ?, ?, '', '+251900000000', '', '', 'Addis Ababa', 'Addis Ababa', 'Imported from legacy db.json', ?, 'Active', ?)`,
        [st.id, code, String(st.name).trim(), regDate, `Legacy Semester: ${st.semester || 'N/A'}`]
      );

      const enrollmentId = randomUUID();
      await conn.query(
        `INSERT INTO enrollments (id, studentId, courseId, paymentPlanId, courseStartDate, expectedGraduationDate, totalCourseFee, assignedDueDate, enrollmentStatus)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Active')`,
        [enrollmentId, st.id, courseId, fullPlan.id, regDate, dueDate, feeAmount, dueDate]
      );

      const schedule = generateInstallmentSchedule({
        enrollmentId,
        studentId: st.id,
        totalCourseFee: feeAmount,
        planCode: 'full',
        firstDueDate: dueDate,
      });

      for (const inst of schedule) {
        await conn.query(
          `INSERT INTO installments (id, enrollmentId, studentId, installmentNumber, title, expectedAmount, dueDate, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [inst.id, inst.enrollmentId, inst.studentId, inst.installmentNumber, inst.title, inst.expectedAmount, inst.dueDate, inst.notes]
        );
      }

      studentIdMap[st.id] = st.id;
      importedStudents++;
    }

    for (const t of data.transactions || []) {
      const [existingTxn] = await conn.query(
        'SELECT id FROM transactions WHERE id = ? OR transactionId = ? LIMIT 1',
        [t.id, t.transactionId]
      );
      if (existingTxn.length > 0) {
        skipped++;
        continue;
      }

      const targetStudentId = studentIdMap[t.studentId] || t.studentId;
      const [enrs] = await conn.query(
        'SELECT id, totalCourseFee FROM enrollments WHERE studentId = ? ORDER BY createdAt DESC LIMIT 1',
        [targetStudentId]
      );
      if (enrs.length === 0) {
        skipped++;
        continue;
      }
      const enr = enrs[0];

      const [prevRows] = await conn.query(
        'SELECT COALESCE(SUM(amountPaid), 0) AS paid FROM transactions WHERE enrollmentId = ?',
        [enr.id]
      );
      const prevPaid = Number(prevRows[0].paid || 0);
      const prevBalance = Math.max(0, Number(enr.totalCourseFee) - prevPaid);
      const amt = Number(t.amountPaid || 0);
      const remBalance = Math.max(0, prevBalance - amt);

      await conn.query(
        `INSERT INTO transactions
         (id, transactionId, studentId, enrollmentId, amountPaid, paymentDate, paymentMethod, transactionReference, receivedByUserId, receivedByName, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          t.id,
          t.transactionId,
          targetStudentId,
          enr.id,
          amt,
          String(t.paymentDate).slice(0, 10),
          mapLegacyMode(t.mode),
          buildLegacyRef(t),
          actorUser ? actorUser.id : null,
          actorUser ? actorUser.fullName : 'Legacy Import',
          String(t.notes || '').trim(),
        ]
      );

      let receiptNo = String(t.receiptNumber || '').trim();
      if (!receiptNo) {
        receiptNo = await generateNextReceiptNumber(conn);
      } else {
        const [dupRcp] = await conn.query('SELECT id FROM receipts WHERE receiptNumber = ? LIMIT 1', [receiptNo]);
        if (dupRcp.length > 0) receiptNo = await generateNextReceiptNumber(conn);
      }

      await conn.query(
        `INSERT INTO receipts (id, receiptNumber, transactionId, studentId, enrollmentId, amountPaid, previousBalance, remainingBalance, issuedBy)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          randomUUID(),
          receiptNo,
          t.id,
          targetStudentId,
          enr.id,
          amt,
          prevBalance,
          remBalance,
          actorUser ? actorUser.fullName : 'Legacy Import',
        ]
      );

      importedTransactions++;
    }

    await recordAuditLog(
      {
        user: actorUser,
        action: 'MIGRATE_LEGACY_DATA',
        entityType: 'database',
        details: { importedStudents, importedTransactions, skipped },
      },
      conn
    );

    return {
      message: 'Legacy data migration completed.',
      importedStudents,
      importedTransactions,
      skipped,
    };
  });

  logger.info('Legacy migration finished', summary);
  return summary;
}

module.exports = { migrateLegacyJsonData };
