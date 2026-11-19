-- Scheduled announcements (NOT-06): kept by the school; cancelled rather than deleted.
GRANT SELECT, INSERT ON scheduled_announcements TO edubridge_app;
--> statement-breakpoint
GRANT UPDATE (status, announcement_id, note, cancelled_by_user_id, updated_at) ON scheduled_announcements TO edubridge_app;
--> statement-breakpoint
ALTER TABLE scheduled_announcements ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE scheduled_announcements FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY scheduled_announcements_tenant ON scheduled_announcements
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE scheduled_announcements ADD CONSTRAINT scheduled_announcements_status
  CHECK (status in ('pending', 'posted', 'cancelled'));
--> statement-breakpoint
ALTER TABLE scheduled_announcements ADD CONSTRAINT scheduled_announcements_audience
  CHECK (audience in ('school', 'level', 'class', 'campus'));
--> statement-breakpoint
-- Posted or cancelled: never changes again.
CREATE FUNCTION scheduled_announcement_final() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'a posted or cancelled announcement cannot change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER scheduled_announcements_final BEFORE UPDATE ON scheduled_announcements
  FOR EACH ROW EXECUTE FUNCTION scheduled_announcement_final();
