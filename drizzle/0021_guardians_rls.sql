CREATE UNIQUE INDEX guardians_tenant_phone_unique ON guardians (tenant_id, phone) WHERE phone IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX student_guardians_one_primary ON student_guardians (student_id) WHERE is_primary;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON guardians TO edubridge_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON student_guardians TO edubridge_app;
--> statement-breakpoint
ALTER TABLE guardians ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE guardians FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY guardians_tenant ON guardians
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE student_guardians ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE student_guardians FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY student_guardians_tenant ON student_guardians
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
