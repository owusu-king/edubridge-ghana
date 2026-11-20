-- School money beyond fees: accounts, deposits, bank statements and expenses. Tenant isolation as everywhere; deposits
-- and expenses are never deleted, and only their outcome (cancellation, decision, void) changes, once.
GRANT SELECT, INSERT ON finance_accounts, bank_deposits, bank_deposit_items, expenses, bank_statement_imports,
  bank_statement_lines TO edubridge_app;
--> statement-breakpoint
GRANT UPDATE (name, institution, account_ending, status, updated_at) ON finance_accounts TO edubridge_app;
--> statement-breakpoint
GRANT UPDATE (cancelled_at, cancelled_by_user_id, cancel_reason) ON bank_deposits TO edubridge_app;
--> statement-breakpoint
GRANT UPDATE (released) ON bank_deposit_items TO edubridge_app;
--> statement-breakpoint
GRANT UPDATE (lines_added, lines_skipped) ON bank_statement_imports TO edubridge_app;
--> statement-breakpoint
GRANT UPDATE (status, decided_by_user_id, decided_at, decision_note, voided_by_user_id, voided_at, void_reason)
  ON expenses TO edubridge_app;
--> statement-breakpoint
GRANT UPDATE (matched_kind, matched_id, match_note, matched_by_user_id, matched_at) ON bank_statement_lines
  TO edubridge_app;
--> statement-breakpoint
ALTER TABLE finance_accounts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE finance_accounts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY finance_accounts_tenant ON finance_accounts
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE bank_deposits ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE bank_deposits FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY bank_deposits_tenant ON bank_deposits
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE bank_deposit_items ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE bank_deposit_items FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY bank_deposit_items_tenant ON bank_deposit_items
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE expenses FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY expenses_tenant ON expenses
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE bank_statement_imports ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE bank_statement_imports FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY bank_statement_imports_tenant ON bank_statement_imports
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE bank_statement_lines ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE bank_statement_lines FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY bank_statement_lines_tenant ON bank_statement_lines
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
-- Closed periods (Fees, Closing) also refuse deposits and expenses dated inside them.
CREATE OR REPLACE FUNCTION enforce_period_lock() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  d date;
  locked date;
BEGIN
  IF TG_TABLE_NAME = 'payments' THEN
    d := NEW.paid_on;
  ELSIF TG_TABLE_NAME = 'expenses' THEN
    d := NEW.spent_on;
  ELSIF TG_TABLE_NAME = 'bank_deposits' THEN
    d := NEW.deposited_on;
  ELSE
    d := NEW.effective_on;
  END IF;
  locked := app_locked_through(NEW.tenant_id);
  IF locked IS NOT NULL AND d <= locked THEN
    RAISE EXCEPTION 'period_locked:%', locked USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER expenses_period_lock BEFORE INSERT ON expenses
  FOR EACH ROW EXECUTE FUNCTION enforce_period_lock();
--> statement-breakpoint
CREATE TRIGGER bank_deposits_period_lock BEFORE INSERT ON bank_deposits
  FOR EACH ROW EXECUTE FUNCTION enforce_period_lock();
--> statement-breakpoint
-- A deposit's details never change; it is cancelled at most once.
CREATE FUNCTION bank_deposits_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'deposits are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION 'a cancelled deposit cannot change' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER bank_deposits_guard BEFORE UPDATE OR DELETE ON bank_deposits
  FOR EACH ROW EXECUTE FUNCTION bank_deposits_guard();
--> statement-breakpoint
CREATE TRIGGER bank_deposits_no_truncate BEFORE TRUNCATE ON bank_deposits
  FOR EACH STATEMENT EXECUTE FUNCTION financial_record_immutable();
--> statement-breakpoint
-- Only cash and cheque receipts that stand (not voided) go into a deposit, for their full amount. An item is released
-- only when its deposit is cancelled, and never comes back.
CREATE FUNCTION bank_deposit_items_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  paid payments%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'deposit items are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.released OR NOT NEW.released
       OR (NEW.id, NEW.tenant_id, NEW.deposit_id, NEW.payment_id, NEW.amount_pesewas)
          IS DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.deposit_id, OLD.payment_id, OLD.amount_pesewas) THEN
      RAISE EXCEPTION 'a deposit item is only released, once' USING ERRCODE = 'restrict_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM bank_deposits WHERE id = NEW.deposit_id AND cancelled_at IS NOT NULL) THEN
      RAISE EXCEPTION 'only a cancelled deposit releases its receipts' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO paid FROM payments WHERE id = NEW.payment_id AND tenant_id = NEW.tenant_id;
  IF NOT FOUND OR paid.method NOT IN ('cash', 'cheque') OR paid.amount_pesewas <> NEW.amount_pesewas
     OR EXISTS (SELECT 1 FROM payment_voids v WHERE v.payment_id = NEW.payment_id) THEN
    RAISE EXCEPTION 'only standing cash and cheque receipts are deposited' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER bank_deposit_items_guard BEFORE INSERT OR UPDATE OR DELETE ON bank_deposit_items
  FOR EACH ROW EXECUTE FUNCTION bank_deposit_items_guard();
--> statement-breakpoint
-- An expense's details never change. pending -> approved | rejected; approved -> voided. Nothing after that.
CREATE FUNCTION expenses_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'expenses are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.expense_number, NEW.spent_on, NEW.category, NEW.payee, NEW.description,
      NEW.amount_pesewas, NEW.account_id, NEW.method, NEW.reference, NEW.recorded_by_user_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.expense_number, OLD.spent_on, OLD.category, OLD.payee, OLD.description,
      OLD.amount_pesewas, OLD.account_id, OLD.method, OLD.reference, OLD.recorded_by_user_id, OLD.created_at) THEN
    RAISE EXCEPTION 'an expense''s details cannot change' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NOT ((OLD.status = 'pending' AND NEW.status IN ('approved', 'rejected'))
          OR (OLD.status = 'approved' AND NEW.status = 'voided')) THEN
    RAISE EXCEPTION 'an expense cannot go from % to %', OLD.status, NEW.status USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'approved' AND (NEW.decided_by_user_id, NEW.decided_at, NEW.decision_note)
     IS DISTINCT FROM (OLD.decided_by_user_id, OLD.decided_at, OLD.decision_note) THEN
    RAISE EXCEPTION 'an expense''s approval cannot change' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER expenses_guard BEFORE UPDATE OR DELETE ON expenses
  FOR EACH ROW EXECUTE FUNCTION expenses_guard();
--> statement-breakpoint
CREATE TRIGGER expenses_no_truncate BEFORE TRUNCATE ON expenses
  FOR EACH STATEMENT EXECUTE FUNCTION financial_record_immutable();
--> statement-breakpoint
-- A statement line's own content never changes; only its match (which can be undone and redone, with an audit entry).
CREATE FUNCTION bank_statement_lines_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'statement lines are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.import_id, NEW.account_id, NEW.line_on, NEW.description, NEW.reference,
      NEW.amount_pesewas, NEW.line_key)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.import_id, OLD.account_id, OLD.line_on, OLD.description, OLD.reference,
      OLD.amount_pesewas, OLD.line_key) THEN
    RAISE EXCEPTION 'a statement line cannot change' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER bank_statement_lines_guard BEFORE UPDATE OR DELETE ON bank_statement_lines
  FOR EACH ROW EXECUTE FUNCTION bank_statement_lines_guard();
