-- =============================================================================
-- BirrLedger — Role-Based Student & Fee Management System (Ethiopia)
-- Normalized MySQL / MariaDB Schema (UTF8MB4)
-- =============================================================================

CREATE DATABASE IF NOT EXISTS `sfmt_ethiopia`
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE `sfmt_ethiopia`;

-- 1. Roles Catalog
CREATE TABLE IF NOT EXISTS roles (
  id CHAR(36) PRIMARY KEY,
  code ENUM('admin', 'accountant') NOT NULL UNIQUE,
  name VARCHAR(80) NOT NULL,
  description VARCHAR(255) DEFAULT '',
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. Users (RBAC: Administrator & Accountant)
CREATE TABLE IF NOT EXISTS users (
  id CHAR(36) PRIMARY KEY,
  username VARCHAR(80) NOT NULL UNIQUE,
  firebaseUid VARCHAR(128) NULL UNIQUE,
  fullName VARCHAR(150) NOT NULL,
  email VARCHAR(150) NULL UNIQUE,
  phone VARCHAR(30) DEFAULT '',
  passwordHash VARCHAR(255) NOT NULL,
  role ENUM('admin', 'accountant') NOT NULL DEFAULT 'accountant',
  roleId CHAR(36) NULL,
  isActive TINYINT(1) NOT NULL DEFAULT 1,
  lastLoginAt DATETIME NULL,
  createdByUserId CHAR(36) NULL,
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_users_role FOREIGN KEY (roleId) REFERENCES roles(id) ON DELETE SET NULL ON UPDATE CASCADE,
  INDEX idx_users_role (role),
  INDEX idx_users_active (isActive)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. Courses (Short-Term Professional Training Programs — Admin Managed)
CREATE TABLE IF NOT EXISTS courses (
  id CHAR(36) PRIMARY KEY,
  code VARCHAR(30) NOT NULL UNIQUE,
  name VARCHAR(150) NOT NULL UNIQUE,
  category VARCHAR(100) NOT NULL DEFAULT 'Technology',
  description TEXT,
  durationValue INT NOT NULL DEFAULT 3,
  durationUnit ENUM('weeks', 'months') NOT NULL DEFAULT 'months',
  registrationFee DECIMAL(12, 2) NOT NULL DEFAULT 500.00,
  defaultFee DECIMAL(12, 2) NOT NULL,
  availablePlans JSON NOT NULL,
  startDate DATE NULL,
  endDate DATE NULL,
  maxCapacity INT NOT NULL DEFAULT 30,
  status ENUM('Active', 'Inactive') NOT NULL DEFAULT 'Active',
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_courses_status (status),
  INDEX idx_courses_category (category)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. Payment Plans
CREATE TABLE IF NOT EXISTS payment_plans (
  id CHAR(36) PRIMARY KEY,
  code VARCHAR(40) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  installmentCount INT NOT NULL DEFAULT 1,
  intervalDays INT NOT NULL DEFAULT 30,
  description VARCHAR(255) DEFAULT '',
  isActive TINYINT(1) NOT NULL DEFAULT 1,
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 5. Official Students Database (Only Admin-Approved or Admin-Registered Students)
CREATE TABLE IF NOT EXISTS students (
  id CHAR(36) PRIMARY KEY,
  studentCode VARCHAR(40) NOT NULL UNIQUE,
  fullName VARCHAR(150) NOT NULL,
  gender ENUM('Male', 'Female', 'Other', '') NOT NULL DEFAULT '',
  phone VARCHAR(30) NOT NULL,
  altPhone VARCHAR(30) DEFAULT '',
  email VARCHAR(150) DEFAULT '',
  region VARCHAR(80) NOT NULL DEFAULT 'Addis Ababa',
  city VARCHAR(80) NOT NULL DEFAULT 'Addis Ababa',
  address VARCHAR(255) DEFAULT '',
  emergencyContactName VARCHAR(150) DEFAULT '',
  emergencyContactPhone VARCHAR(30) DEFAULT '',
  emergencyContactRelation VARCHAR(80) DEFAULT '',
  nationalIdNumber VARCHAR(60) DEFAULT '',
  documentsNote TEXT,
  registrationDate DATE NOT NULL,
  status ENUM('Active', 'Graduated', 'Suspended', 'Archived') NOT NULL DEFAULT 'Active',
  notes TEXT,
  registeredByUserId CHAR(36) NULL,
  approvedByUserId CHAR(36) NULL,
  approvedAt DATETIME NULL,
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_students_reg_user FOREIGN KEY (registeredByUserId) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_students_app_user FOREIGN KEY (approvedByUserId) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE,
  INDEX idx_students_name (fullName),
  INDEX idx_students_phone (phone),
  INDEX idx_students_status (status),
  INDEX idx_students_regdate (registrationDate)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 6. Enrollments (Links Student, Course, Payment Plan & Official Fee Agreement)
CREATE TABLE IF NOT EXISTS enrollments (
  id CHAR(36) PRIMARY KEY,
  studentId CHAR(36) NOT NULL,
  courseId CHAR(36) NOT NULL,
  paymentPlanId CHAR(36) NOT NULL,
  batchName VARCHAR(80) NOT NULL DEFAULT 'Batch A',
  courseStartDate DATE NOT NULL,
  expectedGraduationDate DATE NOT NULL,
  registrationFee DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  totalCourseFee DECIMAL(12, 2) NOT NULL,
  assignedDueDate DATE NOT NULL,
  enrollmentStatus ENUM('Active', 'Completed', 'Dropped', 'Archived') NOT NULL DEFAULT 'Active',
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_enrollments_student FOREIGN KEY (studentId) REFERENCES students(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_enrollments_course FOREIGN KEY (courseId) REFERENCES courses(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_enrollments_plan FOREIGN KEY (paymentPlanId) REFERENCES payment_plans(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  INDEX idx_enrollments_student (studentId),
  INDEX idx_enrollments_course (courseId),
  INDEX idx_enrollments_status (enrollmentStatus),
  INDEX idx_enrollments_duedate (assignedDueDate)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 7. Student Registration Applications (Accountant Submissions -> Admin Approval)
CREATE TABLE IF NOT EXISTS registration_applications (
  id CHAR(36) PRIMARY KEY,
  applicationNumber VARCHAR(40) NOT NULL UNIQUE,
  submissionRef VARCHAR(60) NOT NULL UNIQUE,
  submittedByUserId CHAR(36) NOT NULL,
  submittedByName VARCHAR(150) NOT NULL,
  fullName VARCHAR(150) NOT NULL,
  gender ENUM('Male', 'Female', 'Other', '') NOT NULL DEFAULT '',
  phone VARCHAR(30) NOT NULL,
  altPhone VARCHAR(30) DEFAULT '',
  email VARCHAR(150) DEFAULT '',
  region VARCHAR(80) NOT NULL DEFAULT 'Addis Ababa',
  city VARCHAR(80) NOT NULL DEFAULT 'Addis Ababa',
  address VARCHAR(255) DEFAULT '',
  emergencyContactName VARCHAR(150) DEFAULT '',
  emergencyContactPhone VARCHAR(30) DEFAULT '',
  emergencyContactRelation VARCHAR(80) DEFAULT '',
  nationalIdNumber VARCHAR(60) DEFAULT '',
  documentsNote TEXT,
  courseId CHAR(36) NOT NULL,
  paymentPlanCode VARCHAR(40) NOT NULL DEFAULT 'full',
  officialRegistrationFee DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  officialCourseFee DECIMAL(12, 2) NOT NULL,
  initialRegistrationPaid DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  initialCoursePaid DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  totalInitialSubmitted DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  paymentMethod ENUM('Cash', 'Bank Transfer', 'Mobile Money', 'Other') NOT NULL DEFAULT 'Cash',
  transactionReference VARCHAR(150) DEFAULT '',
  submissionNotes TEXT,
  registrationDate DATE NOT NULL,
  courseStartDate DATE NOT NULL,
  expectedGraduationDate DATE NOT NULL,
  assignedDueDate DATE NOT NULL,
  customInstallments JSON NULL,
  status ENUM('PENDING_ADMIN_APPROVAL', 'APPROVED', 'REJECTED', 'CORRECTION_REQUIRED') NOT NULL DEFAULT 'PENDING_ADMIN_APPROVAL',
  adminComment TEXT,
  reviewedByUserId CHAR(36) NULL,
  reviewedAt DATETIME NULL,
  approvedStudentId CHAR(36) NULL,
  approvedEnrollmentId CHAR(36) NULL,
  approvedTransactionId CHAR(36) NULL,
  approvedReceiptId CHAR(36) NULL,
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_regapp_submitter FOREIGN KEY (submittedByUserId) REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_regapp_course FOREIGN KEY (courseId) REFERENCES courses(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_regapp_reviewer FOREIGN KEY (reviewedByUserId) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE,
  INDEX idx_regapp_status (status),
  INDEX idx_regapp_submitter (submittedByUserId),
  INDEX idx_regapp_created (createdAt)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 7b. Application Uploaded Documents (Authenticated storage, never public)
CREATE TABLE IF NOT EXISTS application_documents (
  id CHAR(36) PRIMARY KEY,
  applicationId CHAR(36) NOT NULL,
  fileName VARCHAR(255) NOT NULL,
  mimeType VARCHAR(120) NOT NULL,
  fileSize INT NOT NULL,
  contentBase64 MEDIUMTEXT NOT NULL,
  uploadedByUserId CHAR(36) NOT NULL,
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_appdoc_app FOREIGN KEY (applicationId) REFERENCES registration_applications(id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_appdoc_user FOREIGN KEY (uploadedByUserId) REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  INDEX idx_appdoc_app (applicationId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 8. Installments (Auto-generated & Admin-adjustable Fee Schedule)
CREATE TABLE IF NOT EXISTS installments (
  id CHAR(36) PRIMARY KEY,
  enrollmentId CHAR(36) NOT NULL,
  studentId CHAR(36) NOT NULL,
  installmentNumber INT NOT NULL,
  title VARCHAR(100) NOT NULL,
  expectedAmount DECIMAL(12, 2) NOT NULL,
  dueDate DATE NOT NULL,
  notes VARCHAR(255) DEFAULT '',
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_installments_enrollment FOREIGN KEY (enrollmentId) REFERENCES enrollments(id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_installments_student FOREIGN KEY (studentId) REFERENCES students(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  UNIQUE KEY uq_enrollment_installment_num (enrollmentId, installmentNumber),
  INDEX idx_installments_due (dueDate),
  INDEX idx_installments_student (studentId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 9. Payment Submissions (Accountant Pending Submissions -> Admin Approval)
CREATE TABLE IF NOT EXISTS payment_submissions (
  id CHAR(36) PRIMARY KEY,
  submissionRef VARCHAR(60) NOT NULL UNIQUE,
  studentId CHAR(36) NOT NULL,
  enrollmentId CHAR(36) NOT NULL,
  submittedByUserId CHAR(36) NOT NULL,
  submittedByName VARCHAR(150) NOT NULL,
  amountSubmitted DECIMAL(12, 2) NOT NULL,
  paymentDate DATE NOT NULL,
  paymentMethod ENUM('Cash', 'Bank Transfer', 'Mobile Money', 'Other') NOT NULL DEFAULT 'Cash',
  transactionReference VARCHAR(150) DEFAULT '',
  notes TEXT,
  status ENUM('PENDING', 'APPROVED', 'REJECTED') NOT NULL DEFAULT 'PENDING',
  rejectionReason TEXT,
  reviewedByUserId CHAR(36) NULL,
  reviewedAt DATETIME NULL,
  approvedTransactionId CHAR(36) NULL,
  approvedReceiptId CHAR(36) NULL,
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_paysub_student FOREIGN KEY (studentId) REFERENCES students(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_paysub_enrollment FOREIGN KEY (enrollmentId) REFERENCES enrollments(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_paysub_submitter FOREIGN KEY (submittedByUserId) REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_paysub_reviewer FOREIGN KEY (reviewedByUserId) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE,
  INDEX idx_paysub_status (status),
  INDEX idx_paysub_student (studentId),
  INDEX idx_paysub_submitter (submittedByUserId),
  INDEX idx_paysub_created (createdAt)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 10. Official Transactions (Immutable Verified & Approved Financial Ledger)
CREATE TABLE IF NOT EXISTS transactions (
  id CHAR(36) PRIMARY KEY,
  transactionId VARCHAR(60) NOT NULL UNIQUE,
  studentId CHAR(36) NOT NULL,
  enrollmentId CHAR(36) NOT NULL,
  submissionId CHAR(36) NULL,
  paymentCategory ENUM('COURSE_FEE', 'REGISTRATION_FEE', 'COMBINED') NOT NULL DEFAULT 'COURSE_FEE',
  registrationAmount DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  tuitionAmount DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  amountPaid DECIMAL(12, 2) NOT NULL,
  paymentDate DATE NOT NULL,
  paymentMethod ENUM('Cash', 'Bank Transfer', 'Mobile Money', 'Other') NOT NULL DEFAULT 'Cash',
  transactionReference VARCHAR(150) DEFAULT '',
  receivedByUserId CHAR(36) NULL,
  receivedByName VARCHAR(150) NOT NULL,
  approvedByUserId CHAR(36) NULL,
  approvedAt DATETIME NULL,
  isAdjustment TINYINT(1) NOT NULL DEFAULT 0,
  adjustmentReason VARCHAR(255) DEFAULT '',
  notes TEXT,
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_transactions_student FOREIGN KEY (studentId) REFERENCES students(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_transactions_enrollment FOREIGN KEY (enrollmentId) REFERENCES enrollments(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_transactions_user FOREIGN KEY (receivedByUserId) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_transactions_approver FOREIGN KEY (approvedByUserId) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE,
  INDEX idx_transactions_student (studentId),
  INDEX idx_transactions_enrollment (enrollmentId),
  INDEX idx_transactions_date (paymentDate),
  INDEX idx_transactions_method (paymentMethod),
  INDEX idx_transactions_created (createdAt)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 11. Official Receipts (Generated ONLY after Admin Approval or Admin Direct Recording)
CREATE TABLE IF NOT EXISTS receipts (
  id CHAR(36) PRIMARY KEY,
  receiptNumber VARCHAR(60) NOT NULL UNIQUE,
  transactionId CHAR(36) NOT NULL UNIQUE,
  studentId CHAR(36) NOT NULL,
  enrollmentId CHAR(36) NOT NULL,
  amountPaid DECIMAL(12, 2) NOT NULL,
  previousBalance DECIMAL(12, 2) NOT NULL,
  remainingBalance DECIMAL(12, 2) NOT NULL,
  issuedBy VARCHAR(150) NOT NULL,
  approvedByUserId CHAR(36) NULL,
  issuedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_receipts_transaction FOREIGN KEY (transactionId) REFERENCES transactions(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_receipts_student FOREIGN KEY (studentId) REFERENCES students(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_receipts_enrollment FOREIGN KEY (enrollmentId) REFERENCES enrollments(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_receipts_approver FOREIGN KEY (approvedByUserId) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE,
  INDEX idx_receipts_student (studentId),
  INDEX idx_receipts_issued (issuedAt)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 12. Student Attendance (Admin Only)
CREATE TABLE IF NOT EXISTS attendance (
  id CHAR(36) PRIMARY KEY,
  studentId CHAR(36) NOT NULL,
  enrollmentId CHAR(36) NOT NULL,
  courseId CHAR(36) NOT NULL,
  batchName VARCHAR(80) NOT NULL DEFAULT 'Batch A',
  attendanceDate DATE NOT NULL,
  status ENUM('PRESENT', 'ABSENT', 'LATE', 'EXCUSED') NOT NULL DEFAULT 'PRESENT',
  notes VARCHAR(255) DEFAULT '',
  editReason VARCHAR(255) DEFAULT '',
  recordedByUserId CHAR(36) NULL,
  updatedByUserId CHAR(36) NULL,
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_attendance_student FOREIGN KEY (studentId) REFERENCES students(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_attendance_enrollment FOREIGN KEY (enrollmentId) REFERENCES enrollments(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_attendance_course FOREIGN KEY (courseId) REFERENCES courses(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_attendance_recorder FOREIGN KEY (recordedByUserId) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_attendance_updater FOREIGN KEY (updatedByUserId) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE,
  UNIQUE KEY uq_attendance_student_course_date (studentId, courseId, attendanceDate),
  INDEX idx_attendance_date (attendanceDate),
  INDEX idx_attendance_course_date (courseId, attendanceDate),
  INDEX idx_attendance_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 13. Notifications (Role-Targeted Workflow & Due Alerts)
CREATE TABLE IF NOT EXISTS notifications (
  id CHAR(36) PRIMARY KEY,
  studentId CHAR(36) NULL,
  enrollmentId CHAR(36) NULL,
  installmentId CHAR(36) NULL,
  applicationId CHAR(36) NULL,
  paymentSubmissionId CHAR(36) NULL,
  targetRole ENUM('all', 'admin', 'accountant') NOT NULL DEFAULT 'all',
  targetUserId CHAR(36) NULL,
  type ENUM(
    'DUE_TODAY', 'DUE_SOON', 'OVERDUE', 'UNPAID_INSTALLMENT', 'OUTSTANDING_BALANCE',
    'NEW_REGISTRATION', 'NEW_PAYMENT_SUBMISSION',
    'REGISTRATION_APPROVED', 'REGISTRATION_REJECTED', 'CORRECTION_REQUIRED',
    'PAYMENT_APPROVED', 'PAYMENT_REJECTED', 'STUDENT_MESSAGE'
  ) NOT NULL,
  dedupeKey VARCHAR(160) NOT NULL UNIQUE,
  title VARCHAR(200) NOT NULL,
  message TEXT NOT NULL,
  amountDue DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  dueDate DATE NOT NULL,
  overdueDays INT NOT NULL DEFAULT 0,
  channelStatus ENUM('IN_APP_ONLY', 'WHATSAPP_NOT_CONFIGURED', 'SMS_NOT_CONFIGURED', 'EMAIL_NOT_CONFIGURED', 'PARTIAL', 'SENT', 'FAILED') NOT NULL DEFAULT 'IN_APP_ONLY',
  isRead TINYINT(1) NOT NULL DEFAULT 0,
  readAt DATETIME NULL,
  readByUserId CHAR(36) NULL,
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_notifications_student FOREIGN KEY (studentId) REFERENCES students(id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_notifications_enrollment FOREIGN KEY (enrollmentId) REFERENCES enrollments(id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_notifications_installment FOREIGN KEY (installmentId) REFERENCES installments(id) ON DELETE SET NULL ON UPDATE CASCADE,
  INDEX idx_notifications_read (isRead),
  INDEX idx_notifications_type (type),
  INDEX idx_notifications_target (targetRole, targetUserId),
  INDEX idx_notifications_created (createdAt)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 14. Audit Logs (Comprehensive Security & Financial Change Trail)
CREATE TABLE IF NOT EXISTS audit_logs (
  id CHAR(36) PRIMARY KEY,
  userId CHAR(36) NULL,
  username VARCHAR(80) NOT NULL,
  userRole VARCHAR(30) NOT NULL,
  action VARCHAR(80) NOT NULL,
  entityType VARCHAR(60) NOT NULL,
  entityId VARCHAR(60) NULL,
  previousValue JSON NULL,
  newValue JSON NULL,
  reason TEXT,
  details JSON NULL,
  ipAddress VARCHAR(60) DEFAULT '',
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_audit_action (action),
  INDEX idx_audit_entity (entityType, entityId),
  INDEX idx_audit_user (userId),
  INDEX idx_audit_created (createdAt)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 15. Settings (Institute Profile, Localization & Gateway Config)
CREATE TABLE IF NOT EXISTS settings (
  settingKey VARCHAR(80) PRIMARY KEY,
  settingValue TEXT NOT NULL,
  updatedBy VARCHAR(80) NOT NULL DEFAULT 'system',
  updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
