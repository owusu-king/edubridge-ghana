-- Safeguarding (R4-3, module safeguarding): cases, their entries, access records and documents are readable only
-- by the school's designated safeguarding leads, enforced here (SFG-01b) and not only by the app. A reporter can
-- read back only their own report. Contexts without a user (background jobs, insights, the assistant) see none.

-- Whether the signed-in user is an active lead at the school whose context is set.
CREATE FUNCTION app_is_safeguarding_lead() RETURNS boolean
  LANGUAGE sql STABLE
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM safeguarding_leads l
      JOIN memberships m ON m.id = l.membership_id AND m.tenant_id = l.tenant_id
      WHERE l.tenant_id = app_current_tenant_id()
        AND l.ended_at IS NULL
        AND m.status = 'active'
        AND m.user_id = app_current_user_id()
    )
  $$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_is_safeguarding_lead() TO edubridge_app;
--> statement-breakpoint

-- Leads: the school's own list (everyone at the school may see who to go to); the Proprietor changes it.
GRANT SELECT, INSERT ON safeguarding_leads TO edubridge_app;
--> statement-breakpoint
GRANT UPDATE (ended_at, ended_by_user_id) ON safeguarding_leads TO edubridge_app;
--> statement-breakpoint
ALTER TABLE safeguarding_leads ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE safeguarding_leads FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY safeguarding_leads_tenant ON safeguarding_leads
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
CREATE FUNCTION safeguarding_lead_end_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'a safeguarding lead is ended once and never deleted' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER safeguarding_leads_end_once BEFORE UPDATE OR DELETE ON safeguarding_leads
  FOR EACH ROW EXECUTE FUNCTION safeguarding_lead_end_once();
--> statement-breakpoint

-- Cases: reported by any member (as themselves); read by leads, or by the reporter for their own report;
-- changed only by leads, and then only the status and the assigned lead (column grants).
GRANT SELECT, INSERT ON safeguarding_cases TO edubridge_app;
--> statement-breakpoint
GRANT UPDATE (status, lead_membership_id, updated_at) ON safeguarding_cases TO edubridge_app;
--> statement-breakpoint
ALTER TABLE safeguarding_cases ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE safeguarding_cases FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY safeguarding_cases_select ON safeguarding_cases FOR SELECT
  USING (tenant_id = app_current_tenant_id()
    AND (app_is_safeguarding_lead() OR reported_by_user_id = app_current_user_id()));
--> statement-breakpoint
CREATE POLICY safeguarding_cases_insert ON safeguarding_cases FOR INSERT
  WITH CHECK (tenant_id = app_current_tenant_id() AND reported_by_user_id = app_current_user_id());
--> statement-breakpoint
CREATE POLICY safeguarding_cases_update ON safeguarding_cases FOR UPDATE
  USING (tenant_id = app_current_tenant_id() AND app_is_safeguarding_lead())
  WITH CHECK (tenant_id = app_current_tenant_id() AND app_is_safeguarding_lead());
--> statement-breakpoint
ALTER TABLE safeguarding_cases ADD CONSTRAINT safeguarding_cases_enums
  CHECK (status in ('open', 'monitoring', 'closed') AND category in ('physical_harm', 'emotional_harm',
    'sexual_harm', 'neglect', 'bullying', 'self_harm', 'online_safety', 'other'));
--> statement-breakpoint
CREATE TRIGGER safeguarding_cases_no_delete BEFORE DELETE ON safeguarding_cases
  FOR EACH ROW EXECUTE FUNCTION history_record_immutable();
--> statement-breakpoint

-- Entries: leads only; insert-only, except that an action is marked done once.
GRANT SELECT, INSERT ON safeguarding_entries TO edubridge_app;
--> statement-breakpoint
GRANT UPDATE (done_at, done_by_user_id) ON safeguarding_entries TO edubridge_app;
--> statement-breakpoint
ALTER TABLE safeguarding_entries ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE safeguarding_entries FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY safeguarding_entries_leads ON safeguarding_entries
  USING (tenant_id = app_current_tenant_id() AND app_is_safeguarding_lead())
  WITH CHECK (tenant_id = app_current_tenant_id() AND app_is_safeguarding_lead());
--> statement-breakpoint
ALTER TABLE safeguarding_entries ADD CONSTRAINT safeguarding_entries_kind
  CHECK (kind in ('note', 'action', 'referral', 'family_contact', 'meeting', 'status', 'assignment'));
--> statement-breakpoint
CREATE FUNCTION safeguarding_entry_done_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'safeguarding history is never deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.kind <> 'action' OR OLD.done_at IS NOT NULL OR NEW.done_at IS NULL THEN
    RAISE EXCEPTION 'only an open action can be marked done, once' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER safeguarding_entries_done_once BEFORE UPDATE OR DELETE ON safeguarding_entries
  FOR EACH ROW EXECUTE FUNCTION safeguarding_entry_done_once();
--> statement-breakpoint

-- Access records: written and read by leads only; never changed.
GRANT SELECT, INSERT ON safeguarding_access TO edubridge_app;
--> statement-breakpoint
ALTER TABLE safeguarding_access ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE safeguarding_access FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY safeguarding_access_leads ON safeguarding_access
  USING (tenant_id = app_current_tenant_id() AND app_is_safeguarding_lead())
  WITH CHECK (tenant_id = app_current_tenant_id() AND app_is_safeguarding_lead() AND user_id = app_current_user_id());
--> statement-breakpoint
ALTER TABLE safeguarding_access ADD CONSTRAINT safeguarding_access_action CHECK (action in ('viewed', 'downloaded'));
--> statement-breakpoint
CREATE TRIGGER safeguarding_access_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON safeguarding_access
  FOR EACH STATEMENT EXECUTE FUNCTION payroll_insert_only();
--> statement-breakpoint

-- Documents: leads only; removed once, never deleted.
GRANT SELECT, INSERT ON safeguarding_documents TO edubridge_app;
--> statement-breakpoint
GRANT UPDATE (removed_at, removed_by_user_id) ON safeguarding_documents TO edubridge_app;
--> statement-breakpoint
ALTER TABLE safeguarding_documents ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE safeguarding_documents FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY safeguarding_documents_leads ON safeguarding_documents
  USING (tenant_id = app_current_tenant_id() AND app_is_safeguarding_lead())
  WITH CHECK (tenant_id = app_current_tenant_id() AND app_is_safeguarding_lead());
--> statement-breakpoint
CREATE FUNCTION safeguarding_document_remove_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.removed_at IS NOT NULL THEN
    RAISE EXCEPTION 'a safeguarding document is removed once and never deleted' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER safeguarding_documents_remove_once BEFORE UPDATE OR DELETE ON safeguarding_documents
  FOR EACH ROW EXECUTE FUNCTION safeguarding_document_remove_once();
