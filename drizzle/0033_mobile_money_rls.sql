-- Requests are updated once with their outcome and never deleted.
GRANT SELECT, INSERT, UPDATE ON mobile_money_requests TO edubridge_app;
--> statement-breakpoint
ALTER TABLE mobile_money_requests ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE mobile_money_requests FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY mobile_money_requests_tenant ON mobile_money_requests
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
-- At most one prompt waiting for each student, so a family is not sent several at once.
CREATE UNIQUE INDEX mobile_money_requests_one_pending ON mobile_money_requests (student_id) WHERE status = 'pending';
--> statement-breakpoint
-- What was asked for (student, phone, amount, provider) never changes. The provider reference is set
-- once. The outcome is set once: only pending and expired requests can still change status, and an
-- expired request never goes back to pending.
CREATE FUNCTION mobile_money_requests_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'mobile_money_requests rows are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.student_id, NEW.provider, NEW.network, NEW.msisdn, NEW.amount_pesewas,
      NEW.currency, NEW.idempotency_key, NEW.requested_by_user_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.student_id, OLD.provider, OLD.network, OLD.msisdn, OLD.amount_pesewas,
      OLD.currency, OLD.idempotency_key, OLD.requested_by_user_id, OLD.created_at) THEN
    RAISE EXCEPTION 'a Mobile Money request''s details cannot change' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.provider_reference IS NOT NULL AND NEW.provider_reference IS DISTINCT FROM OLD.provider_reference THEN
    RAISE EXCEPTION 'a provider reference is set once' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status NOT IN ('pending', 'expired')
     AND (NEW.status, NEW.payment_id, NEW.transaction_id, NEW.status_reason, NEW.completed_at)
         IS DISTINCT FROM (OLD.status, OLD.payment_id, OLD.transaction_id, OLD.status_reason, OLD.completed_at) THEN
    RAISE EXCEPTION 'a completed Mobile Money request cannot change' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'expired' AND NEW.status = 'pending' THEN
    RAISE EXCEPTION 'an expired Mobile Money request cannot be pending again' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER mobile_money_requests_guard BEFORE UPDATE OR DELETE ON mobile_money_requests
  FOR EACH ROW EXECUTE FUNCTION mobile_money_requests_guard();
--> statement-breakpoint
CREATE TRIGGER mobile_money_requests_no_truncate BEFORE TRUNCATE ON mobile_money_requests
  FOR EACH STATEMENT EXECUTE FUNCTION financial_record_immutable();
--> statement-breakpoint
-- A confirmed request's payment must be a Mobile Money payment for the same student and amount.
CREATE FUNCTION mobile_money_requests_check_payment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  paid payments%ROWTYPE;
BEGIN
  IF NEW.payment_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO paid FROM payments WHERE id = NEW.payment_id AND tenant_id = NEW.tenant_id;
  IF NOT FOUND OR paid.student_id <> NEW.student_id OR paid.amount_pesewas <> NEW.amount_pesewas
     OR paid.method <> 'mobile_money' THEN
    RAISE EXCEPTION 'a Mobile Money request must match its payment' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER mobile_money_requests_payment_matches BEFORE INSERT OR UPDATE ON mobile_money_requests
  FOR EACH ROW EXECUTE FUNCTION mobile_money_requests_check_payment();
