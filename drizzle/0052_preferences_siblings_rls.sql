-- School preferences and the sibling discount rule (Phase N): grants and tenant isolation.

GRANT SELECT, INSERT, UPDATE ON school_preferences, sibling_discount_rules TO edubridge_app;
--> statement-breakpoint
ALTER TABLE school_preferences ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE school_preferences FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY school_preferences_tenant ON school_preferences
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE sibling_discount_rules ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE sibling_discount_rules FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY sibling_discount_rules_tenant ON sibling_discount_rules
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
