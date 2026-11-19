-- Plans priced by school size, automatic invoices each period, the term census and SMS top-ups
-- (founder, 2026-11-18).

ALTER TABLE plan_presets ADD CONSTRAINT plan_presets_price_bands
  CHECK (price_bands IS NULL OR jsonb_typeof(price_bands) = 'array');
--> statement-breakpoint
ALTER TABLE tenant_entitlements ADD CONSTRAINT tenant_entitlements_price_bands
  CHECK (price_bands IS NULL OR jsonb_typeof(price_bands) = 'array');
--> statement-breakpoint
ALTER TABLE tenant_entitlements ADD CONSTRAINT tenant_entitlements_discount
  CHECK (discount_bp IS NULL OR discount_bp BETWEEN 1 AND 10000);
--> statement-breakpoint
ALTER TABLE tenant_entitlements ADD CONSTRAINT tenant_entitlements_discount_label
  CHECK (coalesce(char_length(discount_label), 0) <= 60);
--> statement-breakpoint
ALTER TABLE platform_settings ADD CONSTRAINT platform_settings_invoicing_ranges
  CHECK (census_days BETWEEN 0 AND 60 AND invoice_due_days BETWEEN 1 AND 90
    AND annual_discount_bp BETWEEN 0 AND 5000 AND monthly_surcharge_bp BETWEEN 0 AND 5000);
--> statement-breakpoint

-- The census: the school's own rows (platform administrators read every school's for the revenue view).
-- Counted once: no update or delete for the app.
GRANT SELECT, INSERT ON subscription_census TO edubridge_app;
--> statement-breakpoint
ALTER TABLE subscription_census ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE subscription_census FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY subscription_census_select ON subscription_census FOR SELECT
  USING (tenant_id = app_current_tenant_id() OR app_is_platform_admin());
--> statement-breakpoint
CREATE POLICY subscription_census_insert ON subscription_census FOR INSERT
  WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint

-- SMS top-ups: added by platform administrators for one school; the school reads its own. Marked as invoiced
-- only by subscription_issue_automatic_invoice below.
GRANT SELECT, INSERT ON sms_top_ups TO edubridge_app;
--> statement-breakpoint
ALTER TABLE sms_top_ups ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE sms_top_ups FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY sms_top_ups_select ON sms_top_ups FOR SELECT
  USING (tenant_id = app_current_tenant_id() OR app_is_platform_admin());
--> statement-breakpoint
CREATE POLICY sms_top_ups_insert ON sms_top_ups FOR INSERT
  WITH CHECK (tenant_id = app_current_tenant_id() AND app_is_platform_admin());
--> statement-breakpoint
CREATE POLICY sms_top_ups_invoiced ON sms_top_ups FOR UPDATE TO CURRENT_USER
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint

-- Automatic invoices are inserted only by this function (it runs as the owner, through the policy below):
-- the school in context, never a demo school, lines that add up, and nothing if a live invoice (issued by
-- hand or automatically) already covers any day of the period. Returns no row when nothing was issued.
CREATE POLICY subscription_invoices_automatic ON subscription_invoices FOR INSERT TO CURRENT_USER
  WITH CHECK (tenant_id = app_current_tenant_id() AND automatic);
--> statement-breakpoint
CREATE FUNCTION subscription_issue_automatic_invoice(
  p_period_start date,
  p_period_end date,
  p_due date,
  p_lines jsonb,
  p_students integer,
  p_top_ups uuid[]
) RETURNS TABLE (invoice_id uuid, invoice_number text)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
#variable_conflict use_column
DECLARE
  t record;
  total bigint;
  issued date;
  new_id uuid;
  num text;
BEGIN
  SELECT id, currency_code, timezone, is_demo INTO t FROM tenants WHERE id = app_current_tenant_id();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no school in context' USING ERRCODE = '42501';
  END IF;
  IF t.is_demo THEN
    RETURN;
  END IF;
  IF p_period_end < p_period_start THEN
    RAISE EXCEPTION 'the period ends before it starts' USING ERRCODE = 'check_violation';
  END IF;
  IF jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'an invoice needs lines' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_lines) l
    WHERE (l->>'amountPesewas') IS NULL OR (l->>'quantity') IS NULL OR (l->>'unitPesewas') IS NULL
      OR (l->>'amountPesewas')::numeric <> (l->>'quantity')::numeric * (l->>'unitPesewas')::numeric
      OR coalesce(char_length(l->>'description'), 0) NOT BETWEEN 1 AND 200
  ) THEN
    RAISE EXCEPTION 'a line does not add up' USING ERRCODE = 'check_violation';
  END IF;
  SELECT sum((l->>'amountPesewas')::bigint) INTO total FROM jsonb_array_elements(p_lines) l;
  IF total IS NULL OR total < 1 THEN
    RAISE EXCEPTION 'nothing to invoice' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('automatic-invoice:' || t.id::text, 0));
  IF EXISTS (
    SELECT 1 FROM subscription_invoices
    WHERE tenant_id = t.id AND voided_at IS NULL
      AND period_starts_on <= p_period_end AND period_ends_on >= p_period_start
  ) THEN
    RETURN;
  END IF;
  issued := (now() AT TIME ZONE t.timezone)::date;
  IF p_due < issued THEN
    RAISE EXCEPTION 'the due date is before today' USING ERRCODE = 'check_violation';
  END IF;
  num := 'EB-' || to_char(issued, 'YYYY') || '-' || lpad(nextval('subscription_invoice_seq')::text, 6, '0');
  INSERT INTO subscription_invoices (tenant_id, invoice_number, lines, total_pesewas, currency_code,
    period_starts_on, period_ends_on, issued_on, due_on, automatic, student_count)
  VALUES (t.id, num, p_lines, total, t.currency_code, p_period_start, p_period_end, issued, p_due, true,
    p_students)
  RETURNING id INTO new_id;
  UPDATE sms_top_ups SET invoice_id = new_id
    WHERE tenant_id = t.id AND invoice_id IS NULL AND id = ANY (coalesce(p_top_ups, '{}'::uuid[]));
  RETURN QUERY SELECT new_id, num;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION subscription_issue_automatic_invoice(date, date, date, jsonb, integer, uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION subscription_issue_automatic_invoice(date, date, date, jsonb, integer, uuid[])
  TO edubridge_app;
