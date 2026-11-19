-- AI drafting (R5-5, module ai_drafting): the three drafting tasks get their switches (off), and drafts are kept: never
-- deleted, their outcome decided once.

-- Before the flag table's row-level security matters for this insert: the migration runs as its owner, and only
-- platform staff may add flags through the app.
ALTER TABLE ai_feature_flags DROP CONSTRAINT ai_feature_flags_task;
--> statement-breakpoint
ALTER TABLE ai_feature_flags ADD CONSTRAINT ai_feature_flags_task
  CHECK (task in ('assistant', 'remarks', 'announcements', 'board_report'));
--> statement-breakpoint
ALTER TABLE ai_feature_flags NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
INSERT INTO ai_feature_flags (task, enabled)
  VALUES ('remarks', false), ('announcements', false), ('board_report', false)
  ON CONFLICT DO NOTHING;
--> statement-breakpoint
ALTER TABLE ai_feature_flags FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

GRANT SELECT, INSERT ON ai_drafts TO edubridge_app;
--> statement-breakpoint
GRANT UPDATE (outcome, decided_at) ON ai_drafts TO edubridge_app;
--> statement-breakpoint
ALTER TABLE ai_drafts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE ai_drafts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY ai_drafts_tenant ON ai_drafts
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE ai_drafts ADD CONSTRAINT ai_drafts_values
  CHECK (task in ('remarks', 'announcements', 'board_report')
    AND (outcome is null OR outcome in ('used', 'changed', 'discarded')));
--> statement-breakpoint
CREATE FUNCTION ai_draft_decide_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.outcome IS NOT NULL OR NEW.outcome IS NULL THEN
    RAISE EXCEPTION 'a draft''s outcome is decided once, and drafts are never deleted' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER ai_drafts_decide_once BEFORE UPDATE OR DELETE ON ai_drafts
  FOR EACH ROW EXECUTE FUNCTION ai_draft_decide_once();
--> statement-breakpoint
CREATE TRIGGER ai_drafts_no_truncate BEFORE TRUNCATE ON ai_drafts
  FOR EACH STATEMENT EXECUTE FUNCTION payroll_insert_only();
