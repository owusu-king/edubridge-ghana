-- Plans can be cancelled (status update); instalments are written once and never changed.
GRANT SELECT, INSERT, UPDATE ON payment_plans TO edubridge_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON payment_plan_instalments TO edubridge_app;
--> statement-breakpoint
ALTER TABLE payment_plans ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE payment_plans FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY payment_plans_tenant ON payment_plans
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE payment_plan_instalments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE payment_plan_instalments FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY payment_plan_instalments_tenant ON payment_plan_instalments
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
-- At most one active plan per student.
CREATE UNIQUE INDEX payment_plans_one_active ON payment_plans (student_id) WHERE status = 'active';
