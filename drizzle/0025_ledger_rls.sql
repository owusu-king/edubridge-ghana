-- The ledger is append-only: the application role may only read and insert.
GRANT SELECT, INSERT ON ledger_entries TO edubridge_app;
--> statement-breakpoint
ALTER TABLE ledger_entries ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE ledger_entries FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY ledger_entries_tenant ON ledger_entries
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
-- Even roles that could update or delete (owners, migrations) are refused: corrections are reversals.
CREATE FUNCTION ledger_entries_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger entries are append-only; record a reversal instead'
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ledger_entries_no_update_delete
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_entries_immutable();
--> statement-breakpoint
CREATE TRIGGER ledger_entries_no_truncate
  BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_entries_immutable();
--> statement-breakpoint
-- A reversal must belong to the same student and exactly negate an entry that is not itself a reversal.
CREATE FUNCTION ledger_entries_check_reversal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  original ledger_entries%ROWTYPE;
BEGIN
  IF NEW.reverses_entry_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO original FROM ledger_entries
    WHERE id = NEW.reverses_entry_id AND tenant_id = NEW.tenant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reversed entry not found' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF original.kind = 'reversal' OR original.student_id <> NEW.student_id
     OR NEW.amount_pesewas <> -original.amount_pesewas THEN
    RAISE EXCEPTION 'a reversal must exactly negate an entry for the same student'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ledger_entries_reversal_matches
  BEFORE INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_entries_check_reversal();
