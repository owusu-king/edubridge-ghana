-- Billing records (Phase J): SMS usage and EduBridge's invoices to schools.

-- SMS usage: written with the message, never changed. Schools read their own; platform staff read all.
GRANT SELECT, INSERT ON sms_usage TO edubridge_app;
--> statement-breakpoint
ALTER TABLE sms_usage ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE sms_usage FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY sms_usage_select ON sms_usage FOR SELECT
  USING (tenant_id = app_current_tenant_id() OR app_is_platform_admin());
--> statement-breakpoint
CREATE POLICY sms_usage_insert ON sms_usage FOR INSERT
  WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
CREATE TRIGGER sms_usage_no_update_delete BEFORE UPDATE OR DELETE ON sms_usage
  FOR EACH ROW EXECUTE FUNCTION history_record_immutable();
--> statement-breakpoint
CREATE TRIGGER sms_usage_no_truncate BEFORE TRUNCATE ON sms_usage
  FOR EACH STATEMENT EXECUTE FUNCTION history_record_immutable();
--> statement-breakpoint

-- A parent sign-in code is requested outside any one school (the number may be on file at several).
-- This records its usage against each of those schools, and only for a sign-in code just queued that has
-- not been recorded yet. Each school's tenant context is set in turn, so row-level security still applies,
-- and the caller's context is restored afterwards.
CREATE FUNCTION record_parent_code_usage(p_outbox_id uuid, p_tenant_ids uuid[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  previous text := current_setting('app.tenant_id', true);
  school uuid;
  schools int := cardinality(p_tenant_ids);
BEGIN
  IF schools IS NULL OR schools < 1 OR schools > 100 THEN
    RAISE EXCEPTION 'between 1 and 100 schools' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM notification_outbox
    WHERE id = p_outbox_id AND template = 'phone_code' AND channel = 'sms'
      AND created_at > now() - interval '5 minutes'
  ) THEN
    RAISE EXCEPTION 'not a new sign-in code' USING ERRCODE = 'check_violation';
  END IF;
  FOREACH school IN ARRAY p_tenant_ids LOOP
    -- Row-level security shows each school's rows only in its own context, so the check runs per school.
    PERFORM set_config('app.tenant_id', school::text, true);
    IF EXISTS (SELECT 1 FROM sms_usage WHERE outbox_id = p_outbox_id AND tenant_id = school) THEN
      RAISE EXCEPTION 'this sign-in code is already recorded' USING ERRCODE = 'check_violation';
    END IF;
    INSERT INTO sms_usage (tenant_id, kind, outbox_id, shared_with)
      VALUES (school, 'parent_code', p_outbox_id, schools);
  END LOOP;
  PERFORM set_config('app.tenant_id', coalesce(previous, ''), true);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION record_parent_code_usage(uuid, uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION record_parent_code_usage(uuid, uuid[]) TO edubridge_app;
--> statement-breakpoint

-- Invoices to schools: platform staff issue them; a school's members read their own. An issued invoice
-- only ever changes by being marked paid or voided, once.
CREATE SEQUENCE subscription_invoice_seq;
--> statement-breakpoint
GRANT USAGE ON SEQUENCE subscription_invoice_seq TO edubridge_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON subscription_invoices TO edubridge_app;
--> statement-breakpoint
GRANT UPDATE (paid_on, payment_reference, payment_recorded_by_user_id, voided_at, void_reason, voided_by_user_id)
  ON subscription_invoices TO edubridge_app;
--> statement-breakpoint
ALTER TABLE subscription_invoices ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE subscription_invoices FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY subscription_invoices_select ON subscription_invoices FOR SELECT
  USING (tenant_id = app_current_tenant_id() OR app_is_platform_admin());
--> statement-breakpoint
CREATE POLICY subscription_invoices_insert ON subscription_invoices FOR INSERT
  WITH CHECK (tenant_id = app_current_tenant_id() AND app_is_platform_admin());
--> statement-breakpoint
CREATE POLICY subscription_invoices_update ON subscription_invoices FOR UPDATE
  USING (tenant_id = app_current_tenant_id() AND app_is_platform_admin())
  WITH CHECK (tenant_id = app_current_tenant_id() AND app_is_platform_admin());
--> statement-breakpoint
CREATE FUNCTION subscription_invoice_settle_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'subscription invoices are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW.tenant_id, NEW.invoice_number, NEW.lines, NEW.total_pesewas, NEW.currency_code, NEW.period_starts_on,
      NEW.period_ends_on, NEW.issued_on, NEW.due_on, NEW.created_by_user_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.invoice_number, OLD.lines, OLD.total_pesewas, OLD.currency_code, OLD.period_starts_on,
      OLD.period_ends_on, OLD.issued_on, OLD.due_on, OLD.created_by_user_id, OLD.created_at) THEN
    RAISE EXCEPTION 'an issued invoice cannot be changed' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.paid_on IS NOT NULL OR OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'this invoice is already settled' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER subscription_invoices_settle_once BEFORE UPDATE OR DELETE ON subscription_invoices
  FOR EACH ROW EXECUTE FUNCTION subscription_invoice_settle_once();
--> statement-breakpoint
CREATE TRIGGER subscription_invoices_no_truncate BEFORE TRUNCATE ON subscription_invoices
  FOR EACH STATEMENT EXECUTE FUNCTION history_record_immutable();
