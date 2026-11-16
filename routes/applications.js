const express = require('express');
const { randomUUID } = require('crypto');
const { getPool, withTransaction } = require('../config/db');
const { authenticate, requireRole, recordAuditLog } = require('../middleware/auth');
const { getAddisTodayISO, validateEthiopianPhone, addMonthsISO, addDaysISO, formatETB } = require('../utils/ethiopia');
const {
  round2,
  generateInstallmentSchedule,
  generateNextStudentCode,
  generateNextApplicationNumber,
  generateNextReceiptNumber,
  generateTransactionId,
  generateSubmissionRef,
} = require('../services/feeService');
const { createWorkflowNotification, runReminderCheck } = require('../services/reminderService');

const router = express.Router();
router.use(authenticate);

const ALLOWED_DOC_MIMES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);
const MAX_DOC_BYTES = 1.5 * 1024 * 1024;
const VALID_METHODS = ['Cash', 'Bank Transfer', 'Mobile Money', 'Other'];

function sanitizeDocuments(documents) {
  if (!Array.isArray(documents)) return [];
  if (documents.length > 3) {
    throw new Error('Maximum of 3 registration documents allowed per application.');
  }
  return documents.map((doc, idx) => {
    const fileName = String(doc.fileName || `document_${idx + 1}`).trim().slice(0, 180);
    const mimeType = String(doc.mimeType || '').toLowerCase();
    const contentBase64 = String(doc.contentBase64 || '');
    if (!ALLOWED_DOC_MIMES.has(mimeType)) {
      throw new Error(`Unsupported document format (${mimeType || 'unknown'}). Allowed: PDF, JPG, PNG, WEBP.`);
    }
    const approxBytes = Math.floor((contentBase64.length * 3) / 4);
    if (!contentBase64 || approxBytes > MAX_DOC_BYTES) {
      throw new Error(`Document "${fileName}" exceeds the 1.5 MB size limit.`);
    }
    return {
      id: randomUUID(),
      fileName,
      mimeType,
      fileSize: approxBytes,
      contentBase64,
    };
  });
}

// GET list registration applications (Admin sees all; Accountant sees ONLY own submissions)
router.get('/', async (req, res) => {
  try {
    const { status, search } = req.query;
    const pool = getPool();

    let query = `
      SELECT ra.*,
             c.name AS courseName, c.code AS courseCode, c.durationValue, c.durationUnit,
             pp.name AS paymentPlanName,
             rev.fullName AS reviewedByName,
             st.studentCode AS approvedStudentCode,
             rcp.receiptNumber AS approvedReceiptNumber
      FROM registration_applications ra
      JOIN courses c ON c.id = ra.courseId
      LEFT JOIN payment_plans pp ON pp.code = ra.paymentPlanCode
      LEFT JOIN users rev ON rev.id = ra.reviewedByUserId
      LEFT JOIN students st ON st.id = ra.approvedStudentId
      LEFT JOIN receipts rcp ON rcp.id = ra.approvedReceiptId
      WHERE 1=1
    `;
    const params = [];

    if (req.user.role !== 'admin') {
      query += ' AND ra.submittedByUserId = ?';
      params.push(req.user.id);
    }

    if (status) {
      query += ' AND ra.status = ?';
      params.push(status);
    }

    if (search) {
      const s = `%${String(search).trim().toLowerCase()}%`;
      query += ' AND (LOWER(ra.fullName) LIKE ? OR LOWER(ra.applicationNumber) LIKE ? OR LOWER(ra.phone) LIKE ? OR LOWER(ra.submissionRef) LIKE ?)';
      params.push(s, s, s, s);
    }

    query += ' ORDER BY ra.createdAt DESC';
    const [rows] = await pool.query(query, params);

    const appIds = rows.map((r) => r.id);
    let docMap = {};
    if (appIds.length > 0) {
      const [docs] = await pool.query(
        'SELECT id, applicationId, fileName, mimeType, fileSize, createdAt FROM application_documents WHERE applicationId IN (?)',
        [appIds]
      );
      for (const d of docs) {
        if (!docMap[d.applicationId]) docMap[d.applicationId] = [];
        docMap[d.applicationId].push(d);
      }
    }

    res.json(
      rows.map((r) => ({
        ...r,
        officialRegistrationFee: Number(r.officialRegistrationFee),
        officialCourseFee: Number(r.officialCourseFee),
        initialRegistrationPaid: Number(r.initialRegistrationPaid),
        initialCoursePaid: Number(r.initialCoursePaid),
        totalInitialSubmitted: Number(r.totalInitialSubmitted),
        documents: docMap[r.id] || [],
      }))
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET single application detail
router.get('/:id', async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT ra.*,
              c.name AS courseName, c.code AS courseCode, c.durationValue, c.durationUnit,
              pp.name AS paymentPlanName,
              rev.fullName AS reviewedByName,
              st.studentCode AS approvedStudentCode,
              rcp.receiptNumber AS approvedReceiptNumber
       FROM registration_applications ra
       JOIN courses c ON c.id = ra.courseId
       LEFT JOIN payment_plans pp ON pp.code = ra.paymentPlanCode
       LEFT JOIN users rev ON rev.id = ra.reviewedByUserId
       LEFT JOIN students st ON st.id = ra.approvedStudentId
       LEFT JOIN receipts rcp ON rcp.id = ra.approvedReceiptId
       WHERE ra.id = ?
       LIMIT 1`,
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Registration application not found.' });

    const app = rows[0];
    if (req.user.role !== 'admin' && app.submittedByUserId !== req.user.id) {
      return res.status(403).json({ error: 'Access denied. You can only view your own registration submissions.' });
    }

    const [docs] = await pool.query(
      'SELECT id, fileName, mimeType, fileSize, createdAt FROM application_documents WHERE applicationId = ?',
      [app.id]
    );

    res.json({
      ...app,
      officialRegistrationFee: Number(app.officialRegistrationFee),
      officialCourseFee: Number(app.officialCourseFee),
      initialRegistrationPaid: Number(app.initialRegistrationPaid),
      initialCoursePaid: Number(app.initialCoursePaid),
      totalInitialSubmitted: Number(app.totalInitialSubmitted),
      documents: docs,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET authenticated download for uploaded registration document
router.get('/:id/documents/:docId', async (req, res) => {
  try {
    const pool = getPool();
    const [apps] = await pool.query('SELECT id, submittedByUserId FROM registration_applications WHERE id = ? LIMIT 1', [req.params.id]);
    if (apps.length === 0) return res.status(404).json({ error: 'Application not found.' });
    if (req.user.role !== 'admin' && apps[0].submittedByUserId !== req.user.id) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    const [docs] = await pool.query(
      'SELECT * FROM application_documents WHERE id = ? AND applicationId = ? LIMIT 1',
      [req.params.docId, req.params.id]
    );
    if (docs.length === 0) return res.status(404).json({ error: 'Document not found.' });

    const doc = docs[0];
    const buffer = Buffer.from(doc.contentBase64, 'base64');
    res.setHeader('Content-Type', doc.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${doc.fileName.replace(/"/g, '')}"`);
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET non-official submission confirmation for a registration application
router.get('/:id/confirmation', async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT ra.*, c.name AS courseName, c.code AS courseCode, pp.name AS paymentPlanName
       FROM registration_applications ra
       JOIN courses c ON c.id = ra.courseId
       LEFT JOIN payment_plans pp ON pp.code = ra.paymentPlanCode
       WHERE ra.id = ? LIMIT 1`,
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Application not found.' });
    const app = rows[0];
    if (req.user.role !== 'admin' && app.submittedByUserId !== req.user.id) {
      return res.status(403).json({ error: 'Access denied.' });
    }
    const [settingsRows] = await pool.query('SELECT settingKey, settingValue FROM settings');
    const settings = Object.fromEntries(settingsRows.map((r) => [r.settingKey, r.settingValue]));

    res.json({
      isOfficialReceipt: false,
      disclaimer: 'SUBMISSION CONFIRMATION ONLY — NOT AN OFFICIAL RECEIPT. Pending Administrator Approval.',
      confirmationType: 'REGISTRATION_APPLICATION',
      submission: app,
      institute: settings,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST submit new student registration application (Accountant intake -> PENDING_ADMIN_APPROVAL)
// NOTE: Strictly retrieves official course & registration fees from MySQL, ignoring any client fee tampering.
router.post('/', async (req, res) => {
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
      documents,
      courseId,
      registrationDate,
      courseStartDate,
      expectedGraduationDate,
      assignedDueDate,
      paymentPlanCode,
      initialRegistrationPaid,
      initialCoursePaid,
      paymentMethod,
      transactionReference,
      submissionNotes,
      customInstallments,
    } = req.body || {};

    if (!fullName || !phone || !courseId) {
      return res.status(400).json({ error: 'Student full name, phone number, and course selection are required.' });
    }

    const phoneCheck = validateEthiopianPhone(String(phone));
    if (!phoneCheck.valid) return res.status(400).json({ error: phoneCheck.error });

    let normAlt = '';
    if (altPhone && String(altPhone).trim() !== '') {
      const altCheck = validateEthiopianPhone(String(altPhone));
      if (!altCheck.valid) return res.status(400).json({ error: `Alternative phone invalid: ${altCheck.error}` });
      normAlt = altCheck.normalized;
    }

    let normEmgPhone = '';
    if (emergencyContactPhone && String(emergencyContactPhone).trim() !== '') {
      const emgCheck = validateEthiopianPhone(String(emergencyContactPhone));
      if (!emgCheck.valid) return res.status(400).json({ error: `Emergency phone invalid: ${emgCheck.error}` });
      normEmgPhone = emgCheck.normalized;
    }

    const method = paymentMethod || 'Cash';
    if (!VALID_METHODS.includes(method)) {
      return res.status(400).json({ error: 'Invalid payment method.' });
    }

    const regPaid = round2(initialRegistrationPaid || 0);
    const coursePaid = round2(initialCoursePaid || 0);
    if (Number.isNaN(regPaid) || regPaid < 0 || Number.isNaN(coursePaid) || coursePaid < 0) {
      return res.status(400).json({ error: 'Initial payment amounts cannot be negative.' });
    }
    const totalInitial = round2(regPaid + coursePaid);
    const parsedDocs = sanitizeDocuments(documents);

    const created = await withTransaction(async (conn) => {
      // Strictly load official fees from DB (NEVER trust client-submitted fee values)
      const [courses] = await conn.query("SELECT * FROM courses WHERE id = ? AND status = 'Active' LIMIT 1", [courseId]);
      if (courses.length === 0) throw new Error('Selected course is inactive or does not exist.');
      const course = courses[0];

      const officialRegFee = round2(course.registrationFee || 0);
      const officialCourseFee = round2(course.defaultFee);

      if (regPaid > officialRegFee + 0.01) {
        throw new Error(`Initial registration payment (${regPaid.toFixed(2)} ETB) exceeds official course registration fee (${officialRegFee.toFixed(2)} ETB).`);
      }
      if (coursePaid > officialCourseFee + 0.01) {
        throw new Error(`Initial course payment (${coursePaid.toFixed(2)} ETB) exceeds official tuition fee (${officialCourseFee.toFixed(2)} ETB).`);
      }

      const planCode = paymentPlanCode || 'full';
      const availablePlans = typeof course.availablePlans === 'string' ? JSON.parse(course.availablePlans) : course.availablePlans || ['full'];
      if (!availablePlans.includes(planCode)) {
        throw new Error(`Payment plan "${planCode}" is not enabled for ${course.name}.`);
      }

      const [plans] = await conn.query('SELECT * FROM payment_plans WHERE code = ? AND isActive = 1 LIMIT 1', [planCode]);
      if (plans.length === 0) throw new Error('Selected payment plan is invalid.');

      const todayISO = getAddisTodayISO();
      const regDate = String(registrationDate || todayISO).slice(0, 10);
      const startDate = String(courseStartDate || regDate).slice(0, 10);
      const gradDate = expectedGraduationDate
        ? String(expectedGraduationDate).slice(0, 10)
        : course.durationUnit === 'weeks'
          ? addDaysISO(startDate, course.durationValue * 7)
          : addMonthsISO(startDate, course.durationValue);
      const dueDate = String(assignedDueDate || startDate).slice(0, 10);

      // Validate custom installments against official DB fee if selected
      if (planCode === 'custom' && Array.isArray(customInstallments) && customInstallments.length > 0) {
        generateInstallmentSchedule({
          enrollmentId: 'preview',
          studentId: 'preview',
          totalCourseFee: officialCourseFee,
          planCode: 'custom',
          firstDueDate: dueDate,
          customInstallments,
        });
      }

      const appId = randomUUID();
      const applicationNumber = await generateNextApplicationNumber(conn);
      const submissionRef = generateSubmissionRef('REG');

      await conn.query(
        `INSERT INTO registration_applications (
           id, applicationNumber, submissionRef, submittedByUserId, submittedByName,
           fullName, gender, phone, altPhone, email, region, city, address,
           emergencyContactName, emergencyContactPhone, emergencyContactRelation, documentsNote,
           courseId, paymentPlanCode, officialRegistrationFee, officialCourseFee,
           initialRegistrationPaid, initialCoursePaid, totalInitialSubmitted,
           paymentMethod, transactionReference, submissionNotes,
           registrationDate, courseStartDate, expectedGraduationDate, assignedDueDate,
           customInstallments, status
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING_ADMIN_APPROVAL')`,
        [
          appId,
          applicationNumber,
          submissionRef,
          req.user.id,
          req.user.fullName,
          String(fullName).trim(),
          gender || '',
          phoneCheck.normalized,
          normAlt,
          String(email || '').trim(),
          String(region || 'Addis Ababa').trim(),
          String(city || 'Addis Ababa').trim(),
          String(address || '').trim(),
          String(emergencyContactName || '').trim(),
          normEmgPhone,
          String(emergencyContactRelation || '').trim(),
          String(documentsNote || '').trim(),
          course.id,
          planCode,
          officialRegFee,
          officialCourseFee,
          regPaid,
          coursePaid,
          totalInitial,
          method,
          String(transactionReference || '').trim(),
          String(submissionNotes || '').trim(),
          regDate,
          startDate,
          gradDate,
          dueDate,
          customInstallments ? JSON.stringify(customInstallments) : null,
        ]
      );

      for (const doc of parsedDocs) {
        await conn.query(
          `INSERT INTO application_documents (id, applicationId, fileName, mimeType, fileSize, contentBase64, uploadedByUserId)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [doc.id, appId, doc.fileName, doc.mimeType, doc.fileSize, doc.contentBase64, req.user.id]
        );
      }

      await createWorkflowNotification(
        {
          applicationId: appId,
          targetRole: 'admin',
          type: 'NEW_REGISTRATION',
          title: `New Registration Approval Needed — ${String(fullName).trim()}`,
          message: `${req.user.fullName} submitted ${applicationNumber} for ${course.name} (Initial payment: ${formatETB(totalInitial)}).`,
          amountDue: totalInitial,
          dueDate: regDate,
        },
        conn
      );

      await recordAuditLog(
        {
          user: req.user,
          action: 'SUBMIT_REGISTRATION_APPLICATION',
          entityType: 'registration_application',
          entityId: appId,
          newValue: {
            applicationNumber,
            submissionRef,
            fullName: String(fullName).trim(),
            courseName: course.name,
            officialRegistrationFee: officialRegFee,
            officialCourseFee,
            totalInitialSubmitted: totalInitial,
            status: 'PENDING_ADMIN_APPROVAL',
          },
          details: { applicationNumber, courseCode: course.code, totalInitialSubmitted: totalInitial },
          ipAddress: req.ip,
        },
        conn
      );

      return {
        id: appId,
        applicationNumber,
        submissionRef,
        status: 'PENDING_ADMIN_APPROVAL',
        officialRegistrationFee: officialRegFee,
        officialCourseFee,
        totalInitialSubmitted: totalInitial,
      };
    });

    res.status(201).json(created);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PUT correct and resubmit rejected/correction-required application (Accountant owner or Admin)
router.put('/:id', async (req, res) => {
  try {
    const pool = getPool();
    const [existingRows] = await pool.query('SELECT * FROM registration_applications WHERE id = ? LIMIT 1', [req.params.id]);
    if (existingRows.length === 0) return res.status(404).json({ error: 'Application not found.' });
    const prev = existingRows[0];

    if (req.user.role !== 'admin' && prev.submittedByUserId !== req.user.id) {
      return res.status(403).json({ error: 'Access denied. You cannot modify another accountant’s submitted application.' });
    }
    if (!['REJECTED', 'CORRECTION_REQUIRED'].includes(prev.status)) {
      return res.status(409).json({
        error: `Cannot edit an application in "${prev.status}" status. Only rejected or correction-requested applications can be resubmitted.`,
      });
    }

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
      documents,
      courseId,
      registrationDate,
      courseStartDate,
      expectedGraduationDate,
      assignedDueDate,
      paymentPlanCode,
      initialRegistrationPaid,
      initialCoursePaid,
      paymentMethod,
      transactionReference,
      submissionNotes,
      customInstallments,
    } = req.body || {};

    const phoneCheck = validateEthiopianPhone(String(phone || prev.phone));
    if (!phoneCheck.valid) return res.status(400).json({ error: phoneCheck.error });

    let normAlt = prev.altPhone || '';
    if (altPhone !== undefined) {
      if (String(altPhone).trim() === '') normAlt = '';
      else {
        const altCheck = validateEthiopianPhone(String(altPhone));
        if (!altCheck.valid) return res.status(400).json({ error: `Alternative phone invalid: ${altCheck.error}` });
        normAlt = altCheck.normalized;
      }
    }

    let normEmgPhone = prev.emergencyContactPhone || '';
    if (emergencyContactPhone !== undefined) {
      if (String(emergencyContactPhone).trim() === '') normEmgPhone = '';
      else {
        const emgCheck = validateEthiopianPhone(String(emergencyContactPhone));
        if (!emgCheck.valid) return res.status(400).json({ error: `Emergency phone invalid: ${emgCheck.error}` });
        normEmgPhone = emgCheck.normalized;
      }
    }

    const method = paymentMethod || prev.paymentMethod;
    if (!VALID_METHODS.includes(method)) return res.status(400).json({ error: 'Invalid payment method.' });

    const regPaid = round2(initialRegistrationPaid !== undefined ? initialRegistrationPaid : prev.initialRegistrationPaid);
    const coursePaid = round2(initialCoursePaid !== undefined ? initialCoursePaid : prev.initialCoursePaid);
    if (regPaid < 0 || coursePaid < 0) return res.status(400).json({ error: 'Initial payments cannot be negative.' });
    const totalInitial = round2(regPaid + coursePaid);
    const parsedDocs = documents ? sanitizeDocuments(documents) : null;

    await withTransaction(async (conn) => {
      const targetCourseId = courseId || prev.courseId;
      const [courses] = await conn.query("SELECT * FROM courses WHERE id = ? AND status = 'Active' LIMIT 1", [targetCourseId]);
      if (courses.length === 0) throw new Error('Selected course is inactive or does not exist.');
      const course = courses[0];

      const officialRegFee = round2(course.registrationFee || 0);
      const officialCourseFee = round2(course.defaultFee);
      if (regPaid > officialRegFee + 0.01) throw new Error('Registration payment exceeds official course registration fee.');
      if (coursePaid > officialCourseFee + 0.01) throw new Error('Initial course payment exceeds official tuition fee.');

      const planCode = paymentPlanCode || prev.paymentPlanCode;
      const startDate = String(courseStartDate || prev.courseStartDate).slice(0, 10);
      const regDate = String(registrationDate || prev.registrationDate).slice(0, 10);
      const gradDate = String(expectedGraduationDate || prev.expectedGraduationDate).slice(0, 10);
      const dueDate = String(assignedDueDate || prev.assignedDueDate).slice(0, 10);

      await conn.query(
        `UPDATE registration_applications SET
           fullName = ?, gender = ?, phone = ?, altPhone = ?, email = ?, region = ?, city = ?, address = ?,
           emergencyContactName = ?, emergencyContactPhone = ?, emergencyContactRelation = ?, documentsNote = ?,
           courseId = ?, paymentPlanCode = ?, officialRegistrationFee = ?, officialCourseFee = ?,
           initialRegistrationPaid = ?, initialCoursePaid = ?, totalInitialSubmitted = ?,
           paymentMethod = ?, transactionReference = ?, submissionNotes = ?,
           registrationDate = ?, courseStartDate = ?, expectedGraduationDate = ?, assignedDueDate = ?,
           customInstallments = ?, status = 'PENDING_ADMIN_APPROVAL', adminComment = ''
         WHERE id = ?`,
        [
          String(fullName || prev.fullName).trim(),
          gender !== undefined ? gender : prev.gender,
          phoneCheck.normalized,
          normAlt,
          email !== undefined ? String(email).trim() : prev.email,
          String(region || prev.region).trim(),
          String(city || prev.city).trim(),
          address !== undefined ? String(address).trim() : prev.address,
          emergencyContactName !== undefined ? String(emergencyContactName).trim() : prev.emergencyContactName,
          normEmgPhone,
          emergencyContactRelation !== undefined ? String(emergencyContactRelation).trim() : prev.emergencyContactRelation,
          documentsNote !== undefined ? String(documentsNote).trim() : prev.documentsNote,
          course.id,
          planCode,
          officialRegFee,
          officialCourseFee,
          regPaid,
          coursePaid,
          totalInitial,
          method,
          transactionReference !== undefined ? String(transactionReference).trim() : prev.transactionReference,
          submissionNotes !== undefined ? String(submissionNotes).trim() : prev.submissionNotes,
          regDate,
          startDate,
          gradDate,
          dueDate,
          customInstallments ? JSON.stringify(customInstallments) : prev.customInstallments,
          prev.id,
        ]
      );

      if (parsedDocs && parsedDocs.length > 0) {
        for (const doc of parsedDocs) {
          await conn.query(
            `INSERT INTO application_documents (id, applicationId, fileName, mimeType, fileSize, contentBase64, uploadedByUserId)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [doc.id, prev.id, doc.fileName, doc.mimeType, doc.fileSize, doc.contentBase64, req.user.id]
          );
        }
      }

      await createWorkflowNotification(
        {
          applicationId: prev.id,
          targetRole: 'admin',
          type: 'NEW_REGISTRATION',
          title: `Resubmitted Registration — ${String(fullName || prev.fullName).trim()}`,
          message: `${req.user.fullName} corrected and resubmitted ${prev.applicationNumber} for review.`,
          amountDue: totalInitial,
          dueDate: regDate,
        },
        conn
      );

      await recordAuditLog(
        {
          user: req.user,
          action: 'RESUBMIT_REGISTRATION_APPLICATION',
          entityType: 'registration_application',
          entityId: prev.id,
          previousValue: { status: prev.status, fullName: prev.fullName, totalInitialSubmitted: Number(prev.totalInitialSubmitted) },
          newValue: { status: 'PENDING_ADMIN_APPROVAL', fullName: String(fullName || prev.fullName).trim(), totalInitialSubmitted: totalInitial },
          details: { applicationNumber: prev.applicationNumber },
          ipAddress: req.ip,
        },
        conn
      );
    });

    res.json({ message: 'Application corrected and resubmitted for administrator approval.', status: 'PENDING_ADMIN_APPROVAL' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST approve student registration application (ADMIN ONLY)
router.post('/:id/approve', requireRole('admin'), async (req, res) => {
  try {
    const comment = String((req.body && req.body.comment) || '').trim();

    const approved = await withTransaction(async (conn) => {
      const [apps] = await conn.query('SELECT * FROM registration_applications WHERE id = ? LIMIT 1 FOR UPDATE', [req.params.id]);
      if (apps.length === 0) throw new Error('Registration application not found.');
      const app = apps[0];

      if (app.status !== 'PENDING_ADMIN_APPROVAL') {
        const err = new Error(`Application ${app.applicationNumber} cannot be approved because its status is "${app.status}".`);
        err.status = 409;
        throw err;
      }

      const [courses] = await conn.query('SELECT * FROM courses WHERE id = ? LIMIT 1', [app.courseId]);
      if (courses.length === 0) throw new Error('Assigned course no longer exists.');
      const course = courses[0];

      const [plans] = await conn.query('SELECT * FROM payment_plans WHERE code = ? LIMIT 1', [app.paymentPlanCode]);
      if (plans.length === 0) throw new Error('Assigned payment plan no longer exists.');
      const plan = plans[0];

      const studentId = randomUUID();
      const enrollmentId = randomUUID();
      const studentCode = await generateNextStudentCode(conn);

      await conn.query(
        `INSERT INTO students (
           id, studentCode, fullName, gender, phone, altPhone, email, region, city, address,
           emergencyContactName, emergencyContactPhone, emergencyContactRelation, documentsNote,
           registrationDate, status, notes, registeredByUserId, approvedByUserId, approvedAt
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Active', ?, ?, ?, NOW())`,
        [
          studentId,
          studentCode,
          app.fullName,
          app.gender,
          app.phone,
          app.altPhone,
          app.email,
          app.region,
          app.city,
          app.address,
          app.emergencyContactName,
          app.emergencyContactPhone,
          app.emergencyContactRelation,
          app.documentsNote,
          String(app.registrationDate).slice(0, 10),
          app.submissionNotes || '',
          app.submittedByUserId,
          req.user.id,
        ]
      );

      await conn.query(
        `INSERT INTO enrollments (
           id, studentId, courseId, paymentPlanId, batchName,
           courseStartDate, expectedGraduationDate, registrationFee, totalCourseFee, assignedDueDate, enrollmentStatus
         ) VALUES (?, ?, ?, ?, 'Batch A', ?, ?, ?, ?, ?, 'Active')`,
        [
          enrollmentId,
          studentId,
          course.id,
          plan.id,
          String(app.courseStartDate).slice(0, 10),
          String(app.expectedGraduationDate).slice(0, 10),
          Number(app.officialRegistrationFee),
          Number(app.officialCourseFee),
          String(app.assignedDueDate).slice(0, 10),
        ]
      );

      const customInsts = app.customInstallments
        ? typeof app.customInstallments === 'string'
          ? JSON.parse(app.customInstallments)
          : app.customInstallments
        : null;

      const schedule = generateInstallmentSchedule({
        enrollmentId,
        studentId,
        totalCourseFee: Number(app.officialCourseFee),
        planCode: plan.code,
        firstDueDate: String(app.assignedDueDate).slice(0, 10),
        customInstallments: customInsts,
      });

      for (const inst of schedule) {
        await conn.query(
          `INSERT INTO installments (id, enrollmentId, studentId, installmentNumber, title, expectedAmount, dueDate, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [inst.id, inst.enrollmentId, inst.studentId, inst.installmentNumber, inst.title, inst.expectedAmount, inst.dueDate, inst.notes]
        );
      }

      let approvedTransactionId = null;
      let approvedReceiptId = null;
      let receiptNumber = null;

      const totalInitial = round2(app.totalInitialSubmitted);
      const regPaid = round2(app.initialRegistrationPaid);
      const coursePaid = round2(app.initialCoursePaid);

      if (totalInitial > 0) {
        const subId = randomUUID();
        const txnUuid = randomUUID();
        const transactionCode = generateTransactionId();
        receiptNumber = await generateNextReceiptNumber(conn);
        const receiptUuid = randomUUID();

        const payCat =
          regPaid > 0 && coursePaid > 0
            ? 'COMBINED'
            : regPaid > 0
              ? 'REGISTRATION_FEE'
              : 'COURSE_FEE';

        const prevBal = round2(app.officialCourseFee);
        const remBal = round2(Math.max(0, prevBal - coursePaid));

        await conn.query(
          `INSERT INTO payment_submissions (
             id, submissionRef, studentId, enrollmentId, submittedByUserId, submittedByName,
             amountSubmitted, paymentDate, paymentMethod, transactionReference, notes,
             status, reviewedByUserId, reviewedAt, approvedTransactionId, approvedReceiptId
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'APPROVED', ?, NOW(), ?, ?)`,
          [
            subId,
            generateSubmissionRef('PSUB'),
            studentId,
            enrollmentId,
            app.submittedByUserId,
            app.submittedByName,
            totalInitial,
            String(app.registrationDate).slice(0, 10),
            app.paymentMethod,
            app.transactionReference || '',
            `Initial registration payment (${app.applicationNumber})`,
            req.user.id,
            txnUuid,
            receiptUuid,
          ]
        );

        await conn.query(
          `INSERT INTO transactions (
             id, transactionId, studentId, enrollmentId, submissionId,
             paymentCategory, registrationAmount, tuitionAmount, amountPaid,
             paymentDate, paymentMethod, transactionReference,
             receivedByUserId, receivedByName, approvedByUserId, approvedAt, notes
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?)`,
          [
            txnUuid,
            transactionCode,
            studentId,
            enrollmentId,
            subId,
            payCat,
            regPaid,
            coursePaid,
            totalInitial,
            String(app.registrationDate).slice(0, 10),
            app.paymentMethod,
            app.transactionReference || '',
            app.submittedByUserId,
            app.submittedByName,
            req.user.id,
            `Approved registration initial payment (${app.applicationNumber})`,
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
            studentId,
            enrollmentId,
            totalInitial,
            prevBal,
            remBal,
            req.user.fullName,
            req.user.id,
          ]
        );

        approvedTransactionId = txnUuid;
        approvedReceiptId = receiptUuid;
      }

      await conn.query(
        `UPDATE registration_applications
         SET status = 'APPROVED', adminComment = ?, reviewedByUserId = ?, reviewedAt = NOW(),
             approvedStudentId = ?, approvedEnrollmentId = ?, approvedTransactionId = ?, approvedReceiptId = ?
         WHERE id = ?`,
        [comment, req.user.id, studentId, enrollmentId, approvedTransactionId, approvedReceiptId, app.id]
      );

      await createWorkflowNotification(
        {
          studentId,
          enrollmentId,
          applicationId: app.id,
          targetRole: 'accountant',
          targetUserId: app.submittedByUserId,
          type: 'REGISTRATION_APPROVED',
          title: `Registration Approved — ${app.fullName}`,
          message: `${app.applicationNumber} was approved by ${req.user.fullName}. Official Student ID: ${studentCode}${receiptNumber ? ` · Receipt: ${receiptNumber}` : ''}.`,
          amountDue: totalInitial,
        },
        conn
      );

      await recordAuditLog(
        {
          user: req.user,
          action: 'APPROVE_REGISTRATION',
          entityType: 'registration_application',
          entityId: app.id,
          previousValue: { status: app.status },
          newValue: { status: 'APPROVED', studentId, studentCode, enrollmentId, receiptNumber },
          reason: comment || 'Approved by administrator',
          details: { applicationNumber: app.applicationNumber, studentCode, courseName: course.name, totalInitial },
          ipAddress: req.ip,
        },
        conn
      );

      return {
        message: 'Student registration approved and official student profile created.',
        applicationNumber: app.applicationNumber,
        studentId,
        studentCode,
        enrollmentId,
        approvedTransactionId,
        receiptNumber,
      };
    });

    runReminderCheck().catch(() => {});
    res.json(approved);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

// POST reject application (ADMIN ONLY)
router.post('/:id/reject', requireRole('admin'), async (req, res) => {
  try {
    const reason = String((req.body && req.body.reason) || '').trim();
    if (!reason || reason.length < 3) {
      return res.status(400).json({ error: 'A rejection reason (minimum 3 characters) is required.' });
    }

    await withTransaction(async (conn) => {
      const [apps] = await conn.query('SELECT * FROM registration_applications WHERE id = ? LIMIT 1 FOR UPDATE', [req.params.id]);
      if (apps.length === 0) throw new Error('Application not found.');
      const app = apps[0];

      if (!['PENDING_ADMIN_APPROVAL', 'CORRECTION_REQUIRED'].includes(app.status)) {
        const err = new Error(`Cannot reject application in "${app.status}" state.`);
        err.status = 409;
        throw err;
      }

      await conn.query(
        `UPDATE registration_applications
         SET status = 'REJECTED', adminComment = ?, reviewedByUserId = ?, reviewedAt = NOW()
         WHERE id = ?`,
        [reason, req.user.id, app.id]
      );

      await createWorkflowNotification(
        {
          applicationId: app.id,
          targetRole: 'accountant',
          targetUserId: app.submittedByUserId,
          type: 'REGISTRATION_REJECTED',
          title: `Registration Rejected — ${app.fullName}`,
          message: `${app.applicationNumber} was rejected by ${req.user.fullName}. Reason: ${reason}`,
          amountDue: Number(app.totalInitialSubmitted),
        },
        conn
      );

      await recordAuditLog(
        {
          user: req.user,
          action: 'REJECT_REGISTRATION',
          entityType: 'registration_application',
          entityId: app.id,
          previousValue: { status: app.status },
          newValue: { status: 'REJECTED' },
          reason,
          details: { applicationNumber: app.applicationNumber, fullName: app.fullName },
          ipAddress: req.ip,
        },
        conn
      );
    });

    res.json({ message: 'Application rejected and accountant notified.' });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

// POST request correction on application (ADMIN ONLY)
router.post('/:id/request-correction', requireRole('admin'), async (req, res) => {
  try {
    const reason = String((req.body && req.body.reason) || '').trim();
    if (!reason || reason.length < 3) {
      return res.status(400).json({ error: 'Please specify the required correction details.' });
    }

    await withTransaction(async (conn) => {
      const [apps] = await conn.query('SELECT * FROM registration_applications WHERE id = ? LIMIT 1 FOR UPDATE', [req.params.id]);
      if (apps.length === 0) throw new Error('Application not found.');
      const app = apps[0];

      if (app.status !== 'PENDING_ADMIN_APPROVAL') {
        const err = new Error(`Cannot request correction for application in "${app.status}" state.`);
        err.status = 409;
        throw err;
      }

      await conn.query(
        `UPDATE registration_applications
         SET status = 'CORRECTION_REQUIRED', adminComment = ?, reviewedByUserId = ?, reviewedAt = NOW()
         WHERE id = ?`,
        [reason, req.user.id, app.id]
      );

      await createWorkflowNotification(
        {
          applicationId: app.id,
          targetRole: 'accountant',
          targetUserId: app.submittedByUserId,
          type: 'CORRECTION_REQUIRED',
          title: `Correction Requested — ${app.fullName}`,
          message: `${app.applicationNumber} requires correction: ${reason}`,
          amountDue: Number(app.totalInitialSubmitted),
        },
        conn
      );

      await recordAuditLog(
        {
          user: req.user,
          action: 'REQUEST_REGISTRATION_CORRECTION',
          entityType: 'registration_application',
          entityId: app.id,
          previousValue: { status: app.status },
          newValue: { status: 'CORRECTION_REQUIRED' },
          reason,
          details: { applicationNumber: app.applicationNumber, fullName: app.fullName },
          ipAddress: req.ip,
        },
        conn
      );
    });

    res.json({ message: 'Correction requested and accountant notified.' });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

module.exports = router;
