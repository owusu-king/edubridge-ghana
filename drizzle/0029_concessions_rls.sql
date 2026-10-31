-- Concessions can be ended (status update) but never deleted; billed discounts live in the ledger.
GRANT SELECT, INSERT, UPDATE ON fee_concessions TO edubridge_app;
--> statement-breakpoint
ALTER TABLE fee_concessions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE fee_concessions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY fee_concessions_tenant ON fee_concessions
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
