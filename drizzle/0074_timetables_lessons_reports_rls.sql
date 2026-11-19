-- Timetables, lesson attendance and report-card layouts (R2 completion): grants, tenant isolation, and the
-- rules that keep lesson registers and subject comments trustworthy.

-- Periods and lessons are planned and re-planned by academic staff (every change audited by the service).
GRANT SELECT, INSERT, UPDATE, DELETE ON timetable_periods, timetable_lessons TO edubridge_app;
--> statement-breakpoint
-- Lesson registers and marks are never deleted; only the columns a change touches can be updated.
GRANT SELECT, INSERT ON lesson_registers, lesson_marks, lesson_mark_changes TO edubridge_app;
--> statement-breakpoint
GRANT UPDATE (taken_by_user_id, updated_at) ON lesson_registers TO edubridge_app;
--> statement-breakpoint
GRANT UPDATE (status, reason, version, recorded_by_user_id, updated_at) ON lesson_marks TO edubridge_app;
--> statement-breakpoint
-- Subject comments are written, corrected and cleared while the report card is a draft.
GRANT SELECT, INSERT, UPDATE, DELETE ON subject_comments TO edubridge_app;
--> statement-breakpoint

ALTER TABLE timetable_periods ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE timetable_periods FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY timetable_periods_tenant ON timetable_periods
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE timetable_lessons ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE timetable_lessons FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY timetable_lessons_tenant ON timetable_lessons
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE lesson_registers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE lesson_registers FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY lesson_registers_tenant ON lesson_registers
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE lesson_marks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE lesson_marks FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY lesson_marks_tenant ON lesson_marks
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE lesson_mark_changes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE lesson_mark_changes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY lesson_mark_changes_tenant ON lesson_mark_changes
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE subject_comments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE subject_comments FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY subject_comments_tenant ON subject_comments
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint

ALTER TABLE school_preferences ADD CONSTRAINT school_preferences_report_card_style
  CHECK (report_card_style is null or report_card_style in ('ges', 'cambridge', 'ib', 'american'));
--> statement-breakpoint
ALTER TABLE timetable_periods ADD CONSTRAINT timetable_periods_kind CHECK (kind in ('lesson', 'break'));
--> statement-breakpoint
ALTER TABLE lesson_marks ADD CONSTRAINT lesson_marks_status
  CHECK (status in ('present', 'late', 'absent', 'excused'));
--> statement-breakpoint
ALTER TABLE lesson_mark_changes ADD CONSTRAINT lesson_mark_changes_source
  CHECK (source in ('online', 'offline', 'kept_mine'));
--> statement-breakpoint

-- A lesson mark's version only ever goes up by one (the class register's rule, same function).
CREATE TRIGGER lesson_marks_version_step BEFORE UPDATE ON lesson_marks
  FOR EACH ROW EXECUTE FUNCTION attendance_mark_version_step();
--> statement-breakpoint
-- The change history is append-only for every role.
CREATE TRIGGER lesson_mark_changes_no_update_delete BEFORE UPDATE OR DELETE ON lesson_mark_changes
  FOR EACH ROW EXECUTE FUNCTION history_record_immutable();
--> statement-breakpoint
CREATE TRIGGER lesson_mark_changes_no_truncate BEFORE TRUNCATE ON lesson_mark_changes
  FOR EACH STATEMENT EXECUTE FUNCTION history_record_immutable();
--> statement-breakpoint

-- Comments behind a published report card are locked, like its marks, until it is withdrawn.
CREATE FUNCTION subject_comment_locked() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  r subject_comments;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  IF EXISTS (
    SELECT 1 FROM report_cards rc
    WHERE rc.tenant_id = r.tenant_id AND rc.term_id = r.term_id AND rc.student_id = r.student_id
      AND rc.status = 'published'
  ) OR (TG_OP = 'UPDATE' AND EXISTS (
    SELECT 1 FROM report_cards rc
    WHERE rc.tenant_id = OLD.tenant_id AND rc.term_id = OLD.term_id AND rc.student_id = OLD.student_id
      AND rc.status = 'published'
  )) THEN
    RAISE EXCEPTION 'comments on a published report card are locked' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER subject_comments_locked BEFORE INSERT OR UPDATE OR DELETE ON subject_comments
  FOR EACH ROW EXECUTE FUNCTION subject_comment_locked();
