const { randomUUID } = require('crypto');
const bcrypt = require('bcryptjs');
const { getPool, withTransaction } = require('../config/db');
const logger = require('../config/logger');
const { getAddisTodayISO, addDaysISO, addMonthsISO } = require('../utils/ethiopia');
const { generateInstallmentSchedule } = require('./feeService');

const DEFAULT_SETTINGS = {
  instituteName: 'Zacma Technology Institute',
  instituteShortName: 'ZTI Ethiopia',
  institutePhone: '+251 11 667 8900',
  instituteEmail: 'finance@zacmatech.edu.et',
  instituteRegion: 'Addis Ababa',
  instituteCity: 'Addis Ababa',
  instituteAddress: 'Bole Sub-City, Woreda 03, Addis Ababa, Ethiopia',
  currency: 'ETB',
  timezone: 'Africa/Addis_Ababa',
  reminderDaysBefore: '3',
  receiptFooterNote: 'Official training fee receipt. Valid with authorized cashier signature and institute stamp.',
};

const DEFAULT_PAYMENT_PLANS = [
  { code: 'full', name: 'Full Payment', installmentCount: 1, intervalDays: 0, description: '100% upfront fee payment upon registration' },
  { code: '2_months', name: '2-Month Installment', installmentCount: 2, intervalDays: 30, description: 'Two equal monthly installments (50% / 50%)' },
  { code: '3_months', name: '3-Month Installment', installmentCount: 3, intervalDays: 30, description: 'Three equal monthly installments' },
  { code: '6_months', name: '6-Month Installment', installmentCount: 6, intervalDays: 30, description: 'Six equal monthly installments' },
  { code: 'custom', name: 'Custom Installment Plan', installmentCount: 2, intervalDays: 30, description: 'Administrator-configured custom payment schedule' },
];

const DEFAULT_COURSES = [
  {
    code: 'GD-101',
    name: 'Graphic Design',
    category: 'Design & Media',
    description: 'Adobe Photoshop, Illustrator, InDesign, brand identity, and print/social media production.',
    durationValue: 3,
    durationUnit: 'months',
    registrationFee: 500,
    defaultFee: 12000,
    maxCapacity: 30,
    availablePlans: ['full', '2_months', '3_months', 'custom'],
  },
  {
    code: 'DM-102',
    name: 'Digital Marketing',
    category: 'Business & Marketing',
    description: 'Social media strategy, Google Ads, SEO, content marketing, and local Ethiopian e-commerce growth.',
    durationValue: 2,
    durationUnit: 'months',
    registrationFee: 500,
    defaultFee: 9500,
    maxCapacity: 35,
    availablePlans: ['full', '2_months', 'custom'],
  },
  {
    code: 'CF-103',
    name: 'Computer Fundamentals',
    category: 'Office & Productivity',
    description: 'Essential office productivity (Word, Excel, PowerPoint), file management, and internet literacy.',
    durationValue: 6,
    durationUnit: 'weeks',
    registrationFee: 350,
    defaultFee: 4500,
    maxCapacity: 40,
    availablePlans: ['full', '2_months', 'custom'],
  },
  {
    code: 'CM-104',
    name: 'Computer Maintenance',
    category: 'Hardware & Networking',
    description: 'PC hardware diagnostics, laptop repair, OS installation, networking basics, and troubleshooting.',
    durationValue: 3,
    durationUnit: 'months',
    registrationFee: 500,
    defaultFee: 11000,
    maxCapacity: 25,
    availablePlans: ['full', '2_months', '3_months', 'custom'],
  },
  {
    code: 'CC-105',
    name: 'CCTV Installation',
    category: 'Security & Electronics',
    description: 'IP & analog surveillance camera setup, NVR/DVR configuration, cabling, and remote monitoring.',
    durationValue: 2,
    durationUnit: 'months',
    registrationFee: 600,
    defaultFee: 14000,
    maxCapacity: 25,
    availablePlans: ['full', '2_months', 'custom'],
  },
  {
    code: 'WD-106',
    name: 'Web Development',
    category: 'Software Engineering',
    description: 'HTML5, CSS3, JavaScript, Node.js, MySQL, and full-stack responsive web application development.',
    durationValue: 4,
    durationUnit: 'months',
    registrationFee: 700,
    defaultFee: 18000,
    maxCapacity: 30,
    availablePlans: ['full', '2_months', '3_months', '6_months', 'custom'],
  },
  {
    code: 'MD-107',
    name: 'Mobile Application Development',
    category: 'Software Engineering',
    description: 'Cross-platform Android and iOS app engineering with modern state management and REST APIs.',
    durationValue: 4,
    durationUnit: 'months',
    registrationFee: 700,
    defaultFee: 20000,
    maxCapacity: 25,
    availablePlans: ['full', '2_months', '3_months', '6_months', 'custom'],
  },
  {
    code: 'EN-108',
    name: 'English Language',
    category: 'Languages',
    description: 'Spoken communication, business writing, workplace fluency, and technical presentation skills.',
    durationValue: 3,
    durationUnit: 'months',
    registrationFee: 400,
    defaultFee: 7500,
    maxCapacity: 35,
    availablePlans: ['full', '2_months', '3_months', 'custom'],
  },
  {
    code: 'OM-109',
    name: 'Office Machine Maintenance',
    category: 'Hardware & Electronics',
    description: 'Printer, photocopier, scanner diagnostics, preventive servicing, and spare-parts calibration.',
    durationValue: 3,
    durationUnit: 'months',
    registrationFee: 500,
    defaultFee: 12500,
    maxCapacity: 20,
    availablePlans: ['full', '2_months', '3_months', 'custom'],
  },
];

async function ensureBaselineCatalog() {
  const pool = getPool();

  // 0. Ensure roles table entries exist (single batch insert)
  const defaultRoles = [
    [randomUUID(), 'admin', 'Administrator', 'Full institute management, approvals, courses, attendance, and audit control'],
    [randomUUID(), 'accountant', 'Accountant', 'Student registration intake and payment submission for administrator approval'],
  ];
  await pool.query(
    'INSERT IGNORE INTO roles (id, code, name, description) VALUES ?',
    [defaultRoles]
  );
  const [roleRows] = await pool.query('SELECT id, code FROM roles');
  const roleIdByCode = Object.fromEntries(roleRows.map((r) => [r.code, r.id]));

  // 1. Ensure default settings & upgrade legacy default institute branding (single batch insert)
  const settingsRows = Object.entries(DEFAULT_SETTINGS).map(([key, val]) => [key, val, 'system']);
  if (settingsRows.length > 0) {
    await pool.query(
      'INSERT IGNORE INTO settings (settingKey, settingValue, updatedBy) VALUES ?',
      [settingsRows]
    );
  }
  await pool.query(
    `UPDATE settings
     SET settingValue = CASE
       WHEN settingKey = 'instituteName' AND settingValue = 'Addis Skills & Technology Institute' THEN 'Zacma Technology Institute'
       WHEN settingKey = 'instituteShortName' AND settingValue = 'ASTI Ethiopia' THEN 'ZTI Ethiopia'
       WHEN settingKey = 'instituteEmail' AND settingValue = 'finance@addisskills.edu.et' THEN 'finance@zacmatech.edu.et'
       ELSE settingValue
     END
     WHERE (settingKey = 'instituteName' AND settingValue = 'Addis Skills & Technology Institute')
        OR (settingKey = 'instituteShortName' AND settingValue = 'ASTI Ethiopia')
        OR (settingKey = 'instituteEmail' AND settingValue = 'finance@addisskills.edu.et')`
  );

  // 2. Ensure default payment plans (single batch insert)
  const planRows = DEFAULT_PAYMENT_PLANS.map((plan) => [
    randomUUID(),
    plan.code,
    plan.name,
    plan.installmentCount,
    plan.intervalDays,
    plan.description,
    1,
  ]);
  await pool.query(
    'INSERT IGNORE INTO payment_plans (id, code, name, installmentCount, intervalDays, description, isActive) VALUES ?',
    [planRows]
  );

  // 3. Ensure default courses exist (single check + batch insert for missing defaults)
  const [existingCourses] = await pool.query('SELECT code, name FROM courses');
  const existingCodes = new Set(existingCourses.map((c) => c.code));
  const existingNames = new Set(existingCourses.map((c) => c.name));
  const missingCourses = DEFAULT_COURSES.filter(
    (c) => !existingCodes.has(c.code) && !existingNames.has(c.name)
  ).map((c) => [
    randomUUID(),
    c.code,
    c.name,
    c.category,
    c.description,
    c.durationValue,
    c.durationUnit,
    c.registrationFee,
    c.defaultFee,
    JSON.stringify(c.availablePlans),
    c.maxCapacity,
    'Active',
  ]);
  if (missingCourses.length > 0) {
    await pool.query(
      `INSERT INTO courses (id, code, name, category, description, durationValue, durationUnit, registrationFee, defaultFee, availablePlans, maxCapacity, status)
       VALUES ?`,
      [missingCourses]
    );
  }

  // 4. Bootstrap initial admin ONLY if users table is empty AND env vars are explicitly provided
  const [[userCount]] = await pool.query('SELECT COUNT(*) AS cnt FROM users');
  if (userCount.cnt === 0) {
    const initUser = (process.env.ADMIN_INIT_USERNAME || '').trim();
    const initPass = process.env.ADMIN_INIT_PASSWORD || '';
    const initName = (process.env.ADMIN_INIT_FULLNAME || 'Institute Administrator').trim();

    if (initUser && initPass) {
      const rounds = parseInt(process.env.BCRYPT_ROUNDS || '10', 10);
      const passwordHash = await bcrypt.hash(initPass, rounds);
      await pool.query(
        `INSERT INTO users (id, username, fullName, email, phone, passwordHash, role, roleId, isActive)
         VALUES (?, ?, ?, ?, ?, ?, 'admin', ?, 1)`,
        [randomUUID(), initUser, initName, 'admin@zacmatech.edu.et', '+251911000001', passwordHash, roleIdByCode.admin || null]
      );
      logger.info('Bootstrapped initial admin account from environment config', { username: initUser });
    }
  }

  // 5. Bootstrap configured accountant if set in env and not yet present by username
  const accUser = (process.env.ACCOUNTANT_INIT_USERNAME || '').trim().toLowerCase();
  const accPass = process.env.ACCOUNTANT_INIT_PASSWORD || '';
  const accName = (process.env.ACCOUNTANT_INIT_FULLNAME || 'Institute Accountant').trim();
  if (accUser && accPass) {
    const [[existingAcc]] = await pool.query('SELECT COUNT(*) AS cnt FROM users WHERE username = ?', [accUser]);
    if (existingAcc.cnt === 0) {
      const rounds = parseInt(process.env.BCRYPT_ROUNDS || '10', 10);
      const passwordHash = await bcrypt.hash(accPass, rounds);
      await pool.query(
        `INSERT IGNORE INTO users (id, username, fullName, email, phone, passwordHash, role, roleId, isActive)
         VALUES (?, ?, ?, ?, ?, ?, 'accountant', ?, 1)`,
        [randomUUID(), accUser, accName, 'accountant@zacmatech.edu.et', '+251911000002', passwordHash, roleIdByCode.accountant || null]
      );
      logger.info('Bootstrapped initial accountant account from environment config', { username: accUser });
    }
  }

  // Link any existing users missing roleId
  await pool.query("UPDATE users SET roleId = ? WHERE role = 'admin' AND roleId IS NULL", [roleIdByCode.admin || null]);
  await pool.query("UPDATE users SET roleId = ? WHERE role = 'accountant' AND roleId IS NULL", [roleIdByCode.accountant || null]);
}

/**
 * Seeds realistic Ethiopian short-term training institute records (for evaluation/testing).
 * Idempotent: skips if students already exist.
 */
async function seedRealisticEthiopianData() {
  const pool = getPool();
  await ensureBaselineCatalog();

  const [[studentCount]] = await pool.query('SELECT COUNT(*) AS cnt FROM students');
  if (studentCount.cnt > 0) {
    return { skipped: true, message: 'Students already exist; sample seed skipped.' };
  }

  const [courses] = await pool.query('SELECT * FROM courses');
  const [plans] = await pool.query('SELECT * FROM payment_plans');
  const [users] = await pool.query('SELECT * FROM users ORDER BY createdAt ASC LIMIT 1');
  const receiverUser = users[0] || null;
  const receiverName = receiverUser ? receiverUser.fullName : 'Abebaw Tadesse';

  const courseByName = Object.fromEntries(courses.map((c) => [c.name, c]));
  const planByCode = Object.fromEntries(plans.map((p) => [p.code, p]));
  const today = getAddisTodayISO();
  const year = today.slice(0, 4);

  const sampleRecords = [
    {
      code: `ZTI-${year}-0001`,
      fullName: 'Abebe Kebede',
      gender: 'Male',
      phone: '+251911234567',
      altPhone: '+251911998877',
      email: 'abebe.kebede@example.et',
      region: 'Addis Ababa',
      city: 'Addis Ababa',
      address: 'Bole Sub-City, Woreda 03',
      course: 'Graphic Design',
      plan: '3_months',
      status: 'Active',
      regDate: addMonthsISO(today, -1),
      startDate: addMonthsISO(today, -1),
      gradDate: addMonthsISO(today, 2),
      firstDue: addMonthsISO(today, -1),
      payments: [
        { amount: 4000, date: addMonthsISO(today, -1), method: 'Cash', ref: 'CSH-001', notes: 'Month 1 installment' },
        { amount: 2000, date: addDaysISO(today, -5), method: 'Mobile Money', ref: 'TELEBIRR-984321', notes: 'Partial Month 2 payment' },
      ],
    },
    {
      code: `ZTI-${year}-0002`,
      fullName: 'Tigist Alemu',
      gender: 'Female',
      phone: '+251922345678',
      altPhone: '',
      email: 'tigist.alemu@example.et',
      region: 'Addis Ababa',
      city: 'Addis Ababa',
      address: 'Yeka Sub-City, Megenagna',
      course: 'Web Development',
      plan: '3_months',
      status: 'Active',
      regDate: addMonthsISO(today, -2),
      startDate: addMonthsISO(today, -2),
      gradDate: addMonthsISO(today, 2),
      firstDue: addMonthsISO(today, -2),
      payments: [
        { amount: 6000, date: addMonthsISO(today, -2), method: 'Bank Transfer', ref: 'CBE-7741290', notes: 'Month 1 CBE transfer' },
      ],
    },
    {
      code: `ZTI-${year}-0003`,
      fullName: 'Dawit Mekonnen',
      gender: 'Male',
      phone: '+251913456789',
      altPhone: '',
      email: 'dawit.m@example.et',
      region: 'Oromia',
      city: 'Adama',
      address: 'Kebele 04, Adama',
      course: 'CCTV Installation',
      plan: 'full',
      status: 'Graduated',
      regDate: addMonthsISO(today, -3),
      startDate: addMonthsISO(today, -3),
      gradDate: addMonthsISO(today, -1),
      firstDue: addMonthsISO(today, -3),
      payments: [
        { amount: 14000, date: addMonthsISO(today, -3), method: 'Bank Transfer', ref: 'AWASH-331029', notes: 'Full tuition settled' },
      ],
    },
    {
      code: `ZTI-${year}-0004`,
      fullName: 'Selamawit Bekele',
      gender: 'Female',
      phone: '+251914567890',
      altPhone: '+251711223344',
      email: 'selam.bekele@example.et',
      region: 'Addis Ababa',
      city: 'Addis Ababa',
      address: 'Kirkos Sub-City, Kasanchis',
      course: 'Digital Marketing',
      plan: '2_months',
      status: 'Active',
      regDate: addDaysISO(today, -28),
      startDate: addDaysISO(today, -28),
      gradDate: addDaysISO(today, 32),
      firstDue: addDaysISO(today, -28),
      payments: [
        { amount: 4750, date: addDaysISO(today, -28), method: 'Mobile Money', ref: 'TELEBIRR-551902', notes: 'First installment' },
      ],
    },
    {
      code: `ZTI-${year}-0005`,
      fullName: 'Bereket Haile',
      gender: 'Male',
      phone: '+251933112233',
      altPhone: '',
      email: '',
      region: 'Amhara',
      city: 'Bahir Dar',
      address: 'Tana Sub-City, Kebele 02',
      course: 'Computer Maintenance',
      plan: '3_months',
      status: 'Active',
      regDate: addDaysISO(today, -10),
      startDate: addDaysISO(today, -10),
      gradDate: addMonthsISO(today, 3),
      firstDue: today,
      payments: [],
    },
    {
      code: `ZTI-${year}-0006`,
      fullName: 'Hanna Girma',
      gender: 'Female',
      phone: '+251944556677',
      altPhone: '',
      email: 'hanna.girma@example.et',
      region: 'Sidama',
      city: 'Hawassa',
      address: 'Tabor Sub-City, Hawassa',
      course: 'Mobile Application Development',
      plan: '6_months',
      status: 'Active',
      regDate: addMonthsISO(today, -1),
      startDate: addMonthsISO(today, -1),
      gradDate: addMonthsISO(today, 3),
      firstDue: addDaysISO(today, -32),
      payments: [
        { amount: 3333.33, date: addMonthsISO(today, -1), method: 'Bank Transfer', ref: 'BOA-902114', notes: 'Installment 1' },
      ],
    },
    {
      code: `ZTI-${year}-0007`,
      fullName: 'Yohannes Tesfaye',
      gender: 'Male',
      phone: '+251911887766',
      altPhone: '',
      email: 'yohannes.t@example.et',
      region: 'Addis Ababa',
      city: 'Addis Ababa',
      address: 'Nifas Silk Lafto, Lebu',
      course: 'Computer Fundamentals',
      plan: 'full',
      status: 'Graduated',
      regDate: addMonthsISO(today, -2),
      startDate: addMonthsISO(today, -2),
      gradDate: addDaysISO(today, -15),
      firstDue: addMonthsISO(today, -2),
      payments: [
        { amount: 4500, date: addMonthsISO(today, -2), method: 'Cash', ref: 'CSH-009', notes: 'Paid in full at reception' },
      ],
    },
    {
      code: `ZTI-${year}-0008`,
      fullName: 'Meron Tadesse',
      gender: 'Female',
      phone: '+251966778899',
      altPhone: '',
      email: 'meron.tadesse@example.et',
      region: 'Dire Dawa',
      city: 'Dire Dawa',
      address: 'Kezira, Dire Dawa',
      course: 'English Language',
      plan: '2_months',
      status: 'Active',
      regDate: addDaysISO(today, -5),
      startDate: today,
      gradDate: addMonthsISO(today, 3),
      firstDue: addDaysISO(today, 2),
      payments: [
        { amount: 3750, date: today, method: 'Mobile Money', ref: 'MPESA-ET-10293', notes: 'First installment paid today' },
      ],
    },
  ];

  await withTransaction(async (conn) => {
    let receiptCounter = 1;

    for (const rec of sampleRecords) {
      const course = courseByName[rec.course];
      const plan = planByCode[rec.plan];
      if (!course || !plan) continue;

      const studentId = randomUUID();
      const enrollmentId = randomUUID();

      await conn.query(
        `INSERT INTO students
         (id, studentCode, fullName, gender, phone, altPhone, email, region, city, address, registrationDate, status, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '')`,
        [
          studentId,
          rec.code,
          rec.fullName,
          rec.gender,
          rec.phone,
          rec.altPhone,
          rec.email,
          rec.region,
          rec.city,
          rec.address,
          rec.regDate,
          rec.status,
        ]
      );

      await conn.query(
        `INSERT INTO enrollments
         (id, studentId, courseId, paymentPlanId, courseStartDate, expectedGraduationDate, totalCourseFee, assignedDueDate, enrollmentStatus)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          enrollmentId,
          studentId,
          course.id,
          plan.id,
          rec.startDate,
          rec.gradDate,
          course.defaultFee,
          rec.firstDue,
          rec.status === 'Graduated' ? 'Completed' : 'Active',
        ]
      );

      const schedule = generateInstallmentSchedule({
        enrollmentId,
        studentId,
        totalCourseFee: course.defaultFee,
        planCode: plan.code,
        firstDueDate: rec.firstDue,
      });

      for (const inst of schedule) {
        await conn.query(
          `INSERT INTO installments (id, enrollmentId, studentId, installmentNumber, title, expectedAmount, dueDate, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [inst.id, inst.enrollmentId, inst.studentId, inst.installmentNumber, inst.title, inst.expectedAmount, inst.dueDate, inst.notes]
        );
      }

      let cumulativePaid = 0;
      for (const pay of rec.payments) {
        const txnUuid = randomUUID();
        const txnCode = `TXN-${pay.date.replace(/-/g, '')}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
        const prevBalance = Number(course.defaultFee) - cumulativePaid;
        cumulativePaid += Number(pay.amount);
        const remBalance = Math.max(0, Number(course.defaultFee) - cumulativePaid);

        await conn.query(
          `INSERT INTO transactions
           (id, transactionId, studentId, enrollmentId, amountPaid, paymentDate, paymentMethod, transactionReference, receivedByUserId, receivedByName, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            txnUuid,
            txnCode,
            studentId,
            enrollmentId,
            pay.amount,
            pay.date,
            pay.method,
            pay.ref,
            receiverUser ? receiverUser.id : null,
            receiverName,
            pay.notes,
          ]
        );

        const rcpNo = `RCP-${year}-${String(receiptCounter++).padStart(4, '0')}`;
        await conn.query(
          `INSERT INTO receipts
           (id, receiptNumber, transactionId, studentId, enrollmentId, amountPaid, previousBalance, remainingBalance, issuedBy)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            randomUUID(),
            rcpNo,
            txnUuid,
            studentId,
            enrollmentId,
            pay.amount,
            prevBalance,
            remBalance,
            receiverName,
          ]
        );
      }
    }
  });

  logger.info('Seeded realistic Ethiopian institute sample records', { count: sampleRecords.length });
  return { skipped: false, seededStudents: sampleRecords.length };
}

module.exports = {
  ensureBaselineCatalog,
  seedRealisticEthiopianData,
  DEFAULT_SETTINGS,
};
