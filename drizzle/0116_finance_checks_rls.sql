-- Finance checks (R5-2, module forecasting): tenant isolation, and reviews that are kept as written. A flag is
-- reviewed once (unique key); a review is never changed or removed, by any role.

GRANT SELECT, INSERT ON finance_check_reviews TO edubridge_app;
--> statement-breakpoint
ALTER TABLE finance_check_reviews ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE finance_check_reviews FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY finance_check_reviews_tenant ON finance_check_reviews
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE finance_check_reviews ADD CONSTRAINT finance_check_reviews_rule
  CHECK (rule in ('duplicate_reference', 'many_voids', 'out_of_hours', 'momo_unmatched', 'large_refund', 'period_reopened'));
--> statement-breakpoint
CREATE TRIGGER finance_check_reviews_insert_only BEFORE UPDATE OR DELETE OR TRUNCATE ON finance_check_reviews
  FOR EACH STATEMENT EXECUTE FUNCTION payroll_insert_only();
