-- Events and consent forms (R3-3): grants, tenant isolation and the rules that keep consent honest.

-- Events are edited while they are coming and cancelled rather than deleted.
GRANT SELECT, INSERT, UPDATE ON school_events TO edubridge_app;
--> statement-breakpoint
-- A consent form's wording, audience and event never change once families can answer it: only the
-- deadline, the notice counts and cancellation.
GRANT SELECT, INSERT ON consent_forms TO edubridge_app;
--> statement-breakpoint
GRANT UPDATE (deadline, sms_count, push_count, last_reminded_at, cancelled_at, cancelled_by_user_id, updated_at)
  ON consent_forms TO edubridge_app;
--> statement-breakpoint
-- Answers are kept as given: a changed answer is a new row, and the latest counts.
GRANT SELECT, INSERT ON consent_answers TO edubridge_app;
--> statement-breakpoint

ALTER TABLE school_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE school_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY school_events_tenant ON school_events
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE consent_forms ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE consent_forms FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY consent_forms_tenant ON consent_forms
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE consent_answers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE consent_answers FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY consent_answers_tenant ON consent_answers
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint

ALTER TABLE school_events ADD CONSTRAINT school_events_audience
  CHECK (audience in ('school', 'level', 'class', 'campus'));
--> statement-breakpoint
ALTER TABLE school_events ADD CONSTRAINT school_events_reminder CHECK (reminder in ('none', 'push', 'sms'));
--> statement-breakpoint
ALTER TABLE school_events ADD CONSTRAINT school_events_cancelled
  CHECK ((cancelled_at is null) = (cancelled_by_user_id is null));
--> statement-breakpoint
ALTER TABLE consent_forms ADD CONSTRAINT consent_forms_audience
  CHECK (audience in ('school', 'level', 'class', 'campus'));
--> statement-breakpoint
ALTER TABLE consent_forms ADD CONSTRAINT consent_forms_cancelled
  CHECK ((cancelled_at is null) = (cancelled_by_user_id is null));
--> statement-breakpoint
ALTER TABLE consent_answers ADD CONSTRAINT consent_answers_answer CHECK (answer in ('yes', 'no'));
--> statement-breakpoint

-- A cancelled event or form never changes again.
CREATE FUNCTION cancelled_record_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION 'a cancelled record cannot change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER school_events_cancelled_guard BEFORE UPDATE ON school_events
  FOR EACH ROW EXECUTE FUNCTION cancelled_record_guard();
--> statement-breakpoint
CREATE TRIGGER consent_forms_cancelled_guard BEFORE UPDATE ON consent_forms
  FOR EACH ROW EXECUTE FUNCTION cancelled_record_guard();
--> statement-breakpoint
CREATE TRIGGER school_events_no_delete BEFORE DELETE ON school_events
  FOR EACH ROW EXECUTE FUNCTION history_record_immutable();
--> statement-breakpoint
CREATE TRIGGER consent_forms_no_delete BEFORE DELETE ON consent_forms
  FOR EACH ROW EXECUTE FUNCTION history_record_immutable();
--> statement-breakpoint

-- No answer is taken for a cancelled form, whoever records it.
CREATE FUNCTION consent_answer_form_open() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM consent_forms f
             WHERE f.tenant_id = NEW.tenant_id AND f.id = NEW.form_id AND f.cancelled_at IS NOT NULL) THEN
    RAISE EXCEPTION 'the consent form was cancelled' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER consent_answers_form_open BEFORE INSERT ON consent_answers
  FOR EACH ROW EXECUTE FUNCTION consent_answer_form_open();
--> statement-breakpoint
CREATE TRIGGER consent_answers_no_update_delete BEFORE UPDATE OR DELETE ON consent_answers
  FOR EACH ROW EXECUTE FUNCTION history_record_immutable();
--> statement-breakpoint
CREATE TRIGGER consent_answers_no_truncate BEFORE TRUNCATE ON consent_answers
  FOR EACH STATEMENT EXECUTE FUNCTION history_record_immutable();
