-- Admissions (R3-4): grants, tenant isolation and the rules that keep an application's history honest.

-- Applications are updated as they move through the pipeline; never deleted (erased instead, D-R3-2).
GRANT SELECT, INSERT, UPDATE ON applications TO edubridge_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON application_events TO edubridge_app;
--> statement-breakpoint
-- Online application checks: created by the public form, used once, purged by the worker after a day.
GRANT SELECT, INSERT, DELETE ON application_verifications TO edubridge_app;
--> statement-breakpoint
GRANT UPDATE (attempts, consumed_at, draft) ON application_verifications TO edubridge_app;
--> statement-breakpoint

ALTER TABLE applications ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE applications FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY applications_tenant ON applications
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE application_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE application_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY application_events_tenant ON application_events
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE application_verifications ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE application_verifications FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY application_verifications_tenant ON application_verifications
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint

ALTER TABLE applications ADD CONSTRAINT applications_status
  CHECK (status in ('inquiry', 'applied', 'assessment', 'offered', 'enrolled', 'declined', 'withdrawn'));
--> statement-breakpoint
ALTER TABLE applications ADD CONSTRAINT applications_source
  CHECK (source in ('walk_in', 'phone', 'referral', 'event', 'online', 'other'));
--> statement-breakpoint
ALTER TABLE applications ADD CONSTRAINT applications_relationship
  CHECK (guardian_relationship is null
    or guardian_relationship in ('mother', 'father', 'guardian', 'grandparent', 'sibling', 'other'));
--> statement-breakpoint
ALTER TABLE applications ADD CONSTRAINT applications_offer_fees
  CHECK (offer_fees is null or jsonb_typeof(offer_fees) = 'array');
--> statement-breakpoint
ALTER TABLE school_preferences ADD CONSTRAINT school_preferences_admission_fees
  CHECK (jsonb_typeof(admission_fees) = 'array' and jsonb_array_length(admission_fees) <= 8);
--> statement-breakpoint

-- A closed application (enrolled, declined, withdrawn) never reopens or changes; only the erasure of its
-- personal details after the retention period (D-R3-2) is allowed, once.
CREATE FUNCTION application_closed_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('enrolled', 'declined', 'withdrawn') THEN
    IF NEW.status <> OLD.status OR NEW.student_id IS DISTINCT FROM OLD.student_id
      OR NEW.closed_at IS DISTINCT FROM OLD.closed_at OR NEW.offer_fees IS DISTINCT FROM OLD.offer_fees THEN
      RAISE EXCEPTION 'a closed application cannot change' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.erased_at IS NOT NULL THEN
      RAISE EXCEPTION 'an erased application cannot change' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.erased_at IS NULL AND (
      NEW.child_first_name IS DISTINCT FROM OLD.child_first_name OR NEW.child_last_name IS DISTINCT FROM OLD.child_last_name
      OR NEW.guardian_name IS DISTINCT FROM OLD.guardian_name OR NEW.guardian_phone IS DISTINCT FROM OLD.guardian_phone
    ) THEN
      RAISE EXCEPTION 'a closed application cannot change' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER applications_closed_guard BEFORE UPDATE ON applications
  FOR EACH ROW EXECUTE FUNCTION application_closed_guard();
--> statement-breakpoint
CREATE TRIGGER application_events_no_update_delete BEFORE UPDATE OR DELETE ON application_events
  FOR EACH ROW EXECUTE FUNCTION history_record_immutable();
--> statement-breakpoint
CREATE TRIGGER application_events_no_truncate BEFORE TRUNCATE ON application_events
  FOR EACH STATEMENT EXECUTE FUNCTION history_record_immutable();
