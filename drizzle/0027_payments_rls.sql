-- Payments and voids are insert-only, like the ledger.
GRANT SELECT, INSERT ON payments, payment_voids TO edubridge_app;
--> statement-breakpoint
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE payments FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY payments_tenant ON payments
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE payment_voids ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE payment_voids FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY payment_voids_tenant ON payment_voids
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
CREATE FUNCTION financial_record_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; void or reverse instead', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER payments_no_update_delete BEFORE UPDATE OR DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION financial_record_immutable();
--> statement-breakpoint
CREATE TRIGGER payments_no_truncate BEFORE TRUNCATE ON payments
  FOR EACH STATEMENT EXECUTE FUNCTION financial_record_immutable();
--> statement-breakpoint
CREATE TRIGGER payment_voids_no_update_delete BEFORE UPDATE OR DELETE ON payment_voids
  FOR EACH ROW EXECUTE FUNCTION financial_record_immutable();
--> statement-breakpoint
CREATE TRIGGER payment_voids_no_truncate BEFORE TRUNCATE ON payment_voids
  FOR EACH STATEMENT EXECUTE FUNCTION financial_record_immutable();
--> statement-breakpoint
-- Exactly one ledger entry records each payment.
CREATE UNIQUE INDEX ledger_entries_one_per_payment ON ledger_entries (payment_id) WHERE kind = 'payment';
--> statement-breakpoint
-- A payment's ledger entry must be for the same student and exactly the negative of the amount.
CREATE FUNCTION ledger_entries_check_payment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  paid payments%ROWTYPE;
BEGIN
  IF NEW.kind <> 'payment' THEN
    RETURN NEW;
  END IF;
  SELECT * INTO paid FROM payments WHERE id = NEW.payment_id AND tenant_id = NEW.tenant_id;
  IF NOT FOUND OR paid.student_id <> NEW.student_id OR NEW.amount_pesewas <> -paid.amount_pesewas THEN
    RAISE EXCEPTION 'a payment entry must match its payment' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ledger_entries_payment_matches BEFORE INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_entries_check_payment();
