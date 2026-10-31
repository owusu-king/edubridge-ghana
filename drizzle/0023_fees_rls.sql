GRANT SELECT, INSERT, UPDATE ON fee_items TO edubridge_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON fee_structure_lines TO edubridge_app;
--> statement-breakpoint
ALTER TABLE fee_items ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE fee_items FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY fee_items_tenant ON fee_items
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE fee_structure_lines ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE fee_structure_lines FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY fee_structure_lines_tenant ON fee_structure_lines
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
