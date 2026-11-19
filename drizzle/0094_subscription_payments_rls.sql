-- Online payment of EduBridge invoices (SUB-04, D-R3-5).

GRANT SELECT, INSERT ON subscription_payments TO edubridge_app;
--> statement-breakpoint
GRANT UPDATE (status, provider_reference, channel, paid_at, updated_at) ON subscription_payments TO edubridge_app;
--> statement-breakpoint
ALTER TABLE subscription_payments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE subscription_payments FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY subscription_payments_select ON subscription_payments FOR SELECT
  USING (tenant_id = app_current_tenant_id() OR app_is_platform_admin());
--> statement-breakpoint
CREATE POLICY subscription_payments_insert ON subscription_payments FOR INSERT
  WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
CREATE POLICY subscription_payments_update ON subscription_payments FOR UPDATE
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE subscription_payments ADD CONSTRAINT subscription_payments_status
  CHECK (status in ('initiated', 'succeeded', 'failed'));
--> statement-breakpoint
ALTER TABLE subscription_payments ADD CONSTRAINT subscription_payments_provider
  CHECK (provider in ('paystack', 'mock'));
--> statement-breakpoint
-- A succeeded payment never changes.
CREATE FUNCTION subscription_payment_final() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'succeeded' THEN
    RAISE EXCEPTION 'a succeeded payment cannot change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER subscription_payments_final BEFORE UPDATE ON subscription_payments
  FOR EACH ROW EXECUTE FUNCTION subscription_payment_final();
--> statement-breakpoint

-- Marking an invoice paid needs a platform administrator, except here: the app has verified a payment with
-- the provider and recorded it as succeeded. This function (owner, for the school whose context is set only)
-- checks that payment covers the invoice exactly, in its currency, and the invoice is still open; then marks
-- it paid with the provider's reference and moves "paid until" to the end of the invoice period if later.
-- Returns true when it marked the invoice paid, false when it was already paid by this payment.
CREATE POLICY subscription_invoices_paid_online ON subscription_invoices FOR UPDATE TO CURRENT_USER
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
CREATE FUNCTION subscription_invoice_paid_online(p_payment uuid) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  p record;
  i record;
  paid_reference text;
BEGIN
  SELECT * INTO p FROM subscription_payments WHERE id = p_payment AND tenant_id = app_current_tenant_id();
  IF NOT FOUND OR p.status <> 'succeeded' THEN
    RAISE EXCEPTION 'no succeeded payment' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO i FROM subscription_invoices WHERE id = p.invoice_id AND tenant_id = p.tenant_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invoice not found' USING ERRCODE = 'P0002';
  END IF;
  paid_reference := 'Online ' || p.reference;
  IF i.paid_on IS NOT NULL THEN
    IF i.payment_reference = paid_reference THEN
      RETURN false;
    END IF;
    RAISE EXCEPTION 'the invoice was already paid' USING ERRCODE = 'check_violation';
  END IF;
  IF i.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'the invoice is void' USING ERRCODE = 'check_violation';
  END IF;
  IF p.amount_pesewas <> i.total_pesewas OR p.currency_code <> i.currency_code THEN
    RAISE EXCEPTION 'the payment does not match the invoice' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE subscription_invoices
    SET paid_on = (p.paid_at AT TIME ZONE (SELECT timezone FROM tenants WHERE id = p.tenant_id))::date,
        payment_reference = paid_reference
    WHERE id = i.id;
  UPDATE tenant_entitlements
    SET paid_until = greatest(coalesce(paid_until, i.period_ends_on), i.period_ends_on), updated_at = now()
    WHERE tenant_id = p.tenant_id;
  RETURN true;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION subscription_invoice_paid_online(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION subscription_invoice_paid_online(uuid) TO edubridge_app;
