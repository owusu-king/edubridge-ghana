-- AI gateway (R5-4): platform settings and flags only platform staff change; per-school limits readable by the
-- school, set by platform staff; usage insert-only, read by the school and platform staff. Nothing paid is switched
-- on: the global switch starts off and the provider starts as "none" (D-R5-10).

GRANT UPDATE (ai_enabled, ai_provider, ai_base_url, ai_identifiable_approved, ai_platform_monthly_tokens,
  ai_school_monthly_tokens, ai_user_per_minute, ai_user_per_hour, ai_user_daily_tokens, ai_max_output_tokens,
  assistant_model) ON platform_settings TO edubridge_app;
--> statement-breakpoint
ALTER TABLE platform_settings ADD CONSTRAINT platform_settings_ai_values CHECK (
  ai_provider in ('none', 'ollama', 'groq', 'openai_compatible', 'anthropic')
  AND ai_platform_monthly_tokens between 0 and 1000000000 AND ai_school_monthly_tokens between 0 and 100000000
  AND ai_user_per_minute between 1 and 60 AND ai_user_per_hour between 1 and 1000
  AND ai_user_daily_tokens between 1000 and 10000000 AND ai_max_output_tokens between 256 and 16000
  -- Only a paid provider can be approved for identifiable data.
  AND (NOT ai_identifiable_approved OR ai_provider in ('openai_compatible', 'anthropic')));
--> statement-breakpoint

-- The assistant keeps the platform switch it had (as its task flag; the global switch starts
-- off). Before row-level security, which only lets platform staff add flags.
INSERT INTO ai_feature_flags (task, enabled)
  SELECT 'assistant', coalesce((SELECT assistant_enabled FROM platform_settings LIMIT 1), false)
  ON CONFLICT DO NOTHING;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON ai_feature_flags TO edubridge_app;
--> statement-breakpoint
ALTER TABLE ai_feature_flags ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE ai_feature_flags FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY ai_feature_flags_select ON ai_feature_flags FOR SELECT USING (true);
--> statement-breakpoint
CREATE POLICY ai_feature_flags_insert ON ai_feature_flags FOR INSERT WITH CHECK (app_is_platform_admin());
--> statement-breakpoint
CREATE POLICY ai_feature_flags_update ON ai_feature_flags FOR UPDATE
  USING (app_is_platform_admin()) WITH CHECK (app_is_platform_admin());
--> statement-breakpoint
ALTER TABLE ai_feature_flags ADD CONSTRAINT ai_feature_flags_task CHECK (task in ('assistant'));
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON ai_school_limits TO edubridge_app;
--> statement-breakpoint
ALTER TABLE ai_school_limits ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE ai_school_limits FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY ai_school_limits_select ON ai_school_limits FOR SELECT
  USING (tenant_id = app_current_tenant_id() OR app_is_platform_admin());
--> statement-breakpoint
CREATE POLICY ai_school_limits_insert ON ai_school_limits FOR INSERT
  WITH CHECK (tenant_id = app_current_tenant_id() AND app_is_platform_admin());
--> statement-breakpoint
CREATE POLICY ai_school_limits_update ON ai_school_limits FOR UPDATE
  USING (tenant_id = app_current_tenant_id() AND app_is_platform_admin())
  WITH CHECK (tenant_id = app_current_tenant_id() AND app_is_platform_admin());
--> statement-breakpoint
ALTER TABLE ai_school_limits ADD CONSTRAINT ai_school_limits_values CHECK (
  coalesce(monthly_tokens, 0) between 0 and 100000000 AND coalesce(user_per_hour, 1) between 1 and 1000
  AND coalesce(user_daily_tokens, 1000) between 1000 and 10000000);
--> statement-breakpoint

GRANT SELECT, INSERT ON ai_usage TO edubridge_app;
--> statement-breakpoint
ALTER TABLE ai_usage ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE ai_usage FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY ai_usage_select ON ai_usage FOR SELECT
  USING (tenant_id = app_current_tenant_id() OR app_is_platform_admin());
--> statement-breakpoint
CREATE POLICY ai_usage_insert ON ai_usage FOR INSERT WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE ai_usage ADD CONSTRAINT ai_usage_values CHECK (
  outcome in ('ok', 'refused', 'length', 'provider_quota', 'unavailable', 'failed', 'blocked')
  AND input_tokens >= 0 AND output_tokens >= 0 AND cached_input_tokens >= 0 AND coalesce(cost_micros, 0) >= 0);
--> statement-breakpoint
CREATE TRIGGER ai_usage_insert_only BEFORE UPDATE OR DELETE OR TRUNCATE ON ai_usage
  FOR EACH STATEMENT EXECUTE FUNCTION payroll_insert_only();
--> statement-breakpoint

-- Tokens across every school, by month: totals only (no school's records), for the platform limit.
GRANT SELECT, INSERT ON ai_platform_months TO edubridge_app;
--> statement-breakpoint
GRANT UPDATE (tokens) ON ai_platform_months TO edubridge_app;
--> statement-breakpoint
ALTER TABLE ai_platform_months ADD CONSTRAINT ai_platform_months_values
  CHECK (tokens >= 0 AND extract(day from month) = 1);
