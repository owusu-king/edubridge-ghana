-- Messages to families (Phase O): announcements and who has read them.

-- Announcements are posted, never edited or deleted.
GRANT SELECT, INSERT ON announcements TO edubridge_app;
--> statement-breakpoint
ALTER TABLE announcements ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE announcements FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY announcements_tenant ON announcements
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
CREATE TRIGGER announcements_no_update_delete BEFORE UPDATE OR DELETE ON announcements
  FOR EACH ROW EXECUTE FUNCTION history_record_immutable();
--> statement-breakpoint
CREATE TRIGGER announcements_no_truncate BEFORE TRUNCATE ON announcements
  FOR EACH STATEMENT EXECUTE FUNCTION history_record_immutable();
--> statement-breakpoint

GRANT SELECT, INSERT ON announcement_reads TO edubridge_app;
--> statement-breakpoint
ALTER TABLE announcement_reads ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE announcement_reads FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY announcement_reads_tenant ON announcement_reads
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
