-- Callbacks are inserted, then marked processed (or their attempts counted); nothing else changes.
GRANT SELECT, INSERT ON mobile_money_callbacks TO edubridge_app;
--> statement-breakpoint
GRANT UPDATE (attempts, processed_at, result) ON mobile_money_callbacks TO edubridge_app;
--> statement-breakpoint
ALTER TABLE mobile_money_callbacks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE mobile_money_callbacks FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY mobile_money_callbacks_tenant ON mobile_money_callbacks
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
CREATE FUNCTION mobile_money_callbacks_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.processed_at IS NOT NULL THEN
    RAISE EXCEPTION 'a processed callback cannot change' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER mobile_money_callbacks_guard BEFORE UPDATE ON mobile_money_callbacks
  FOR EACH ROW EXECUTE FUNCTION mobile_money_callbacks_guard();
--> statement-breakpoint
CREATE TRIGGER mobile_money_callbacks_no_delete BEFORE DELETE ON mobile_money_callbacks
  FOR EACH ROW EXECUTE FUNCTION financial_record_immutable();
--> statement-breakpoint
CREATE TRIGGER mobile_money_callbacks_no_truncate BEFORE TRUNCATE ON mobile_money_callbacks
  FOR EACH STATEMENT EXECUTE FUNCTION financial_record_immutable();
--> statement-breakpoint
-- The worker looks for open requests that are due a status check.
CREATE INDEX mobile_money_requests_open_idx ON mobile_money_requests (tenant_id, last_checked_at)
  WHERE status IN ('pending', 'expired');
--> statement-breakpoint
-- The review of a held payment is recorded once, by someone, and only for a request held for review.
CREATE OR REPLACE FUNCTION mobile_money_requests_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
  IF OLD.reviewed_at IS NOT NULL
     AND (NEW.reviewed_at, NEW.reviewed_by_user_id, NEW.review_note)
         IS DISTINCT FROM (OLD.reviewed_at, OLD.reviewed_by_user_id, OLD.review_note) THEN
    RAISE EXCEPTION 'a review is recorded once' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.reviewed_at IS NULL AND NEW.reviewed_at IS NOT NULL AND NEW.reviewed_by_user_id IS NULL THEN
    RAISE EXCEPTION 'a review needs a reviewer' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
