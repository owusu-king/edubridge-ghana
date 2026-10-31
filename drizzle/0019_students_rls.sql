GRANT SELECT, INSERT, UPDATE ON tenant_counters, students TO edubridge_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON enrolments TO edubridge_app;
--> statement-breakpoint
ALTER TABLE tenant_counters ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tenant_counters FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_counters_tenant ON tenant_counters
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE students ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE students FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY students_tenant ON students
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE enrolments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE enrolments FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY enrolments_tenant ON enrolments
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
