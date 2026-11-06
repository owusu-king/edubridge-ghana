-- Parent view (Phase F).

-- Who blocked a guardian is recorded with the block, and both are cleared together.
ALTER TABLE guardians ADD CONSTRAINT guardians_portal_block_complete
  CHECK ((portal_blocked_at IS NULL) = (portal_blocked_by_user_id IS NULL));
--> statement-breakpoint

-- Finding the schools that have a parent's number on file, before any tenant context exists. The parent
-- sign-in sets app.parent_phone (transaction-local) to the number being signed in, after normalising it;
-- guardian rows with that exact number become readable, and nothing else. Writes stay tenant-scoped.
CREATE INDEX guardians_phone_idx ON guardians (phone) WHERE phone IS NOT NULL;
--> statement-breakpoint
CREATE POLICY guardians_parent_phone ON guardians FOR SELECT
  USING (phone = nullif(current_setting('app.parent_phone', true), ''));
--> statement-breakpoint

-- Global sign-in tables, like sessions and phone_verifications (no tenant, no RLS). Codes can only have
-- their attempt count and consumption changed; old rows are purged.
GRANT SELECT, INSERT, DELETE ON parent_sign_in_codes TO edubridge_app;
--> statement-breakpoint
GRANT UPDATE (attempts, consumed_at) ON parent_sign_in_codes TO edubridge_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON parent_sessions TO edubridge_app;
--> statement-breakpoint
GRANT UPDATE (expires_at) ON parent_sessions TO edubridge_app;
--> statement-breakpoint

-- Balance links: insert-only, visible within the tenant, or to whoever presents the secret token (the
-- link page sets app.balance_link_token_hash before it knows the school), as for invitations.
GRANT SELECT, INSERT ON balance_links TO edubridge_app;
--> statement-breakpoint
ALTER TABLE balance_links ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE balance_links FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY balance_links_select ON balance_links FOR SELECT
  USING (
    tenant_id = app_current_tenant_id()
    OR token_hash = nullif(current_setting('app.balance_link_token_hash', true), '')
  );
--> statement-breakpoint
CREATE POLICY balance_links_insert ON balance_links FOR INSERT
  WITH CHECK (tenant_id = app_current_tenant_id());
