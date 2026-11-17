CREATE TYPE "application_status" AS ENUM('PENDING_ADMIN_APPROVAL', 'APPROVED', 'REJECTED', 'CORRECTION_REQUIRED');--> statement-breakpoint
CREATE TYPE "attendance_status_value" AS ENUM('PRESENT', 'ABSENT', 'LATE', 'EXCUSED');--> statement-breakpoint
CREATE TYPE "channel_status_value" AS ENUM('IN_APP_ONLY', 'WHATSAPP_NOT_CONFIGURED', 'SMS_NOT_CONFIGURED', 'SENT', 'FAILED');--> statement-breakpoint
CREATE TYPE "course_status" AS ENUM('Active', 'Inactive');--> statement-breakpoint
CREATE TYPE "duration_unit" AS ENUM('weeks', 'months');--> statement-breakpoint
CREATE TYPE "enrollment_status" AS ENUM('Active', 'Completed', 'Dropped', 'Archived');--> statement-breakpoint
CREATE TYPE "gender_value" AS ENUM('Male', 'Female', 'Other', '');--> statement-breakpoint
CREATE TYPE "notification_target_role" AS ENUM('all', 'admin', 'accountant');--> statement-breakpoint
CREATE TYPE "notification_type" AS ENUM('DUE_TODAY', 'DUE_SOON', 'OVERDUE', 'UNPAID_INSTALLMENT', 'OUTSTANDING_BALANCE', 'NEW_REGISTRATION', 'NEW_PAYMENT_SUBMISSION', 'REGISTRATION_APPROVED', 'REGISTRATION_REJECTED', 'CORRECTION_REQUIRED', 'PAYMENT_APPROVED', 'PAYMENT_REJECTED', 'STUDENT_MESSAGE');--> statement-breakpoint
CREATE TYPE "payment_method" AS ENUM('Cash', 'Bank Transfer', 'Mobile Money', 'Other');--> statement-breakpoint
CREATE TYPE "payment_submission_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "role_code" AS ENUM('admin', 'accountant');--> statement-breakpoint
CREATE TYPE "student_status" AS ENUM('Active', 'Graduated', 'Suspended', 'Archived');--> statement-breakpoint
CREATE TYPE "transaction_category" AS ENUM('COURSE_FEE', 'REGISTRATION_FEE', 'COMBINED');--> statement-breakpoint
CREATE TYPE "user_role" AS ENUM('admin', 'accountant');--> statement-breakpoint
CREATE TABLE "application_documents" (
	"id" char(36) PRIMARY KEY,
	"applicationId" char(36) NOT NULL,
	"fileName" varchar(255) NOT NULL,
	"mimeType" varchar(120) NOT NULL,
	"fileSize" integer NOT NULL,
	"contentBase64" text NOT NULL,
	"uploadedByUserId" char(36) NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attendance" (
	"id" char(36) PRIMARY KEY,
	"studentId" char(36) NOT NULL,
	"enrollmentId" char(36) NOT NULL,
	"courseId" char(36) NOT NULL,
	"batchName" varchar(80) DEFAULT 'Batch A' NOT NULL,
	"attendanceDate" date NOT NULL,
	"status" "attendance_status_value" DEFAULT 'PRESENT'::"attendance_status_value" NOT NULL,
	"notes" varchar(255) DEFAULT '',
	"editReason" varchar(255) DEFAULT '',
	"recordedByUserId" char(36),
	"updatedByUserId" char(36),
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" char(36) PRIMARY KEY,
	"userId" char(36),
	"username" varchar(80) NOT NULL,
	"userRole" varchar(30) NOT NULL,
	"action" varchar(80) NOT NULL,
	"entityType" varchar(60) NOT NULL,
	"entityId" varchar(60),
	"previousValue" jsonb,
	"newValue" jsonb,
	"reason" text,
	"details" jsonb,
	"ipAddress" varchar(60) DEFAULT '',
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "courses" (
	"id" char(36) PRIMARY KEY,
	"code" varchar(30) NOT NULL UNIQUE,
	"name" varchar(150) NOT NULL UNIQUE,
	"category" varchar(100) DEFAULT 'Technology' NOT NULL,
	"description" text,
	"durationValue" integer DEFAULT 3 NOT NULL,
	"durationUnit" "duration_unit" DEFAULT 'months'::"duration_unit" NOT NULL,
	"registrationFee" numeric(12,2) DEFAULT '500.00' NOT NULL,
	"defaultFee" numeric(12,2) NOT NULL,
	"availablePlans" jsonb NOT NULL,
	"startDate" date,
	"endDate" date,
	"maxCapacity" integer DEFAULT 30 NOT NULL,
	"status" "course_status" DEFAULT 'Active'::"course_status" NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "enrollments" (
	"id" char(36) PRIMARY KEY,
	"studentId" char(36) NOT NULL,
	"courseId" char(36) NOT NULL,
	"paymentPlanId" char(36) NOT NULL,
	"batchName" varchar(80) DEFAULT 'Batch A' NOT NULL,
	"courseStartDate" date NOT NULL,
	"expectedGraduationDate" date NOT NULL,
	"registrationFee" numeric(12,2) DEFAULT '0.00' NOT NULL,
	"totalCourseFee" numeric(12,2) NOT NULL,
	"assignedDueDate" date NOT NULL,
	"enrollmentStatus" "enrollment_status" DEFAULT 'Active'::"enrollment_status" NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "installments" (
	"id" char(36) PRIMARY KEY,
	"enrollmentId" char(36) NOT NULL,
	"studentId" char(36) NOT NULL,
	"installmentNumber" integer NOT NULL,
	"title" varchar(100) NOT NULL,
	"expectedAmount" numeric(12,2) NOT NULL,
	"dueDate" date NOT NULL,
	"notes" varchar(255) DEFAULT '',
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" char(36) PRIMARY KEY,
	"studentId" char(36),
	"enrollmentId" char(36),
	"installmentId" char(36),
	"applicationId" char(36),
	"paymentSubmissionId" char(36),
	"targetRole" "notification_target_role" DEFAULT 'all'::"notification_target_role" NOT NULL,
	"targetUserId" char(36),
	"type" "notification_type" NOT NULL,
	"dedupeKey" varchar(160) NOT NULL UNIQUE,
	"title" varchar(200) NOT NULL,
	"message" text NOT NULL,
	"amountDue" numeric(12,2) DEFAULT '0.00' NOT NULL,
	"dueDate" date NOT NULL,
	"overdueDays" integer DEFAULT 0 NOT NULL,
	"channelStatus" "channel_status_value" DEFAULT 'IN_APP_ONLY'::"channel_status_value" NOT NULL,
	"isRead" integer DEFAULT 0 NOT NULL,
	"readAt" timestamp,
	"readByUserId" char(36),
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_plans" (
	"id" char(36) PRIMARY KEY,
	"code" varchar(40) NOT NULL UNIQUE,
	"name" varchar(100) NOT NULL,
	"installmentCount" integer DEFAULT 1 NOT NULL,
	"intervalDays" integer DEFAULT 30 NOT NULL,
	"description" varchar(255) DEFAULT '',
	"isActive" integer DEFAULT 1 NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_submissions" (
	"id" char(36) PRIMARY KEY,
	"submissionRef" varchar(60) NOT NULL UNIQUE,
	"studentId" char(36) NOT NULL,
	"enrollmentId" char(36) NOT NULL,
	"submittedByUserId" char(36) NOT NULL,
	"submittedByName" varchar(150) NOT NULL,
	"amountSubmitted" numeric(12,2) NOT NULL,
	"paymentDate" date NOT NULL,
	"paymentMethod" "payment_method" DEFAULT 'Cash'::"payment_method" NOT NULL,
	"transactionReference" varchar(150) DEFAULT '',
	"notes" text,
	"status" "payment_submission_status" DEFAULT 'PENDING'::"payment_submission_status" NOT NULL,
	"rejectionReason" text,
	"reviewedByUserId" char(36),
	"reviewedAt" timestamp,
	"approvedTransactionId" char(36),
	"approvedReceiptId" char(36),
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "receipts" (
	"id" char(36) PRIMARY KEY,
	"receiptNumber" varchar(60) NOT NULL UNIQUE,
	"transactionId" char(36) NOT NULL UNIQUE,
	"studentId" char(36) NOT NULL,
	"enrollmentId" char(36) NOT NULL,
	"amountPaid" numeric(12,2) NOT NULL,
	"previousBalance" numeric(12,2) NOT NULL,
	"remainingBalance" numeric(12,2) NOT NULL,
	"issuedBy" varchar(150) NOT NULL,
	"approvedByUserId" char(36),
	"issuedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "registration_applications" (
	"id" char(36) PRIMARY KEY,
	"applicationNumber" varchar(40) NOT NULL UNIQUE,
	"submissionRef" varchar(60) NOT NULL UNIQUE,
	"submittedByUserId" char(36) NOT NULL,
	"submittedByName" varchar(150) NOT NULL,
	"fullName" varchar(150) NOT NULL,
	"gender" "gender_value" NOT NULL,
	"phone" varchar(30) NOT NULL,
	"altPhone" varchar(30) DEFAULT '',
	"email" varchar(150) DEFAULT '',
	"region" varchar(80) DEFAULT 'Addis Ababa' NOT NULL,
	"city" varchar(80) DEFAULT 'Addis Ababa' NOT NULL,
	"address" varchar(255) DEFAULT '',
	"emergencyContactName" varchar(150) DEFAULT '',
	"emergencyContactPhone" varchar(30) DEFAULT '',
	"emergencyContactRelation" varchar(80) DEFAULT '',
	"nationalIdNumber" varchar(60) DEFAULT '',
	"documentsNote" text,
	"courseId" char(36) NOT NULL,
	"paymentPlanCode" varchar(40) DEFAULT 'full' NOT NULL,
	"officialRegistrationFee" numeric(12,2) DEFAULT '0.00' NOT NULL,
	"officialCourseFee" numeric(12,2) NOT NULL,
	"initialRegistrationPaid" numeric(12,2) DEFAULT '0.00' NOT NULL,
	"initialCoursePaid" numeric(12,2) DEFAULT '0.00' NOT NULL,
	"totalInitialSubmitted" numeric(12,2) DEFAULT '0.00' NOT NULL,
	"paymentMethod" "payment_method" DEFAULT 'Cash'::"payment_method" NOT NULL,
	"transactionReference" varchar(150) DEFAULT '',
	"submissionNotes" text,
	"registrationDate" date NOT NULL,
	"courseStartDate" date NOT NULL,
	"expectedGraduationDate" date NOT NULL,
	"assignedDueDate" date NOT NULL,
	"customInstallments" jsonb,
	"status" "application_status" DEFAULT 'PENDING_ADMIN_APPROVAL'::"application_status" NOT NULL,
	"adminComment" text,
	"reviewedByUserId" char(36),
	"reviewedAt" timestamp,
	"approvedStudentId" char(36),
	"approvedEnrollmentId" char(36),
	"approvedTransactionId" char(36),
	"approvedReceiptId" char(36),
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" char(36) PRIMARY KEY,
	"code" "role_code" NOT NULL UNIQUE,
	"name" varchar(80) NOT NULL,
	"description" varchar(255) DEFAULT '',
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"settingKey" varchar(80) PRIMARY KEY,
	"settingValue" text NOT NULL,
	"updatedBy" varchar(80) DEFAULT 'system' NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "students" (
	"id" char(36) PRIMARY KEY,
	"studentCode" varchar(40) NOT NULL UNIQUE,
	"fullName" varchar(150) NOT NULL,
	"gender" "gender_value" NOT NULL,
	"phone" varchar(30) NOT NULL,
	"altPhone" varchar(30) DEFAULT '',
	"email" varchar(150) DEFAULT '',
	"region" varchar(80) DEFAULT 'Addis Ababa' NOT NULL,
	"city" varchar(80) DEFAULT 'Addis Ababa' NOT NULL,
	"address" varchar(255) DEFAULT '',
	"emergencyContactName" varchar(150) DEFAULT '',
	"emergencyContactPhone" varchar(30) DEFAULT '',
	"emergencyContactRelation" varchar(80) DEFAULT '',
	"nationalIdNumber" varchar(60) DEFAULT '',
	"documentsNote" text,
	"registrationDate" date NOT NULL,
	"status" "student_status" DEFAULT 'Active'::"student_status" NOT NULL,
	"notes" text,
	"registeredByUserId" char(36),
	"approvedByUserId" char(36),
	"approvedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" char(36) PRIMARY KEY,
	"transactionId" varchar(60) NOT NULL UNIQUE,
	"studentId" char(36) NOT NULL,
	"enrollmentId" char(36) NOT NULL,
	"submissionId" char(36),
	"paymentCategory" "transaction_category" DEFAULT 'COURSE_FEE'::"transaction_category" NOT NULL,
	"registrationAmount" numeric(12,2) DEFAULT '0.00' NOT NULL,
	"tuitionAmount" numeric(12,2) DEFAULT '0.00' NOT NULL,
	"amountPaid" numeric(12,2) NOT NULL,
	"paymentDate" date NOT NULL,
	"paymentMethod" "payment_method" DEFAULT 'Cash'::"payment_method" NOT NULL,
	"transactionReference" varchar(150) DEFAULT '',
	"receivedByUserId" char(36),
	"receivedByName" varchar(150) NOT NULL,
	"approvedByUserId" char(36),
	"approvedAt" timestamp,
	"isAdjustment" integer DEFAULT 0 NOT NULL,
	"adjustmentReason" varchar(255) DEFAULT '',
	"notes" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" char(36) PRIMARY KEY,
	"username" varchar(80) NOT NULL UNIQUE,
	"firebaseUid" varchar(128) UNIQUE,
	"fullName" varchar(150) NOT NULL,
	"email" varchar(150) UNIQUE,
	"phone" varchar(30) DEFAULT '',
	"passwordHash" varchar(255) NOT NULL,
	"role" "user_role" DEFAULT 'accountant'::"user_role" NOT NULL,
	"roleId" char(36),
	"isActive" integer DEFAULT 1 NOT NULL,
	"lastLoginAt" timestamp,
	"createdByUserId" char(36),
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_appdoc_app" ON "application_documents" ("applicationId");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_attendance_student_course_date" ON "attendance" ("studentId","courseId","attendanceDate");--> statement-breakpoint
CREATE INDEX "idx_attendance_date" ON "attendance" ("attendanceDate");--> statement-breakpoint
CREATE INDEX "idx_attendance_course_date" ON "attendance" ("courseId","attendanceDate");--> statement-breakpoint
CREATE INDEX "idx_attendance_status" ON "attendance" ("status");--> statement-breakpoint
CREATE INDEX "idx_audit_action" ON "audit_logs" ("action");--> statement-breakpoint
CREATE INDEX "idx_audit_entity" ON "audit_logs" ("entityType","entityId");--> statement-breakpoint
CREATE INDEX "idx_audit_user" ON "audit_logs" ("userId");--> statement-breakpoint
CREATE INDEX "idx_audit_created" ON "audit_logs" ("createdAt");--> statement-breakpoint
CREATE INDEX "idx_courses_status" ON "courses" ("status");--> statement-breakpoint
CREATE INDEX "idx_courses_category" ON "courses" ("category");--> statement-breakpoint
CREATE INDEX "idx_enrollments_student" ON "enrollments" ("studentId");--> statement-breakpoint
CREATE INDEX "idx_enrollments_course" ON "enrollments" ("courseId");--> statement-breakpoint
CREATE INDEX "idx_enrollments_status" ON "enrollments" ("enrollmentStatus");--> statement-breakpoint
CREATE INDEX "idx_enrollments_duedate" ON "enrollments" ("assignedDueDate");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_enrollment_installment_num" ON "installments" ("enrollmentId","installmentNumber");--> statement-breakpoint
CREATE INDEX "idx_installments_due" ON "installments" ("dueDate");--> statement-breakpoint
CREATE INDEX "idx_installments_student" ON "installments" ("studentId");--> statement-breakpoint
CREATE INDEX "idx_notifications_read" ON "notifications" ("isRead");--> statement-breakpoint
CREATE INDEX "idx_notifications_type" ON "notifications" ("type");--> statement-breakpoint
CREATE INDEX "idx_notifications_target" ON "notifications" ("targetRole","targetUserId");--> statement-breakpoint
CREATE INDEX "idx_notifications_created" ON "notifications" ("createdAt");--> statement-breakpoint
CREATE INDEX "idx_paysub_status" ON "payment_submissions" ("status");--> statement-breakpoint
CREATE INDEX "idx_paysub_student" ON "payment_submissions" ("studentId");--> statement-breakpoint
CREATE INDEX "idx_paysub_submitter" ON "payment_submissions" ("submittedByUserId");--> statement-breakpoint
CREATE INDEX "idx_paysub_created" ON "payment_submissions" ("createdAt");--> statement-breakpoint
CREATE INDEX "idx_receipts_student" ON "receipts" ("studentId");--> statement-breakpoint
CREATE INDEX "idx_receipts_issued" ON "receipts" ("issuedAt");--> statement-breakpoint
CREATE INDEX "idx_regapp_status" ON "registration_applications" ("status");--> statement-breakpoint
CREATE INDEX "idx_regapp_submitter" ON "registration_applications" ("submittedByUserId");--> statement-breakpoint
CREATE INDEX "idx_regapp_created" ON "registration_applications" ("createdAt");--> statement-breakpoint
CREATE INDEX "idx_students_name" ON "students" ("fullName");--> statement-breakpoint
CREATE INDEX "idx_students_phone" ON "students" ("phone");--> statement-breakpoint
CREATE INDEX "idx_students_status" ON "students" ("status");--> statement-breakpoint
CREATE INDEX "idx_students_regdate" ON "students" ("registrationDate");--> statement-breakpoint
CREATE INDEX "idx_transactions_student" ON "transactions" ("studentId");--> statement-breakpoint
CREATE INDEX "idx_transactions_enrollment" ON "transactions" ("enrollmentId");--> statement-breakpoint
CREATE INDEX "idx_transactions_date" ON "transactions" ("paymentDate");--> statement-breakpoint
CREATE INDEX "idx_transactions_method" ON "transactions" ("paymentMethod");--> statement-breakpoint
CREATE INDEX "idx_transactions_created" ON "transactions" ("createdAt");--> statement-breakpoint
CREATE INDEX "idx_users_role" ON "users" ("role");--> statement-breakpoint
CREATE INDEX "idx_users_active" ON "users" ("isActive");--> statement-breakpoint
ALTER TABLE "application_documents" ADD CONSTRAINT "application_documents_Uhat8osASvtN_fkey" FOREIGN KEY ("applicationId") REFERENCES "registration_applications"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "application_documents" ADD CONSTRAINT "application_documents_uploadedByUserId_users_id_fkey" FOREIGN KEY ("uploadedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_studentId_students_id_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_enrollmentId_enrollments_id_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "enrollments"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_courseId_courses_id_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_recordedByUserId_users_id_fkey" FOREIGN KEY ("recordedByUserId") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_updatedByUserId_users_id_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_userId_users_id_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_studentId_students_id_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_courseId_courses_id_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_paymentPlanId_payment_plans_id_fkey" FOREIGN KEY ("paymentPlanId") REFERENCES "payment_plans"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "installments" ADD CONSTRAINT "installments_enrollmentId_enrollments_id_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "enrollments"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "installments" ADD CONSTRAINT "installments_studentId_students_id_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_studentId_students_id_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_enrollmentId_enrollments_id_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "enrollments"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_installmentId_installments_id_fkey" FOREIGN KEY ("installmentId") REFERENCES "installments"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "payment_submissions" ADD CONSTRAINT "payment_submissions_studentId_students_id_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "payment_submissions" ADD CONSTRAINT "payment_submissions_enrollmentId_enrollments_id_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "enrollments"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "payment_submissions" ADD CONSTRAINT "payment_submissions_submittedByUserId_users_id_fkey" FOREIGN KEY ("submittedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "payment_submissions" ADD CONSTRAINT "payment_submissions_reviewedByUserId_users_id_fkey" FOREIGN KEY ("reviewedByUserId") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_transactionId_transactions_id_fkey" FOREIGN KEY ("transactionId") REFERENCES "transactions"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_studentId_students_id_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_enrollmentId_enrollments_id_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "enrollments"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_approvedByUserId_users_id_fkey" FOREIGN KEY ("approvedByUserId") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "registration_applications" ADD CONSTRAINT "registration_applications_submittedByUserId_users_id_fkey" FOREIGN KEY ("submittedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "registration_applications" ADD CONSTRAINT "registration_applications_courseId_courses_id_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "registration_applications" ADD CONSTRAINT "registration_applications_reviewedByUserId_users_id_fkey" FOREIGN KEY ("reviewedByUserId") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "students" ADD CONSTRAINT "students_registeredByUserId_users_id_fkey" FOREIGN KEY ("registeredByUserId") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "students" ADD CONSTRAINT "students_approvedByUserId_users_id_fkey" FOREIGN KEY ("approvedByUserId") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_studentId_students_id_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_enrollmentId_enrollments_id_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "enrollments"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_receivedByUserId_users_id_fkey" FOREIGN KEY ("receivedByUserId") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_approvedByUserId_users_id_fkey" FOREIGN KEY ("approvedByUserId") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_roleId_roles_id_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE SET NULL;