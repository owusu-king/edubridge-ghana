-- Family payments: one Mobile Money prompt for several children. Shares are written with their request and never
-- deleted; only the payment is set, once, when the provider confirms the total.
GRANT SELECT, INSERT, UPDATE (payment_id) ON mobile_money_request_shares TO edubridge_app;
--> statement-breakpoint
ALTER TABLE mobile_money_request_shares ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE mobile_money_request_shares FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY mobile_money_request_shares_tenant ON mobile_money_request_shares
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
CREATE FUNCTION mobile_money_request_shares_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  paid payments%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Mobile Money shares are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.id, NEW.tenant_id, NEW.request_id, NEW.student_id, NEW.amount_pesewas, NEW.created_at)
       IS DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.request_id, OLD.student_id, OLD.amount_pesewas, OLD.created_at) THEN
      RAISE EXCEPTION 'a Mobile Money share''s details cannot change' USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.payment_id IS NOT NULL AND NEW.payment_id IS DISTINCT FROM OLD.payment_id THEN
      RAISE EXCEPTION 'a Mobile Money share is paid once' USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  IF NEW.payment_id IS NOT NULL THEN
    SELECT * INTO paid FROM payments WHERE id = NEW.payment_id AND tenant_id = NEW.tenant_id;
    IF NOT FOUND OR paid.student_id <> NEW.student_id OR paid.amount_pesewas <> NEW.amount_pesewas
       OR paid.method <> 'mobile_money' THEN
      RAISE EXCEPTION 'a Mobile Money share must match its payment' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER mobile_money_request_shares_guard BEFORE INSERT OR UPDATE OR DELETE ON mobile_money_request_shares
  FOR EACH ROW EXECUTE FUNCTION mobile_money_request_shares_guard();
--> statement-breakpoint
CREATE TRIGGER mobile_money_request_shares_no_truncate BEFORE TRUNCATE ON mobile_money_request_shares
  FOR EACH STATEMENT EXECUTE FUNCTION financial_record_immutable();
--> statement-breakpoint
-- A confirmed request's payment matches the request. For a family request it is the first child's payment, for that
-- child's share; the shares must add up to exactly the amount the payer approved.
CREATE OR REPLACE FUNCTION mobile_money_requests_check_payment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  paid payments%ROWTYPE;
  share_amount bigint;
  shares_total bigint;
BEGIN
  IF NEW.payment_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO paid FROM payments WHERE id = NEW.payment_id AND tenant_id = NEW.tenant_id;
  IF NOT FOUND OR paid.student_id <> NEW.student_id OR paid.method <> 'mobile_money' THEN
    RAISE EXCEPTION 'a Mobile Money request must match its payment' USING ERRCODE = 'check_violation';
  END IF;
  SELECT sum(amount_pesewas) INTO shares_total FROM mobile_money_request_shares
    WHERE request_id = NEW.id AND tenant_id = NEW.tenant_id;
  IF shares_total IS NULL THEN
    IF paid.amount_pesewas <> NEW.amount_pesewas THEN
      RAISE EXCEPTION 'a Mobile Money request must match its payment' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    SELECT amount_pesewas INTO share_amount FROM mobile_money_request_shares
      WHERE request_id = NEW.id AND tenant_id = NEW.tenant_id AND student_id = NEW.student_id;
    IF share_amount IS NULL OR paid.amount_pesewas <> share_amount OR shares_total <> NEW.amount_pesewas THEN
      RAISE EXCEPTION 'a family Mobile Money request must match its shares' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
