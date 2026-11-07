-- Support access (PLT-02): grants by the Proprietor and what support opened during them.

-- A grant is never deleted; the only change is ending it early, once.
GRANT SELECT, INSERT ON support_grants TO edubridge_app;
--> statement-breakpoint
GRANT UPDATE (ended_at, ended_by_user_id) ON support_grants TO edubridge_app;
--> statement-breakpoint
ALTER TABLE support_grants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE support_grants FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY support_grants_tenant ON support_grants
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
CREATE FUNCTION support_grant_end_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'support grant % has already ended', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.ended_at IS NULL OR NEW.ended_by_user_id IS NULL THEN
    RAISE EXCEPTION 'ending a support grant records when and by whom' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER support_grants_end_once BEFORE UPDATE ON support_grants
  FOR EACH ROW EXECUTE FUNCTION support_grant_end_once();
--> statement-breakpoint
CREATE TRIGGER support_grants_no_delete BEFORE DELETE ON support_grants
  FOR EACH ROW EXECUTE FUNCTION history_record_immutable();
--> statement-breakpoint
CREATE TRIGGER support_grants_no_truncate BEFORE TRUNCATE ON support_grants
  FOR EACH STATEMENT EXECUTE FUNCTION history_record_immutable();
--> statement-breakpoint

GRANT SELECT, INSERT ON support_views TO edubridge_app;
--> statement-breakpoint
ALTER TABLE support_views ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE support_views FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY support_views_tenant ON support_views
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
CREATE TRIGGER support_views_no_update_delete BEFORE UPDATE OR DELETE ON support_views
  FOR EACH ROW EXECUTE FUNCTION history_record_immutable();
--> statement-breakpoint
CREATE TRIGGER support_views_no_truncate BEFORE TRUNCATE ON support_views
  FOR EACH STATEMENT EXECUTE FUNCTION history_record_immutable();
