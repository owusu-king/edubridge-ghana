-- Finance controls: closed periods, refunds, optional fee items (R1 completion).

GRANT SELECT, INSERT ON finance_period_locks TO edubridge_app;
--> statement-breakpoint
ALTER TABLE finance_period_locks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE finance_period_locks FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY finance_period_locks_tenant ON finance_period_locks
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
CREATE TRIGGER finance_period_locks_no_update_delete BEFORE UPDATE OR DELETE ON finance_period_locks
  FOR EACH ROW EXECUTE FUNCTION history_record_immutable();
--> statement-breakpoint
CREATE TRIGGER finance_period_locks_no_truncate BEFORE TRUNCATE ON finance_period_locks
  FOR EACH STATEMENT EXECUTE FUNCTION history_record_immutable();
--> statement-breakpoint
-- The school's books are closed up to this date (the latest setting), or null.
CREATE FUNCTION app_locked_through(t uuid) RETURNS date
LANGUAGE sql STABLE AS $$
  SELECT locked_through FROM finance_period_locks WHERE tenant_id = t ORDER BY set_at DESC, id DESC LIMIT 1
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_locked_through(uuid) TO edubridge_app;
--> statement-breakpoint
-- No ledger entry or payment may be dated in a closed period, whichever code path writes it.
CREATE FUNCTION enforce_period_lock() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  d date;
  locked date;
BEGIN
  IF TG_TABLE_NAME = 'payments' THEN
    d := NEW.paid_on;
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
CREATE TRIGGER ledger_entries_period_lock BEFORE INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION enforce_period_lock();
--> statement-breakpoint
CREATE TRIGGER payments_period_lock BEFORE INSERT ON payments
  FOR EACH ROW EXECUTE FUNCTION enforce_period_lock();
--> statement-breakpoint

GRANT SELECT, INSERT ON refunds TO edubridge_app;
--> statement-breakpoint
GRANT UPDATE (status, decided_by_user_id, decided_at, decision_note, paid_by_user_id, paid_on, method, reference,
  ledger_entry_id, refund_number) ON refunds TO edubridge_app;
--> statement-breakpoint
ALTER TABLE refunds ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE refunds FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY refunds_tenant ON refunds
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
-- requested -> approved | rejected | cancelled; approved -> paid | cancelled. Paid refunds never change.
CREATE FUNCTION refund_moves_forward() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT (
    (OLD.status = 'requested' AND NEW.status IN ('approved', 'rejected', 'cancelled')) OR
    (OLD.status = 'approved' AND NEW.status IN ('paid', 'cancelled'))
  ) THEN
    RAISE EXCEPTION 'refund % cannot go from % to %', OLD.id, OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.amount_pesewas <> OLD.amount_pesewas OR NEW.student_id <> OLD.student_id THEN
    RAISE EXCEPTION 'a refund amount cannot change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER refunds_move_forward BEFORE UPDATE ON refunds
  FOR EACH ROW EXECUTE FUNCTION refund_moves_forward();
--> statement-breakpoint
CREATE TRIGGER refunds_no_delete BEFORE DELETE ON refunds
  FOR EACH ROW EXECUTE FUNCTION history_record_immutable();
--> statement-breakpoint

GRANT SELECT, INSERT, DELETE ON student_fee_options TO edubridge_app;
--> statement-breakpoint
ALTER TABLE student_fee_options ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE student_fee_options FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY student_fee_options_tenant ON student_fee_options
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
-- Existing fee items get a category from their name where it is clear (schools can change it).
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', t.id::text, true);
    UPDATE fee_items SET category = CASE
      WHEN name ~* 'tuition|school fees' THEN 'tuition'
      WHEN name ~* 'admission|registration' THEN 'admission'
      WHEN name ~* 'exam|test' THEN 'examination'
      WHEN name ~* 'transport|bus' THEN 'transport'
      WHEN name ~* 'boarding|hostel' THEN 'boarding'
      WHEN name ~* 'feeding|lunch|meal|canteen' THEN 'feeding'
      WHEN name ~* 'uniform' THEN 'uniform'
      WHEN name ~* 'book|stationery' THEN 'books'
      WHEN name ~* 'pta|levy|dues' THEN 'levy'
      ELSE 'other' END
    WHERE tenant_id = t.id;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END;
$$;
