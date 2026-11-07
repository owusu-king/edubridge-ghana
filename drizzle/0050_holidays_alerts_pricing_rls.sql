-- Holidays, absence SMS and SMS pricing (Phase L): grants, isolation and append-only alerts.

-- Platform settings: one row everyone may read (the app needs the grace period on every request);
-- only platform administrators change it.
INSERT INTO platform_settings (id) VALUES (true) ON CONFLICT DO NOTHING;
--> statement-breakpoint
GRANT SELECT, UPDATE (sms_price_pesewas, grace_days, updated_at, updated_by_user_id) ON platform_settings TO edubridge_app;
--> statement-breakpoint
ALTER TABLE platform_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform_settings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY platform_settings_select ON platform_settings FOR SELECT USING (true);
--> statement-breakpoint
CREATE POLICY platform_settings_update ON platform_settings FOR UPDATE
  USING (app_is_platform_admin()) WITH CHECK (app_is_platform_admin());
--> statement-breakpoint

-- Holidays: added and removed by the school (not financial records; changes are audited).
GRANT SELECT, INSERT, DELETE ON school_holidays TO edubridge_app;
--> statement-breakpoint
ALTER TABLE school_holidays ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE school_holidays FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY school_holidays_tenant ON school_holidays
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON absence_alert_settings TO edubridge_app;
--> statement-breakpoint
ALTER TABLE absence_alert_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE absence_alert_settings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY absence_alert_settings_tenant ON absence_alert_settings
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint

-- Absence alerts sent: insert-only for every role.
GRANT SELECT, INSERT ON absence_alerts TO edubridge_app;
--> statement-breakpoint
ALTER TABLE absence_alerts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE absence_alerts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY absence_alerts_tenant ON absence_alerts
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
CREATE TRIGGER absence_alerts_no_update_delete BEFORE UPDATE OR DELETE ON absence_alerts
  FOR EACH ROW EXECUTE FUNCTION history_record_immutable();
--> statement-breakpoint
CREATE TRIGGER absence_alerts_no_truncate BEFORE TRUNCATE ON absence_alerts
  FOR EACH STATEMENT EXECUTE FUNCTION history_record_immutable();
