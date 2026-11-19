-- Early warning (R5-3, module early_warning): tenant isolation, and history that cannot be rewritten. Reviews and plan
-- updates are insert-only; a support plan is never edited or deleted, only closed once with an outcome.

GRANT SELECT, INSERT ON early_warning_rules TO edubridge_app;
--> statement-breakpoint
GRANT UPDATE (attendance_on, attendance_percent, attendance_days, absences_on, absences_in_a_row, average_on,
  average_drop, subjects_on, subjects_count, pass_mark, updated_by_user_id, updated_at) ON early_warning_rules TO edubridge_app;
--> statement-breakpoint
ALTER TABLE early_warning_rules ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE early_warning_rules FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY early_warning_rules_tenant ON early_warning_rules
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint

GRANT SELECT, INSERT ON support_plans TO edubridge_app;
--> statement-breakpoint
GRANT UPDATE (closed_at, closed_by_user_id, outcome) ON support_plans TO edubridge_app;
--> statement-breakpoint
ALTER TABLE support_plans ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE support_plans FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY support_plans_tenant ON support_plans
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
CREATE FUNCTION support_plan_close_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.closed_at IS NOT NULL OR NEW.closed_at IS NULL
    OR NEW.goal IS DISTINCT FROM OLD.goal OR NEW.actions IS DISTINCT FROM OLD.actions
    OR NEW.responsible IS DISTINCT FROM OLD.responsible OR NEW.review_on IS DISTINCT FROM OLD.review_on
    OR NEW.student_id IS DISTINCT FROM OLD.student_id THEN
    RAISE EXCEPTION 'a support plan is closed once and never edited or deleted' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER support_plans_close_once BEFORE UPDATE OR DELETE ON support_plans
  FOR EACH ROW EXECUTE FUNCTION support_plan_close_once();
--> statement-breakpoint
CREATE TRIGGER support_plans_no_truncate BEFORE TRUNCATE ON support_plans
  FOR EACH STATEMENT EXECUTE FUNCTION payroll_insert_only();
--> statement-breakpoint

GRANT SELECT, INSERT ON support_plan_updates TO edubridge_app;
--> statement-breakpoint
ALTER TABLE support_plan_updates ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE support_plan_updates FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY support_plan_updates_tenant ON support_plan_updates
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
CREATE TRIGGER support_plan_updates_insert_only BEFORE UPDATE OR DELETE OR TRUNCATE ON support_plan_updates
  FOR EACH STATEMENT EXECUTE FUNCTION payroll_insert_only();
--> statement-breakpoint

GRANT SELECT, INSERT ON early_warning_reviews TO edubridge_app;
--> statement-breakpoint
ALTER TABLE early_warning_reviews ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE early_warning_reviews FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY early_warning_reviews_tenant ON early_warning_reviews
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE early_warning_reviews ADD CONSTRAINT early_warning_reviews_values
  CHECK (rule in ('attendance_low', 'absent_in_a_row', 'average_down', 'subjects_below')
    AND outcome in ('no_action', 'support_plan', 'referred'));
--> statement-breakpoint
CREATE TRIGGER early_warning_reviews_insert_only BEFORE UPDATE OR DELETE OR TRUNCATE ON early_warning_reviews
  FOR EACH STATEMENT EXECUTE FUNCTION payroll_insert_only();
