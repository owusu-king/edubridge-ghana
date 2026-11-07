-- Transfer Passport: portable learner identity, signed records, transfers between schools, prior records.

-- Learners hold no personal details (just an id), so they are not tenant-scoped.
GRANT SELECT, INSERT ON learners TO edubridge_app;
--> statement-breakpoint
CREATE FUNCTION assign_learner() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.learner_id IS NULL THEN
    INSERT INTO learners DEFAULT VALUES RETURNING id INTO NEW.learner_id;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER students_assign_learner BEFORE INSERT ON students
  FOR EACH ROW EXECUTE FUNCTION assign_learner();
--> statement-breakpoint
-- Existing students get a learner each, school by school (row-level security applies to the owner too).
DO $$
DECLARE
  t record;
  s record;
  lid uuid;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', t.id::text, true);
    FOR s IN SELECT id FROM students WHERE tenant_id = t.id AND learner_id IS NULL LOOP
      INSERT INTO learners DEFAULT VALUES RETURNING id INTO lid;
      UPDATE students SET learner_id = lid WHERE id = s.id;
    END LOOP;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END;
$$;
--> statement-breakpoint

GRANT SELECT, INSERT ON learner_records TO edubridge_app;
--> statement-breakpoint
GRANT UPDATE (revoked_at, revoked_reason) ON learner_records TO edubridge_app;
--> statement-breakpoint
ALTER TABLE learner_records ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE learner_records FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY learner_records_tenant ON learner_records
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
CREATE FUNCTION learner_record_revoke_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL OR coalesce(NEW.revoked_reason, '') = '' THEN
    RAISE EXCEPTION 'a learner record can only be revoked, once, with a reason' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER learner_records_revoke_once BEFORE UPDATE ON learner_records
  FOR EACH ROW EXECUTE FUNCTION learner_record_revoke_once();
--> statement-breakpoint
CREATE TRIGGER learner_records_no_delete BEFORE DELETE ON learner_records
  FOR EACH ROW EXECUTE FUNCTION history_record_immutable();
--> statement-breakpoint
CREATE TRIGGER learner_records_no_truncate BEFORE TRUNCATE ON learner_records
  FOR EACH STATEMENT EXECUTE FUNCTION history_record_immutable();
--> statement-breakpoint

-- Transfers are visible to both schools; the service narrows what each sees.
GRANT SELECT, INSERT ON transfers TO edubridge_app;
--> statement-breakpoint
GRANT UPDATE (status, from_student_id, consent_phone, consented_at, decided_by_user_id, decided_at,
  decline_reason, record_id, package, accepted_by_user_id, accepted_at, to_student_id) ON transfers TO edubridge_app;
--> statement-breakpoint
ALTER TABLE transfers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE transfers FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY transfers_either_school ON transfers
  USING (from_tenant_id = app_current_tenant_id() OR to_tenant_id = app_current_tenant_id())
  WITH CHECK (from_tenant_id = app_current_tenant_id() OR to_tenant_id = app_current_tenant_id());
--> statement-breakpoint
-- Only forward moves; a signed package, once attached, never changes.
CREATE FUNCTION transfer_moves_forward() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'awaiting_consent' AND NEW.status IN ('awaiting_origin', 'declined', 'cancelled')) OR
    (OLD.status = 'awaiting_origin' AND NEW.status IN ('approved', 'declined', 'cancelled')) OR
    (OLD.status = 'approved' AND NEW.status IN ('completed', 'cancelled'))
  ) THEN
    RAISE EXCEPTION 'transfer % cannot go from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.package IS NOT NULL AND NEW.package IS DISTINCT FROM OLD.package THEN
    RAISE EXCEPTION 'the signed package of transfer % cannot change', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER transfers_move_forward BEFORE UPDATE ON transfers
  FOR EACH ROW EXECUTE FUNCTION transfer_moves_forward();
--> statement-breakpoint
CREATE TRIGGER transfers_no_delete BEFORE DELETE ON transfers
  FOR EACH ROW EXECUTE FUNCTION history_record_immutable();
--> statement-breakpoint

GRANT SELECT, INSERT ON prior_records TO edubridge_app;
--> statement-breakpoint
ALTER TABLE prior_records ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE prior_records FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY prior_records_tenant ON prior_records
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
CREATE TRIGGER prior_records_no_update_delete BEFORE UPDATE OR DELETE ON prior_records
  FOR EACH ROW EXECUTE FUNCTION history_record_immutable();
--> statement-breakpoint
CREATE TRIGGER prior_records_no_truncate BEFORE TRUNCATE ON prior_records
  FOR EACH STATEMENT EXECUTE FUNCTION history_record_immutable();
