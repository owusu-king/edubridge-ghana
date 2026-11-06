-- Assessment and report cards (Phase G): grants, tenant isolation and the rules that keep published
-- report cards honest.

GRANT SELECT, INSERT, UPDATE ON subjects, assessment_schemes, report_cards TO edubridge_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON level_subjects, grading_scales, assessment_scores, report_card_batches TO edubridge_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON report_card_files TO edubridge_app;
--> statement-breakpoint

ALTER TABLE subjects ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE subjects FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY subjects_tenant ON subjects
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE level_subjects ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE level_subjects FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY level_subjects_tenant ON level_subjects
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE assessment_schemes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE assessment_schemes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY assessment_schemes_tenant ON assessment_schemes
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE grading_scales ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE grading_scales FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY grading_scales_tenant ON grading_scales
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE assessment_scores ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE assessment_scores FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY assessment_scores_tenant ON assessment_scores
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE report_cards ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE report_cards FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY report_cards_tenant ON report_cards
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE report_card_batches ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE report_card_batches FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY report_card_batches_tenant ON report_card_batches
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE report_card_files ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE report_card_files FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY report_card_files_tenant ON report_card_files
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint

-- A published report card is never edited: it can only go back to draft (withdrawn, audited by the app),
-- which the published_complete check forces to clear the snapshot.
CREATE FUNCTION report_card_published_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'published' AND NEW.status <> 'draft' THEN
    RAISE EXCEPTION 'a published report card cannot be changed; withdraw it first'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.term_id <> OLD.term_id OR NEW.student_id <> OLD.student_id THEN
    RAISE EXCEPTION 'a report card cannot move to another term or student' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER report_cards_published_guard BEFORE UPDATE ON report_cards
  FOR EACH ROW EXECUTE FUNCTION report_card_published_guard();
--> statement-breakpoint

-- Marks behind a published report card are locked: no insert, change or removal until it is withdrawn.
CREATE FUNCTION assessment_score_locked() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  r assessment_scores;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  IF EXISTS (
    SELECT 1 FROM report_cards rc
    WHERE rc.tenant_id = r.tenant_id AND rc.term_id = r.term_id AND rc.student_id = r.student_id
      AND rc.status = 'published'
  ) OR (TG_OP = 'UPDATE' AND EXISTS (
    SELECT 1 FROM report_cards rc
    WHERE rc.tenant_id = OLD.tenant_id AND rc.term_id = OLD.term_id AND rc.student_id = OLD.student_id
      AND rc.status = 'published'
  )) THEN
    RAISE EXCEPTION 'scores on a published report card are locked' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER assessment_scores_locked BEFORE INSERT OR UPDATE OR DELETE ON assessment_scores
  FOR EACH ROW EXECUTE FUNCTION assessment_score_locked();
