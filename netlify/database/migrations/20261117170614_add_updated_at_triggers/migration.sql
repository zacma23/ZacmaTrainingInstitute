-- Recreate MySQL "ON UPDATE CURRENT_TIMESTAMP" semantics for updatedAt columns
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW."updatedAt" = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON "users"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_courses_updated_at BEFORE UPDATE ON "courses"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_students_updated_at BEFORE UPDATE ON "students"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_enrollments_updated_at BEFORE UPDATE ON "enrollments"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_regapp_updated_at BEFORE UPDATE ON "registration_applications"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_installments_updated_at BEFORE UPDATE ON "installments"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_paysub_updated_at BEFORE UPDATE ON "payment_submissions"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_attendance_updated_at BEFORE UPDATE ON "attendance"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_settings_updated_at BEFORE UPDATE ON "settings"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
