GRANT SELECT, INSERT, UPDATE ON levels, classes TO edubridge_app;
--> statement-breakpoint
ALTER TABLE levels ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE levels FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY levels_tenant ON levels
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE classes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE classes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY classes_tenant ON classes
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
