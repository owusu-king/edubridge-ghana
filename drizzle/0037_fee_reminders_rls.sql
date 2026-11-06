-- Reminders are a record of messages sent: insert-only, like payments.
GRANT SELECT, INSERT ON fee_reminders TO edubridge_app;
--> statement-breakpoint
ALTER TABLE fee_reminders ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE fee_reminders FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY fee_reminders_tenant ON fee_reminders
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
CREATE TRIGGER fee_reminders_no_update_delete BEFORE UPDATE OR DELETE ON fee_reminders
  FOR EACH ROW EXECUTE FUNCTION financial_record_immutable();
--> statement-breakpoint
CREATE TRIGGER fee_reminders_no_truncate BEFORE TRUNCATE ON fee_reminders
  FOR EACH STATEMENT EXECUTE FUNCTION financial_record_immutable();
