-- R4-0 (ADR 0003): add-ons, trials and promotions per school, release access, catalogue prices and add-on
-- requests. Every school's rows are visible to that school and to platform administrators; only platform
-- administrators write them. Nothing here is ever deleted.

-- school_modules: a school's add-ons, trials, promotions and agreements (SUB-06).
GRANT SELECT, INSERT ON school_modules TO edubridge_app;
--> statement-breakpoint
GRANT UPDATE (ends_on, ended_at, ended_by_user_id, end_reason) ON school_modules TO edubridge_app;
--> statement-breakpoint
ALTER TABLE school_modules ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE school_modules FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY school_modules_select ON school_modules FOR SELECT
  USING (tenant_id = app_current_tenant_id() OR app_is_platform_admin());
--> statement-breakpoint
CREATE POLICY school_modules_insert ON school_modules FOR INSERT
  WITH CHECK (tenant_id = app_current_tenant_id() AND app_is_platform_admin());
--> statement-breakpoint
CREATE POLICY school_modules_update ON school_modules FOR UPDATE
  USING (tenant_id = app_current_tenant_id() AND app_is_platform_admin())
  WITH CHECK (tenant_id = app_current_tenant_id() AND app_is_platform_admin());
--> statement-breakpoint
ALTER TABLE school_modules ADD CONSTRAINT school_modules_source
  CHECK (source in ('addon', 'trial', 'promotion', 'enterprise'));
--> statement-breakpoint
ALTER TABLE school_modules ADD CONSTRAINT school_modules_enums
  CHECK ((billing_period is null or billing_period in ('termly', 'annual', 'monthly'))
    AND (price_unit is null or price_unit in ('flat', 'per_student')));
--> statement-breakpoint

-- A grant's end can be scheduled once (no end date yet) and it can be ended once; nothing else changes.
CREATE FUNCTION school_module_end_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'school modules are never deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'an ended module grant cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.ends_on IS DISTINCT FROM OLD.ends_on AND OLD.ends_on IS NOT NULL THEN
    RAISE EXCEPTION 'a module grant''s end date is set once' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.module <> OLD.module OR NEW.source <> OLD.source
    OR NEW.starts_on <> OLD.starts_on OR NEW.billing_period IS DISTINCT FROM OLD.billing_period
    OR NEW.price_pesewas IS DISTINCT FROM OLD.price_pesewas OR NEW.price_unit IS DISTINCT FROM OLD.price_unit
    OR NEW.currency_code IS DISTINCT FROM OLD.currency_code OR NEW.note IS DISTINCT FROM OLD.note
    OR NEW.granted_by_user_id <> OLD.granted_by_user_id OR NEW.granted_at <> OLD.granted_at THEN
    RAISE EXCEPTION 'a module grant cannot be rewritten' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER school_modules_end_once BEFORE UPDATE OR DELETE ON school_modules
  FOR EACH ROW EXECUTE FUNCTION school_module_end_once();
--> statement-breakpoint

-- module_release_access: pilot and internal-testing schools (REL-02).
GRANT SELECT, INSERT ON module_release_access TO edubridge_app;
--> statement-breakpoint
GRANT UPDATE (ended_at, ended_by_user_id) ON module_release_access TO edubridge_app;
--> statement-breakpoint
ALTER TABLE module_release_access ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE module_release_access FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY module_release_access_select ON module_release_access FOR SELECT
  USING (tenant_id = app_current_tenant_id() OR app_is_platform_admin());
--> statement-breakpoint
CREATE POLICY module_release_access_insert ON module_release_access FOR INSERT
  WITH CHECK (tenant_id = app_current_tenant_id() AND app_is_platform_admin());
--> statement-breakpoint
CREATE POLICY module_release_access_update ON module_release_access FOR UPDATE
  USING (tenant_id = app_current_tenant_id() AND app_is_platform_admin())
  WITH CHECK (tenant_id = app_current_tenant_id() AND app_is_platform_admin());
--> statement-breakpoint
CREATE FUNCTION module_release_access_end_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'release access is ended once and never deleted' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER module_release_access_end_once BEFORE UPDATE OR DELETE ON module_release_access
  FOR EACH ROW EXECUTE FUNCTION module_release_access_end_once();
--> statement-breakpoint

-- catalog_prices: no school data; every signed-in school may read them (to see what an add-on costs).
GRANT SELECT, INSERT ON catalog_prices TO edubridge_app;
--> statement-breakpoint
GRANT UPDATE (archived_at) ON catalog_prices TO edubridge_app;
--> statement-breakpoint
ALTER TABLE catalog_prices ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE catalog_prices FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY catalog_prices_select ON catalog_prices FOR SELECT USING (true);
--> statement-breakpoint
CREATE POLICY catalog_prices_insert ON catalog_prices FOR INSERT WITH CHECK (app_is_platform_admin());
--> statement-breakpoint
CREATE POLICY catalog_prices_update ON catalog_prices FOR UPDATE
  USING (app_is_platform_admin()) WITH CHECK (app_is_platform_admin());
--> statement-breakpoint
ALTER TABLE catalog_prices ADD CONSTRAINT catalog_prices_enums
  CHECK (billing_period in ('termly', 'annual', 'monthly') AND unit in ('flat', 'per_student'));
--> statement-breakpoint
CREATE FUNCTION catalog_price_archive_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'a catalogue price is archived once and never deleted' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER catalog_prices_archive_once BEFORE UPDATE OR DELETE ON catalog_prices
  FOR EACH ROW EXECUTE FUNCTION catalog_price_archive_once();
--> statement-breakpoint

-- Add-on requests through the existing plan change requests (SUB-08).
ALTER TABLE plan_change_requests ADD CONSTRAINT plan_change_requests_kind
  CHECK (kind in ('plan', 'add_module', 'cancel_module'));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION plan_change_request_decided_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'a decided plan change request cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.preset_id IS DISTINCT FROM OLD.preset_id
    OR NEW.message IS DISTINCT FROM OLD.message OR NEW.requested_by_user_id <> OLD.requested_by_user_id
    OR NEW.created_at <> OLD.created_at OR NEW.kind <> OLD.kind OR NEW.module IS DISTINCT FROM OLD.module THEN
    RAISE EXCEPTION 'a plan change request cannot be rewritten' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

-- The read-only window after an add-on ends (ENT-08) is a platform setting.
GRANT UPDATE (module_read_only_days) ON platform_settings TO edubridge_app;
