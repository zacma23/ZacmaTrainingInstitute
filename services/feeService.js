const { randomUUID } = require('crypto');
const { getAddisTodayISO, addMonthsISO, diffDaysISO } = require('../utils/ethiopia');

function round2(n) {
  return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
}

/**
 * Generates an array of installment objects whose expectedAmount sums EXACTLY to totalCourseFee.
 */
function generateInstallmentSchedule({
  enrollmentId,
  studentId,
  totalCourseFee,
  planCode,
  firstDueDate,
  customInstallments = null,
}) {
  const totalFee = round2(totalCourseFee);
  if (totalFee <= 0) {
    throw new Error('Total course fee must be greater than 0.');
  }

  // Custom schedule validation
  if (planCode === 'custom' && Array.isArray(customInstallments) && customInstallments.length > 0) {
    let runningSum = 0;
    const rows = customInstallments.map((item, idx) => {
      const amt = round2(item.expectedAmount);
      if (amt <= 0) {
        throw new Error(`Installment #${idx + 1} amount must be greater than 0.`);
      }
      if (!item.dueDate) {
        throw new Error(`Installment #${idx + 1} due date is required.`);
      }
      runningSum = round2(runningSum + amt);
      return {
        id: randomUUID(),
        enrollmentId,
        studentId,
        installmentNumber: idx + 1,
        title: (item.title || `Installment ${idx + 1}`).trim(),
        expectedAmount: amt,
        dueDate: String(item.dueDate).slice(0, 10),
        notes: (item.notes || '').trim(),
      };
    });

    if (Math.abs(runningSum - totalFee) > 0.01) {
      throw new Error(
        `Custom installment total (${runningSum.toFixed(2)} ETB) must equal total course fee (${totalFee.toFixed(2)} ETB).`
      );
    }
    return rows;
  }

  const countMap = {
    full: 1,
    '2_months': 2,
    '3_months': 3,
    '6_months': 6,
    custom: 2,
  };
  const count = countMap[planCode] || 1;
  const baseDate = String(firstDueDate || getAddisTodayISO()).slice(0, 10);

  const baseAmount = Math.floor((totalFee / count) * 100) / 100;
  let allocated = 0;
  const rows = [];

  for (let i = 0; i < count; i++) {
    const isLast = i === count - 1;
    const expectedAmount = isLast ? round2(totalFee - allocated) : baseAmount;
    allocated = round2(allocated + expectedAmount);

    const dueDate = i === 0 ? baseDate : addMonthsISO(baseDate, i);
    const title = count === 1 ? 'Full Payment' : `Month ${i + 1}`;

    rows.push({
      id: randomUUID(),
      enrollmentId,
      studentId,
      installmentNumber: i + 1,
      title,
      expectedAmount,
      dueDate,
      notes: '',
    });
  }

  return rows;
}

/**
 * Computes live financial summary and installment-by-installment breakdown
 * strictly from verified transaction records (never stale duplicate counters).
 */
function computeEnrollmentFinancials(enrollment, installments = [], transactions = [], todayISO = getAddisTodayISO()) {
  const totalCourseFee = round2(enrollment.totalCourseFee);
  const sortedInsts = [...installments].sort((a, b) => a.installmentNumber - b.installmentNumber);

  // Sum verified transactions applied to course tuition (excluding pure registration fee portion)
  const totalPaid = round2(
    transactions.reduce((sum, t) => {
      if (t.paymentCategory === 'REGISTRATION_FEE') return sum;
      if (t.paymentCategory === 'COMBINED') return sum + Number(t.tuitionAmount || 0);
      return sum + Number(t.amountPaid || 0);
    }, 0)
  );
  const totalCashCollected = round2(
    transactions.reduce((sum, t) => sum + Number(t.amountPaid || 0), 0)
  );
  const remainingBalance = round2(Math.max(0, totalCourseFee - totalPaid));
  const overpaidAmount = totalPaid > totalCourseFee ? round2(totalPaid - totalCourseFee) : 0;

  let paymentStatus = 'Unpaid';
  if (totalPaid >= totalCourseFee && totalCourseFee > 0) {
    paymentStatus = 'Paid';
  } else if (totalPaid > 0) {
    paymentStatus = 'Partially Paid';
  }

  // Allocate totalPaid sequentially across installments (FIFO)
  let poolRemaining = totalPaid;
  let maxOverdueDays = 0;
  let nextDueDate = null;
  let nextDueAmount = 0;
  let hasOverdueInstallment = false;
  let dueTodayCount = 0;
  let dueSoonCount = 0;

  const computedInstallments = sortedInsts.map((inst) => {
    const expected = round2(inst.expectedAmount);
    const paid = round2(Math.min(expected, Math.max(0, poolRemaining)));
    poolRemaining = round2(Math.max(0, poolRemaining - paid));
    const remaining = round2(Math.max(0, expected - paid));

    const dueStr = String(inst.dueDate).slice(0, 10);
    const daysPastDue = diffDaysISO(dueStr, todayISO); // > 0 means today > dueStr (overdue)
    const daysUntilDue = diffDaysISO(todayISO, dueStr); // >= 0 means due today or future

    let status = 'Upcoming';
    let overdueDays = 0;

    if (remaining <= 0.009) {
      status = 'Paid';
    } else if (daysPastDue > 0) {
      status = 'Overdue';
      overdueDays = daysPastDue;
      hasOverdueInstallment = true;
      if (overdueDays > maxOverdueDays) maxOverdueDays = overdueDays;
    } else if (daysPastDue === 0) {
      status = paid > 0 ? 'Due Today (Partial)' : 'Due Today';
      dueTodayCount++;
    } else if (daysUntilDue <= 3) {
      status = paid > 0 ? 'Due Soon (Partial)' : 'Due Soon';
      dueSoonCount++;
    } else if (paid > 0) {
      status = 'Partially Paid';
    } else {
      status = 'Upcoming';
    }

    if (remaining > 0.009 && (!nextDueDate || dueStr < nextDueDate)) {
      nextDueDate = dueStr;
      nextDueAmount = remaining;
    }

    return {
      ...inst,
      dueDate: dueStr,
      expectedAmount: expected,
      paidAmount: paid,
      remainingAmount: remaining,
      status,
      overdueDays,
    };
  });

  // Fallback if enrollment has no explicit installment rows
  if (computedInstallments.length === 0 && remainingBalance > 0) {
    const dueStr = String(enrollment.assignedDueDate).slice(0, 10);
    const daysPastDue = diffDaysISO(dueStr, todayISO);
    nextDueDate = dueStr;
    nextDueAmount = remainingBalance;
    if (daysPastDue > 0) {
      hasOverdueInstallment = true;
      maxOverdueDays = daysPastDue;
    }
  }

  return {
    totalCourseFee,
    totalPaid,
    totalCashCollected,
    remainingBalance,
    overpaidAmount,
    paymentStatus,
    isOverdue: remainingBalance > 0.009 && hasOverdueInstallment,
    overdueDays: maxOverdueDays,
    dueTodayCount,
    dueSoonCount,
    nextDueDate,
    nextDueAmount,
    installments: computedInstallments,
  };
}

async function generateNextStudentCode(conn) {
  const year = getAddisTodayISO().slice(0, 4);
  const prefix = `ASTI-${year}-`;
  const [[row]] = await conn.query(
    "SELECT COALESCE(MAX(CAST(SUBSTRING_INDEX(studentCode, '-', -1) AS UNSIGNED)), 0) AS maxSeq FROM students WHERE studentCode LIKE ?",
    [`${prefix}%`]
  );
  const nextSeq = Number(row.maxSeq || 0) + 1;
  return `${prefix}${String(nextSeq).padStart(4, '0')}`;
}

async function generateNextApplicationNumber(conn) {
  const year = getAddisTodayISO().slice(0, 4);
  const prefix = `APP-${year}-`;
  const [[row]] = await conn.query(
    "SELECT COALESCE(MAX(CAST(SUBSTRING_INDEX(applicationNumber, '-', -1) AS UNSIGNED)), 0) AS maxSeq FROM registration_applications WHERE applicationNumber LIKE ?",
    [`${prefix}%`]
  );
  const nextSeq = Number(row.maxSeq || 0) + 1;
  return `${prefix}${String(nextSeq).padStart(4, '0')}`;
}

async function generateNextReceiptNumber(conn) {
  const year = getAddisTodayISO().slice(0, 4);
  const prefix = `RCP-${year}-`;
  const [[row]] = await conn.query(
    "SELECT COALESCE(MAX(CAST(SUBSTRING_INDEX(receiptNumber, '-', -1) AS UNSIGNED)), 0) AS maxSeq FROM receipts WHERE receiptNumber LIKE ?",
    [`${prefix}%`]
  );
  const nextSeq = Number(row.maxSeq || 0) + 1;
  return `${prefix}${String(nextSeq).padStart(4, '0')}`;
}

function generateTransactionId() {
  const datePart = getAddisTodayISO().replace(/-/g, '');
  const randPart = Math.random().toString(36).substring(2, 7).toUpperCase();
  return `TXN-${datePart}-${randPart}`;
}

function generateSubmissionRef(prefix = 'SUB') {
  const datePart = getAddisTodayISO().replace(/-/g, '');
  const randPart = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `${prefix}-${datePart}-${randPart}`;
}

module.exports = {
  round2,
  generateInstallmentSchedule,
  computeEnrollmentFinancials,
  generateNextStudentCode,
  generateNextApplicationNumber,
  generateNextReceiptNumber,
  generateTransactionId,
  generateSubmissionRef,
};
