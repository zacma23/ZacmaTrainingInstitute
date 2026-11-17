import {
  pgTable,
  pgEnum,
  char,
  varchar,
  text,
  integer,
  numeric,
  date,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// Enum types (preserve MySQL ENUM value order & semantics)
export const roleCode = pgEnum("role_code", ["admin", "accountant"]);
export const userRole = pgEnum("user_role", ["admin", "accountant"]);
export const durationUnit = pgEnum("duration_unit", ["weeks", "months"]);
export const courseStatus = pgEnum("course_status", ["Active", "Inactive"]);
export const genderValue = pgEnum("gender_value", ["Male", "Female", "Other", ""]);
export const studentStatus = pgEnum("student_status", ["Active", "Graduated", "Suspended", "Archived"]);
export const enrollmentStatus = pgEnum("enrollment_status", ["Active", "Completed", "Dropped", "Archived"]);
export const applicationStatus = pgEnum("application_status", [
  "PENDING_ADMIN_APPROVAL",
  "APPROVED",
  "REJECTED",
  "CORRECTION_REQUIRED",
]);
export const paymentMethod = pgEnum("payment_method", ["Cash", "Bank Transfer", "Mobile Money", "Other"]);
export const paymentSubmissionStatus = pgEnum("payment_submission_status", ["PENDING", "APPROVED", "REJECTED"]);
export const attendanceStatusValue = pgEnum("attendance_status_value", ["PRESENT", "ABSENT", "LATE", "EXCUSED"]);
export const notificationTargetRole = pgEnum("notification_target_role", ["all", "admin", "accountant"]);
export const notificationType = pgEnum("notification_type", [
  "DUE_TODAY",
  "DUE_SOON",
  "OVERDUE",
  "UNPAID_INSTALLMENT",
  "OUTSTANDING_BALANCE",
  "NEW_REGISTRATION",
  "NEW_PAYMENT_SUBMISSION",
  "REGISTRATION_APPROVED",
  "REGISTRATION_REJECTED",
  "CORRECTION_REQUIRED",
  "PAYMENT_APPROVED",
  "PAYMENT_REJECTED",
  "STUDENT_MESSAGE",
]);
export const channelStatusValue = pgEnum("channel_status_value", [
  "IN_APP_ONLY",
  "WHATSAPP_NOT_CONFIGURED",
  "SMS_NOT_CONFIGURED",
  "SENT",
  "FAILED",
]);
export const transactionCategory = pgEnum("transaction_category", [
  "COURSE_FEE",
  "REGISTRATION_FEE",
  "COMBINED",
]);

export const roles = pgTable("roles", {
  id: char("id", { length: 36 }).primaryKey(),
  code: roleCode("code").notNull().unique(),
  name: varchar("name", { length: 80 }).notNull(),
  description: varchar("description", { length: 255 }).default(""),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
});

export const users = pgTable(
  "users",
  {
    id: char("id", { length: 36 }).primaryKey(),
    username: varchar("username", { length: 80 }).notNull().unique(),
    firebaseUid: varchar("firebaseUid", { length: 128 }).unique(),
    fullName: varchar("fullName", { length: 150 }).notNull(),
    email: varchar("email", { length: 150 }).unique(),
    phone: varchar("phone", { length: 30 }).default(""),
    passwordHash: varchar("passwordHash", { length: 255 }).notNull(),
    role: userRole("role").notNull().default("accountant"),
    roleId: char("roleId", { length: 36 }).references(() => roles.id, { onDelete: "set null" }),
    isActive: integer("isActive").notNull().default(1),
    lastLoginAt: timestamp("lastLoginAt"),
    createdByUserId: char("createdByUserId", { length: 36 }),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (t) => [index("idx_users_role").on(t.role), index("idx_users_active").on(t.isActive)]
);

export const courses = pgTable(
  "courses",
  {
    id: char("id", { length: 36 }).primaryKey(),
    code: varchar("code", { length: 30 }).notNull().unique(),
    name: varchar("name", { length: 150 }).notNull().unique(),
    category: varchar("category", { length: 100 }).notNull().default("Technology"),
    description: text("description"),
    durationValue: integer("durationValue").notNull().default(3),
    durationUnit: durationUnit("durationUnit").notNull().default("months"),
    registrationFee: numeric("registrationFee", { precision: 12, scale: 2 }).notNull().default("500.00"),
    defaultFee: numeric("defaultFee", { precision: 12, scale: 2 }).notNull(),
    availablePlans: jsonb("availablePlans").notNull(),
    startDate: date("startDate"),
    endDate: date("endDate"),
    maxCapacity: integer("maxCapacity").notNull().default(30),
    status: courseStatus("status").notNull().default("Active"),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (t) => [index("idx_courses_status").on(t.status), index("idx_courses_category").on(t.category)]
);

export const paymentPlans = pgTable("payment_plans", {
  id: char("id", { length: 36 }).primaryKey(),
  code: varchar("code", { length: 40 }).notNull().unique(),
  name: varchar("name", { length: 100 }).notNull(),
  installmentCount: integer("installmentCount").notNull().default(1),
  intervalDays: integer("intervalDays").notNull().default(30),
  description: varchar("description", { length: 255 }).default(""),
  isActive: integer("isActive").notNull().default(1),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
});

export const students = pgTable(
  "students",
  {
    id: char("id", { length: 36 }).primaryKey(),
    studentCode: varchar("studentCode", { length: 40 }).notNull().unique(),
    fullName: varchar("fullName", { length: 150 }).notNull(),
    gender: genderValue("gender").notNull().default(""),
    phone: varchar("phone", { length: 30 }).notNull(),
    altPhone: varchar("altPhone", { length: 30 }).default(""),
    email: varchar("email", { length: 150 }).default(""),
    region: varchar("region", { length: 80 }).notNull().default("Addis Ababa"),
    city: varchar("city", { length: 80 }).notNull().default("Addis Ababa"),
    address: varchar("address", { length: 255 }).default(""),
    emergencyContactName: varchar("emergencyContactName", { length: 150 }).default(""),
    emergencyContactPhone: varchar("emergencyContactPhone", { length: 30 }).default(""),
    emergencyContactRelation: varchar("emergencyContactRelation", { length: 80 }).default(""),
    nationalIdNumber: varchar("nationalIdNumber", { length: 60 }).default(""),
    documentsNote: text("documentsNote"),
    registrationDate: date("registrationDate").notNull(),
    status: studentStatus("status").notNull().default("Active"),
    notes: text("notes"),
    registeredByUserId: char("registeredByUserId", { length: 36 }).references(() => users.id, { onDelete: "set null" }),
    approvedByUserId: char("approvedByUserId", { length: 36 }).references(() => users.id, { onDelete: "set null" }),
    approvedAt: timestamp("approvedAt"),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (t) => [
    index("idx_students_name").on(t.fullName),
    index("idx_students_phone").on(t.phone),
    index("idx_students_status").on(t.status),
    index("idx_students_regdate").on(t.registrationDate),
  ]
);

export const enrollments = pgTable(
  "enrollments",
  {
    id: char("id", { length: 36 }).primaryKey(),
    studentId: char("studentId", { length: 36 })
      .notNull()
      .references(() => students.id, { onDelete: "restrict" }),
    courseId: char("courseId", { length: 36 })
      .notNull()
      .references(() => courses.id, { onDelete: "restrict" }),
    paymentPlanId: char("paymentPlanId", { length: 36 })
      .notNull()
      .references(() => paymentPlans.id, { onDelete: "restrict" }),
    batchName: varchar("batchName", { length: 80 }).notNull().default("Batch A"),
    courseStartDate: date("courseStartDate").notNull(),
    expectedGraduationDate: date("expectedGraduationDate").notNull(),
    registrationFee: numeric("registrationFee", { precision: 12, scale: 2 }).notNull().default("0.00"),
    totalCourseFee: numeric("totalCourseFee", { precision: 12, scale: 2 }).notNull(),
    assignedDueDate: date("assignedDueDate").notNull(),
    enrollmentStatus: enrollmentStatus("enrollmentStatus").notNull().default("Active"),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (t) => [
    index("idx_enrollments_student").on(t.studentId),
    index("idx_enrollments_course").on(t.courseId),
    index("idx_enrollments_status").on(t.enrollmentStatus),
    index("idx_enrollments_duedate").on(t.assignedDueDate),
  ]
);

export const registrationApplications = pgTable(
  "registration_applications",
  {
    id: char("id", { length: 36 }).primaryKey(),
    applicationNumber: varchar("applicationNumber", { length: 40 }).notNull().unique(),
    submissionRef: varchar("submissionRef", { length: 60 }).notNull().unique(),
    submittedByUserId: char("submittedByUserId", { length: 36 })
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    submittedByName: varchar("submittedByName", { length: 150 }).notNull(),
    fullName: varchar("fullName", { length: 150 }).notNull(),
    gender: genderValue("gender").notNull().default(""),
    phone: varchar("phone", { length: 30 }).notNull(),
    altPhone: varchar("altPhone", { length: 30 }).default(""),
    email: varchar("email", { length: 150 }).default(""),
    region: varchar("region", { length: 80 }).notNull().default("Addis Ababa"),
    city: varchar("city", { length: 80 }).notNull().default("Addis Ababa"),
    address: varchar("address", { length: 255 }).default(""),
    emergencyContactName: varchar("emergencyContactName", { length: 150 }).default(""),
    emergencyContactPhone: varchar("emergencyContactPhone", { length: 30 }).default(""),
    emergencyContactRelation: varchar("emergencyContactRelation", { length: 80 }).default(""),
    nationalIdNumber: varchar("nationalIdNumber", { length: 60 }).default(""),
    documentsNote: text("documentsNote"),
    courseId: char("courseId", { length: 36 })
      .notNull()
      .references(() => courses.id, { onDelete: "restrict" }),
    paymentPlanCode: varchar("paymentPlanCode", { length: 40 }).notNull().default("full"),
    officialRegistrationFee: numeric("officialRegistrationFee", { precision: 12, scale: 2 }).notNull().default("0.00"),
    officialCourseFee: numeric("officialCourseFee", { precision: 12, scale: 2 }).notNull(),
    initialRegistrationPaid: numeric("initialRegistrationPaid", { precision: 12, scale: 2 }).notNull().default("0.00"),
    initialCoursePaid: numeric("initialCoursePaid", { precision: 12, scale: 2 }).notNull().default("0.00"),
    totalInitialSubmitted: numeric("totalInitialSubmitted", { precision: 12, scale: 2 }).notNull().default("0.00"),
    paymentMethod: paymentMethod("paymentMethod").notNull().default("Cash"),
    transactionReference: varchar("transactionReference", { length: 150 }).default(""),
    submissionNotes: text("submissionNotes"),
    registrationDate: date("registrationDate").notNull(),
    courseStartDate: date("courseStartDate").notNull(),
    expectedGraduationDate: date("expectedGraduationDate").notNull(),
    assignedDueDate: date("assignedDueDate").notNull(),
    customInstallments: jsonb("customInstallments"),
    status: applicationStatus("status").notNull().default("PENDING_ADMIN_APPROVAL"),
    adminComment: text("adminComment"),
    reviewedByUserId: char("reviewedByUserId", { length: 36 }).references(() => users.id, { onDelete: "set null" }),
    reviewedAt: timestamp("reviewedAt"),
    approvedStudentId: char("approvedStudentId", { length: 36 }),
    approvedEnrollmentId: char("approvedEnrollmentId", { length: 36 }),
    approvedTransactionId: char("approvedTransactionId", { length: 36 }),
    approvedReceiptId: char("approvedReceiptId", { length: 36 }),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (t) => [
    index("idx_regapp_status").on(t.status),
    index("idx_regapp_submitter").on(t.submittedByUserId),
    index("idx_regapp_created").on(t.createdAt),
  ]
);

export const applicationDocuments = pgTable(
  "application_documents",
  {
    id: char("id", { length: 36 }).primaryKey(),
    applicationId: char("applicationId", { length: 36 })
      .notNull()
      .references(() => registrationApplications.id, { onDelete: "cascade" }),
    fileName: varchar("fileName", { length: 255 }).notNull(),
    mimeType: varchar("mimeType", { length: 120 }).notNull(),
    fileSize: integer("fileSize").notNull(),
    contentBase64: text("contentBase64").notNull(),
    uploadedByUserId: char("uploadedByUserId", { length: 36 })
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (t) => [index("idx_appdoc_app").on(t.applicationId)]
);

export const installments = pgTable(
  "installments",
  {
    id: char("id", { length: 36 }).primaryKey(),
    enrollmentId: char("enrollmentId", { length: 36 })
      .notNull()
      .references(() => enrollments.id, { onDelete: "cascade" }),
    studentId: char("studentId", { length: 36 })
      .notNull()
      .references(() => students.id, { onDelete: "restrict" }),
    installmentNumber: integer("installmentNumber").notNull(),
    title: varchar("title", { length: 100 }).notNull(),
    expectedAmount: numeric("expectedAmount", { precision: 12, scale: 2 }).notNull(),
    dueDate: date("dueDate").notNull(),
    notes: varchar("notes", { length: 255 }).default(""),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_enrollment_installment_num").on(t.enrollmentId, t.installmentNumber),
    index("idx_installments_due").on(t.dueDate),
    index("idx_installments_student").on(t.studentId),
  ]
);

export const paymentSubmissions = pgTable(
  "payment_submissions",
  {
    id: char("id", { length: 36 }).primaryKey(),
    submissionRef: varchar("submissionRef", { length: 60 }).notNull().unique(),
    studentId: char("studentId", { length: 36 })
      .notNull()
      .references(() => students.id, { onDelete: "restrict" }),
    enrollmentId: char("enrollmentId", { length: 36 })
      .notNull()
      .references(() => enrollments.id, { onDelete: "restrict" }),
    submittedByUserId: char("submittedByUserId", { length: 36 })
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    submittedByName: varchar("submittedByName", { length: 150 }).notNull(),
    amountSubmitted: numeric("amountSubmitted", { precision: 12, scale: 2 }).notNull(),
    paymentDate: date("paymentDate").notNull(),
    paymentMethod: paymentMethod("paymentMethod").notNull().default("Cash"),
    transactionReference: varchar("transactionReference", { length: 150 }).default(""),
    notes: text("notes"),
    status: paymentSubmissionStatus("status").notNull().default("PENDING"),
    rejectionReason: text("rejectionReason"),
    reviewedByUserId: char("reviewedByUserId", { length: 36 }).references(() => users.id, { onDelete: "set null" }),
    reviewedAt: timestamp("reviewedAt"),
    approvedTransactionId: char("approvedTransactionId", { length: 36 }),
    approvedReceiptId: char("approvedReceiptId", { length: 36 }),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (t) => [
    index("idx_paysub_status").on(t.status),
    index("idx_paysub_student").on(t.studentId),
    index("idx_paysub_submitter").on(t.submittedByUserId),
    index("idx_paysub_created").on(t.createdAt),
  ]
);

export const transactions = pgTable(
  "transactions",
  {
    id: char("id", { length: 36 }).primaryKey(),
    transactionId: varchar("transactionId", { length: 60 }).notNull().unique(),
    studentId: char("studentId", { length: 36 })
      .notNull()
      .references(() => students.id, { onDelete: "restrict" }),
    enrollmentId: char("enrollmentId", { length: 36 })
      .notNull()
      .references(() => enrollments.id, { onDelete: "restrict" }),
    submissionId: char("submissionId", { length: 36 }),
    paymentCategory: transactionCategory("paymentCategory").notNull().default("COURSE_FEE"),
    registrationAmount: numeric("registrationAmount", { precision: 12, scale: 2 }).notNull().default("0.00"),
    tuitionAmount: numeric("tuitionAmount", { precision: 12, scale: 2 }).notNull().default("0.00"),
    amountPaid: numeric("amountPaid", { precision: 12, scale: 2 }).notNull(),
    paymentDate: date("paymentDate").notNull(),
    paymentMethod: paymentMethod("paymentMethod").notNull().default("Cash"),
    transactionReference: varchar("transactionReference", { length: 150 }).default(""),
    receivedByUserId: char("receivedByUserId", { length: 36 }).references(() => users.id, { onDelete: "set null" }),
    receivedByName: varchar("receivedByName", { length: 150 }).notNull(),
    approvedByUserId: char("approvedByUserId", { length: 36 }).references(() => users.id, { onDelete: "set null" }),
    approvedAt: timestamp("approvedAt"),
    isAdjustment: integer("isAdjustment").notNull().default(0),
    adjustmentReason: varchar("adjustmentReason", { length: 255 }).default(""),
    notes: text("notes"),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (t) => [
    index("idx_transactions_student").on(t.studentId),
    index("idx_transactions_enrollment").on(t.enrollmentId),
    index("idx_transactions_date").on(t.paymentDate),
    index("idx_transactions_method").on(t.paymentMethod),
    index("idx_transactions_created").on(t.createdAt),
  ]
);

export const receipts = pgTable(
  "receipts",
  {
    id: char("id", { length: 36 }).primaryKey(),
    receiptNumber: varchar("receiptNumber", { length: 60 }).notNull().unique(),
    transactionId: char("transactionId", { length: 36 })
      .notNull()
      .unique()
      .references(() => transactions.id, { onDelete: "restrict" }),
    studentId: char("studentId", { length: 36 })
      .notNull()
      .references(() => students.id, { onDelete: "restrict" }),
    enrollmentId: char("enrollmentId", { length: 36 })
      .notNull()
      .references(() => enrollments.id, { onDelete: "restrict" }),
    amountPaid: numeric("amountPaid", { precision: 12, scale: 2 }).notNull(),
    previousBalance: numeric("previousBalance", { precision: 12, scale: 2 }).notNull(),
    remainingBalance: numeric("remainingBalance", { precision: 12, scale: 2 }).notNull(),
    issuedBy: varchar("issuedBy", { length: 150 }).notNull(),
    approvedByUserId: char("approvedByUserId", { length: 36 }).references(() => users.id, { onDelete: "set null" }),
    issuedAt: timestamp("issuedAt").notNull().defaultNow(),
  },
  (t) => [index("idx_receipts_student").on(t.studentId), index("idx_receipts_issued").on(t.issuedAt)]
);

export const attendance = pgTable(
  "attendance",
  {
    id: char("id", { length: 36 }).primaryKey(),
    studentId: char("studentId", { length: 36 })
      .notNull()
      .references(() => students.id, { onDelete: "restrict" }),
    enrollmentId: char("enrollmentId", { length: 36 })
      .notNull()
      .references(() => enrollments.id, { onDelete: "restrict" }),
    courseId: char("courseId", { length: 36 })
      .notNull()
      .references(() => courses.id, { onDelete: "restrict" }),
    batchName: varchar("batchName", { length: 80 }).notNull().default("Batch A"),
    attendanceDate: date("attendanceDate").notNull(),
    status: attendanceStatusValue("status").notNull().default("PRESENT"),
    notes: varchar("notes", { length: 255 }).default(""),
    editReason: varchar("editReason", { length: 255 }).default(""),
    recordedByUserId: char("recordedByUserId", { length: 36 }).references(() => users.id, { onDelete: "set null" }),
    updatedByUserId: char("updatedByUserId", { length: 36 }).references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_attendance_student_course_date").on(t.studentId, t.courseId, t.attendanceDate),
    index("idx_attendance_date").on(t.attendanceDate),
    index("idx_attendance_course_date").on(t.courseId, t.attendanceDate),
    index("idx_attendance_status").on(t.status),
  ]
);

export const notifications = pgTable(
  "notifications",
  {
    id: char("id", { length: 36 }).primaryKey(),
    studentId: char("studentId", { length: 36 }).references(() => students.id, { onDelete: "cascade" }),
    enrollmentId: char("enrollmentId", { length: 36 }).references(() => enrollments.id, { onDelete: "cascade" }),
    installmentId: char("installmentId", { length: 36 }).references(() => installments.id, { onDelete: "set null" }),
    applicationId: char("applicationId", { length: 36 }),
    paymentSubmissionId: char("paymentSubmissionId", { length: 36 }),
    targetRole: notificationTargetRole("targetRole").notNull().default("all"),
    targetUserId: char("targetUserId", { length: 36 }),
    type: notificationType("type").notNull(),
    dedupeKey: varchar("dedupeKey", { length: 160 }).notNull().unique(),
    title: varchar("title", { length: 200 }).notNull(),
    message: text("message").notNull(),
    amountDue: numeric("amountDue", { precision: 12, scale: 2 }).notNull().default("0.00"),
    dueDate: date("dueDate").notNull(),
    overdueDays: integer("overdueDays").notNull().default(0),
    channelStatus: channelStatusValue("channelStatus").notNull().default("IN_APP_ONLY"),
    isRead: integer("isRead").notNull().default(0),
    readAt: timestamp("readAt"),
    readByUserId: char("readByUserId", { length: 36 }),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (t) => [
    index("idx_notifications_read").on(t.isRead),
    index("idx_notifications_type").on(t.type),
    index("idx_notifications_target").on(t.targetRole, t.targetUserId),
    index("idx_notifications_created").on(t.createdAt),
  ]
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: char("id", { length: 36 }).primaryKey(),
    userId: char("userId", { length: 36 }).references(() => users.id, { onDelete: "set null" }),
    username: varchar("username", { length: 80 }).notNull(),
    userRole: varchar("userRole", { length: 30 }).notNull(),
    action: varchar("action", { length: 80 }).notNull(),
    entityType: varchar("entityType", { length: 60 }).notNull(),
    entityId: varchar("entityId", { length: 60 }),
    previousValue: jsonb("previousValue"),
    newValue: jsonb("newValue"),
    reason: text("reason"),
    details: jsonb("details"),
    ipAddress: varchar("ipAddress", { length: 60 }).default(""),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (t) => [
    index("idx_audit_action").on(t.action),
    index("idx_audit_entity").on(t.entityType, t.entityId),
    index("idx_audit_user").on(t.userId),
    index("idx_audit_created").on(t.createdAt),
  ]
);

export const settings = pgTable("settings", {
  settingKey: varchar("settingKey", { length: 80 }).primaryKey(),
  settingValue: text("settingValue").notNull(),
  updatedBy: varchar("updatedBy", { length: 80 }).notNull().default("system"),
  updatedAt: timestamp("updatedAt").notNull().defaultNow(),
});
