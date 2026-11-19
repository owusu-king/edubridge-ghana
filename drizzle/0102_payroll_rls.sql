-- Payroll records (R4-2, module payroll): grants, tenant isolation, and the rules that keep payroll trustworthy:
-- salaries are insert-only, an approved run and its lines never change, adjustments apply once. Nothing is
-- deleted by the app.

GRANT SELECT, INSERT ON pay_components TO edubridge_app;
--> statement-breakpoint
GRANT UPDATE (name, archived_at) ON pay_components TO edubridge_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON staff_salaries, staff_salary_components TO edubridge_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON payroll_runs TO edubridge_app;
--> statement-breakpoint
GRANT UPDATE (status, approved_by_user_id, approved_at, cancelled_by_user_id, cancelled_at, prepared_by_user_id,
  prepared_at) ON payroll_runs TO edubridge_app;
--> statement-breakpoint
-- Draft lines are replaced when a draft is recalculated; the trigger refuses this once the run is approved.
GRANT SELECT, INSERT, DELETE ON payroll_lines TO edubridge_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON payroll_adjustments TO edubridge_app;
--> statement-breakpoint
GRANT UPDATE (applied_run_id, cancelled_by_user_id, cancelled_at) ON payroll_adjustments TO edubridge_app;
--> statement-breakpoint

ALTER TABLE pay_components ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE pay_components FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY pay_components_tenant ON pay_components
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE staff_salaries ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE staff_salaries FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY staff_salaries_tenant ON staff_salaries
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE staff_salary_components ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE staff_salary_components FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY staff_salary_components_tenant ON staff_salary_components
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE payroll_runs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE payroll_runs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY payroll_runs_tenant ON payroll_runs
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE payroll_lines ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE payroll_lines FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY payroll_lines_tenant ON payroll_lines
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE payroll_adjustments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE payroll_adjustments FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY payroll_adjustments_tenant ON payroll_adjustments
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint

ALTER TABLE pay_components ADD CONSTRAINT pay_components_enums
  CHECK (kind in ('earning', 'deduction', 'employer') AND basis in ('fixed', 'percent_basic', 'percent_gross'));
--> statement-breakpoint
ALTER TABLE payroll_runs ADD CONSTRAINT payroll_runs_status CHECK (status in ('draft', 'approved', 'cancelled'));
--> statement-breakpoint
ALTER TABLE payroll_adjustments ADD CONSTRAINT payroll_adjustments_kind CHECK (kind in ('earning', 'deduction'));
--> statement-breakpoint

-- Salaries and their components are never changed or removed, by any role.
CREATE FUNCTION payroll_insert_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is insert-only', TG_TABLE_NAME USING ERRCODE = 'check_violation';
END $$;
--> statement-breakpoint
CREATE TRIGGER staff_salaries_insert_only BEFORE UPDATE OR DELETE OR TRUNCATE ON staff_salaries
  FOR EACH STATEMENT EXECUTE FUNCTION payroll_insert_only();
--> statement-breakpoint
CREATE TRIGGER staff_salary_components_insert_only BEFORE UPDATE OR DELETE OR TRUNCATE ON staff_salary_components
  FOR EACH STATEMENT EXECUTE FUNCTION payroll_insert_only();
--> statement-breakpoint

-- A run goes from draft to approved or cancelled, once. While a draft, only its preparer and time may change
-- (recalculation). No run is deleted.
CREATE FUNCTION payroll_run_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payroll runs are never deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'an approved or cancelled payroll run cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.month <> OLD.month OR NEW.currency_code <> OLD.currency_code THEN
    RAISE EXCEPTION 'a payroll run cannot be moved' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER payroll_runs_transition BEFORE UPDATE OR DELETE ON payroll_runs
  FOR EACH ROW EXECUTE FUNCTION payroll_run_transition();
--> statement-breakpoint

-- Lines belong to a draft: once its run is approved or cancelled, none is added, changed or removed.
CREATE FUNCTION payroll_line_draft_only() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  run_status text;
BEGIN
  SELECT status INTO run_status FROM payroll_runs
    WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.run_id ELSE NEW.run_id END;
  IF run_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'payroll lines change only while their run is a draft' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'payroll lines are replaced, not edited' USING ERRCODE = 'check_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
--> statement-breakpoint
CREATE TRIGGER payroll_lines_draft_only BEFORE INSERT OR UPDATE OR DELETE ON payroll_lines
  FOR EACH ROW EXECUTE FUNCTION payroll_line_draft_only();
--> statement-breakpoint
CREATE TRIGGER payroll_lines_no_truncate BEFORE TRUNCATE ON payroll_lines
  FOR EACH STATEMENT EXECUTE FUNCTION payroll_insert_only();
--> statement-breakpoint

-- An adjustment is applied once (to an approved run) or cancelled once; what it says never changes.
CREATE FUNCTION payroll_adjustment_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payroll adjustments are never deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.applied_run_id IS NOT NULL OR OLD.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION 'an applied or cancelled adjustment cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.staff_id <> OLD.staff_id OR NEW.month <> OLD.month OR NEW.kind <> OLD.kind
    OR NEW.description <> OLD.description OR NEW.amount_minor <> OLD.amount_minor
    OR NEW.created_by_user_id <> OLD.created_by_user_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a payroll adjustment cannot be rewritten' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.applied_run_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM payroll_runs WHERE id = NEW.applied_run_id AND status = 'approved') THEN
    RAISE EXCEPTION 'adjustments are applied to an approved run' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER payroll_adjustments_once BEFORE UPDATE OR DELETE ON payroll_adjustments
  FOR EACH ROW EXECUTE FUNCTION payroll_adjustment_once();
