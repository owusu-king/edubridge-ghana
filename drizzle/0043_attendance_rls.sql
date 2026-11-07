-- Attendance (Phase H): grants, tenant isolation, and a change history that cannot be rewritten.

-- Registers and marks are never deleted; only the columns a change touches can be updated.
GRANT SELECT, INSERT ON attendance_registers, attendance_marks, attendance_changes TO edubridge_app;
--> statement-breakpoint
GRANT UPDATE (taken_by_user_id, updated_at) ON attendance_registers TO edubridge_app;
--> statement-breakpoint
GRANT UPDATE (status, reason, version, recorded_by_user_id, updated_at) ON attendance_marks TO edubridge_app;
--> statement-breakpoint

ALTER TABLE attendance_registers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE attendance_registers FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY attendance_registers_tenant ON attendance_registers
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE attendance_marks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE attendance_marks FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY attendance_marks_tenant ON attendance_marks
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE attendance_changes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE attendance_changes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY attendance_changes_tenant ON attendance_changes
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint

-- A mark's version only ever goes up by one, so a stale offline change can always be detected.
CREATE FUNCTION attendance_mark_version_step() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'attendance mark versions go up by one' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER attendance_marks_version_step BEFORE UPDATE ON attendance_marks
  FOR EACH ROW EXECUTE FUNCTION attendance_mark_version_step();
--> statement-breakpoint

-- The change history is append-only for every role.
CREATE FUNCTION history_record_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END $$;
--> statement-breakpoint
CREATE TRIGGER attendance_changes_no_update_delete BEFORE UPDATE OR DELETE ON attendance_changes
  FOR EACH ROW EXECUTE FUNCTION history_record_immutable();
--> statement-breakpoint
CREATE TRIGGER attendance_changes_no_truncate BEFORE TRUNCATE ON attendance_changes
  FOR EACH STATEMENT EXECUTE FUNCTION history_record_immutable();
