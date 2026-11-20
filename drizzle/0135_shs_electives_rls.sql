-- Elective subjects (SHS): which students take which electives. A working record academic staff change; each change is
-- audited by the application.
GRANT SELECT, INSERT, DELETE ON student_subject_choices TO edubridge_app;
--> statement-breakpoint
ALTER TABLE student_subject_choices ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE student_subject_choices FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY student_subject_choices_tenant ON student_subject_choices
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
