-- Subscription self-service (R3-6): plan presets, plan change requests, invoice details and the automatic
-- status rules.

ALTER TABLE tenant_entitlements ADD CONSTRAINT tenant_entitlements_plan_preset_fk
  FOREIGN KEY (plan_preset_id) REFERENCES plan_presets(id) ON DELETE RESTRICT;
--> statement-breakpoint

-- Presets: everyone may read them (a school chooses one when asking for a change); only platform
-- administrators add or change them, and none is deleted (archived instead).
GRANT SELECT, INSERT, UPDATE ON plan_presets TO edubridge_app;
--> statement-breakpoint
ALTER TABLE plan_presets ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE plan_presets FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY plan_presets_select ON plan_presets FOR SELECT USING (true);
--> statement-breakpoint
CREATE POLICY plan_presets_insert ON plan_presets FOR INSERT WITH CHECK (app_is_platform_admin());
--> statement-breakpoint
CREATE POLICY plan_presets_update ON plan_presets FOR UPDATE
  USING (app_is_platform_admin()) WITH CHECK (app_is_platform_admin());
--> statement-breakpoint
ALTER TABLE plan_presets ADD CONSTRAINT plan_presets_billing_period
  CHECK (billing_period in ('termly', 'annual', 'monthly'));
--> statement-breakpoint

-- Requests: the school's own (platform administrators also see every school's, to decide them).
GRANT SELECT, INSERT, UPDATE ON plan_change_requests TO edubridge_app;
--> statement-breakpoint
ALTER TABLE plan_change_requests ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE plan_change_requests FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY plan_change_requests_select ON plan_change_requests FOR SELECT
  USING (tenant_id = app_current_tenant_id() OR app_is_platform_admin());
--> statement-breakpoint
CREATE POLICY plan_change_requests_insert ON plan_change_requests FOR INSERT
  WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
CREATE POLICY plan_change_requests_update ON plan_change_requests FOR UPDATE
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE plan_change_requests ADD CONSTRAINT plan_change_requests_status
  CHECK (status in ('pending', 'approved', 'declined', 'withdrawn'));
--> statement-breakpoint

-- A decided (or withdrawn) request never changes, and no request is deleted.
CREATE FUNCTION plan_change_request_decided_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'a decided plan change request cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.preset_id IS DISTINCT FROM OLD.preset_id
    OR NEW.message IS DISTINCT FROM OLD.message OR NEW.requested_by_user_id <> OLD.requested_by_user_id
    OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a plan change request cannot be rewritten' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER plan_change_requests_decided_once BEFORE UPDATE OR DELETE ON plan_change_requests
  FOR EACH ROW EXECUTE FUNCTION plan_change_request_decided_once();
--> statement-breakpoint

-- Invoice details printed on EduBridge's invoices.
GRANT UPDATE (invoice_issuer_details, invoice_payment_instructions) ON platform_settings TO edubridge_app;
--> statement-breakpoint
ALTER TABLE platform_settings ADD CONSTRAINT platform_settings_invoice_text
  CHECK (coalesce(char_length(invoice_issuer_details), 0) <= 500
    AND coalesce(char_length(invoice_payment_instructions), 0) <= 500);
--> statement-breakpoint

-- SUB-05: the automatic status rules, applied by the worker. The app role cannot change a school's plan
-- (platform administrators only), so this runs as the owner and applies only these rules, with the school's
-- own date and the platform's grace period:
--   trial ended: active if paid beyond today, else grace, then past_due once the grace period is over;
--   active and paid_until passed: grace, then past_due;
--   grace or past_due set by these rules, and paid beyond today again: active;
--   grace (however set) whose dates are past the grace period: past_due.
-- Demo and suspended schools are left alone. Returns the change, or nothing. It works only on the school
-- whose context is set (the caller's tenant transaction), and its update passes row-level security through
-- the policy below, which is for the owner role (this function's definer) and that school only.
CREATE POLICY tenant_entitlements_automatic_status ON tenant_entitlements FOR UPDATE TO CURRENT_USER
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
CREATE FUNCTION subscription_apply_automatic_status(p_tenant uuid)
  RETURNS TABLE (from_status text, to_status text)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  r record;
  today date;
  grace integer;
  ended date;
  next_status text := NULL;
BEGIN
  IF p_tenant IS DISTINCT FROM app_current_tenant_id() THEN
    RAISE EXCEPTION 'the school context does not match' USING ERRCODE = '42501';
  END IF;
  SELECT e.subscription_status, e.trial_ends_on, e.paid_until, e.status_auto, t.timezone, t.is_demo, t.status
    INTO r
    FROM tenant_entitlements e JOIN tenants t ON t.id = e.tenant_id
    WHERE e.tenant_id = p_tenant
    FOR UPDATE OF e;
  IF NOT FOUND OR r.is_demo OR r.status <> 'active' THEN
    RETURN;
  END IF;
  today := (now() AT TIME ZONE r.timezone)::date;
  SELECT coalesce((SELECT grace_days FROM platform_settings LIMIT 1), 3) INTO grace;
  IF r.subscription_status = 'trial' THEN
    IF r.trial_ends_on IS NOT NULL AND today > r.trial_ends_on THEN
      IF r.paid_until IS NOT NULL AND r.paid_until >= today THEN
        next_status := 'active';
      ELSIF today > r.trial_ends_on + grace THEN
        next_status := 'past_due';
      ELSE
        next_status := 'grace';
      END IF;
    END IF;
  ELSIF r.subscription_status = 'active' THEN
    IF r.paid_until IS NOT NULL AND today > r.paid_until THEN
      next_status := CASE WHEN today > r.paid_until + grace THEN 'past_due' ELSE 'grace' END;
    END IF;
  ELSE
    IF r.paid_until IS NOT NULL AND r.paid_until >= today THEN
      IF r.status_auto THEN
        next_status := 'active';
      END IF;
    ELSIF r.subscription_status = 'grace' THEN
      ended := greatest(r.paid_until, r.trial_ends_on);
      IF ended IS NOT NULL AND today > ended + grace THEN
        next_status := 'past_due';
      END IF;
    END IF;
  END IF;
  IF next_status IS NULL OR next_status = r.subscription_status THEN
    RETURN;
  END IF;
  UPDATE tenant_entitlements
    SET subscription_status = next_status, status_auto = true, updated_at = now()
    WHERE tenant_id = p_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription status not updated' USING ERRCODE = 'P0002';
  END IF;
  from_status := r.subscription_status;
  to_status := next_status;
  RETURN NEXT;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION subscription_apply_automatic_status(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION subscription_apply_automatic_status(uuid) TO edubridge_app;
