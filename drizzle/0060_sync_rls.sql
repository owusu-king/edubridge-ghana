-- Sync protocol: operations received from devices, and the change feed written by triggers.

-- An operation is recorded in the same transaction as its effects, once; it never changes.
GRANT SELECT, INSERT ON sync_operations TO edubridge_app;
--> statement-breakpoint
ALTER TABLE sync_operations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE sync_operations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY sync_operations_tenant ON sync_operations
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
CREATE TRIGGER sync_operations_no_update_delete BEFORE UPDATE OR DELETE ON sync_operations
  FOR EACH ROW EXECUTE FUNCTION history_record_immutable();
--> statement-breakpoint
CREATE TRIGGER sync_operations_no_truncate BEFORE TRUNCATE ON sync_operations
  FOR EACH STATEMENT EXECUTE FUNCTION history_record_immutable();
--> statement-breakpoint

-- The worker deletes entries older than 90 days.
GRANT SELECT, INSERT, DELETE ON sync_changes TO edubridge_app;
--> statement-breakpoint
GRANT USAGE ON SEQUENCE sync_changes_seq_seq TO edubridge_app;
--> statement-breakpoint
ALTER TABLE sync_changes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE sync_changes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY sync_changes_tenant ON sync_changes
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
-- TG_ARGV: the entity name and the column holding the id devices know it by.
CREATE FUNCTION log_sync_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  r jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    r := to_jsonb(OLD);
  ELSE
    r := to_jsonb(NEW);
  END IF;
  INSERT INTO sync_changes (tenant_id, entity, entity_id)
  VALUES ((r ->> 'tenant_id')::uuid, TG_ARGV[0], (r ->> TG_ARGV[1])::uuid);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER students_sync_change AFTER INSERT OR UPDATE OR DELETE ON students
  FOR EACH ROW EXECUTE FUNCTION log_sync_change('student', 'id');
--> statement-breakpoint
CREATE TRIGGER enrolments_sync_change AFTER INSERT OR UPDATE OR DELETE ON enrolments
  FOR EACH ROW EXECUTE FUNCTION log_sync_change('student', 'student_id');
--> statement-breakpoint
CREATE TRIGGER classes_sync_change AFTER INSERT OR UPDATE OR DELETE ON classes
  FOR EACH ROW EXECUTE FUNCTION log_sync_change('class', 'id');
--> statement-breakpoint
CREATE TRIGGER attendance_marks_sync_change AFTER INSERT OR UPDATE OR DELETE ON attendance_marks
  FOR EACH ROW EXECUTE FUNCTION log_sync_change('register', 'register_id');
--> statement-breakpoint
CREATE TRIGGER assessment_scores_sync_change AFTER INSERT OR UPDATE OR DELETE ON assessment_scores
  FOR EACH ROW EXECUTE FUNCTION log_sync_change('score', 'student_id');
