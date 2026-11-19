-- Library (R4-7, module library): tenant isolation, and history that cannot be rewritten. Titles and copies are
-- archived or withdrawn, never deleted; a copy keeps its number; a loan is closed once (returned or lost) and then
-- never changes; reservations only move forward.

GRANT SELECT, INSERT, UPDATE ON library_titles TO edubridge_app;
--> statement-breakpoint
ALTER TABLE library_titles ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE library_titles FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY library_titles_tenant ON library_titles
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE library_titles ADD CONSTRAINT library_titles_status CHECK (status in ('active', 'archived'));
--> statement-breakpoint

GRANT SELECT, INSERT ON library_copies TO edubridge_app;
--> statement-breakpoint
GRANT UPDATE (shelf, status, withdrawn_at, withdrawn_reason) ON library_copies TO edubridge_app;
--> statement-breakpoint
ALTER TABLE library_copies ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE library_copies FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY library_copies_tenant ON library_copies
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE library_copies ADD CONSTRAINT library_copies_status CHECK (status in ('active', 'withdrawn'));
--> statement-breakpoint
CREATE FUNCTION library_copy_withdrawn_final() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status = 'withdrawn' THEN
    RAISE EXCEPTION 'a withdrawn copy does not change, and no copy is deleted' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER library_copies_withdrawn_final BEFORE UPDATE OR DELETE ON library_copies
  FOR EACH ROW EXECUTE FUNCTION library_copy_withdrawn_final();
--> statement-breakpoint

GRANT SELECT, INSERT ON library_loans TO edubridge_app;
--> statement-breakpoint
GRANT UPDATE (due_on, renewals, returned_at, returned_by_user_id, lost_at, lost_by_user_id, fine_minor,
  ledger_entry_id) ON library_loans TO edubridge_app;
--> statement-breakpoint
ALTER TABLE library_loans ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE library_loans FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY library_loans_tenant ON library_loans
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
CREATE FUNCTION library_loan_closed_final() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.returned_at IS NOT NULL OR OLD.lost_at IS NOT NULL THEN
    RAISE EXCEPTION 'a closed loan does not change, and no loan is deleted' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER library_loans_closed_final BEFORE UPDATE OR DELETE ON library_loans
  FOR EACH ROW EXECUTE FUNCTION library_loan_closed_final();
--> statement-breakpoint

GRANT SELECT, INSERT ON library_reservations TO edubridge_app;
--> statement-breakpoint
GRANT UPDATE (status, held_copy_id, ready_at, closed_at, closed_by_user_id) ON library_reservations TO edubridge_app;
--> statement-breakpoint
ALTER TABLE library_reservations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE library_reservations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY library_reservations_tenant ON library_reservations
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE library_reservations ADD CONSTRAINT library_reservations_status
  CHECK (status in ('waiting', 'ready', 'fulfilled', 'cancelled'));
--> statement-breakpoint
-- Forward only: waiting → ready or cancelled; ready → fulfilled or cancelled.
CREATE FUNCTION library_reservation_forward_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NOT (
    (OLD.status = 'waiting' AND NEW.status IN ('ready', 'cancelled'))
    OR (OLD.status = 'ready' AND NEW.status IN ('fulfilled', 'cancelled'))
  ) THEN
    RAISE EXCEPTION 'a reservation only moves forward and is never deleted' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER library_reservations_forward_only BEFORE UPDATE OR DELETE ON library_reservations
  FOR EACH ROW EXECUTE FUNCTION library_reservation_forward_only();
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON library_settings TO edubridge_app;
--> statement-breakpoint
ALTER TABLE library_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE library_settings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY library_settings_tenant ON library_settings
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
