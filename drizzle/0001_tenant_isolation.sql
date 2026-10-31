-- Tenant isolation: row-level security, restricted application role, append-only audit trail.
-- Rule: every table with a tenant_id column must ENABLE and FORCE row-level security.
-- tests/integration/tenant-isolation.test.ts enforces this for all future migrations.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edubridge_app') THEN
    CREATE ROLE edubridge_app NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint
CREATE FUNCTION app_current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;
--> statement-breakpoint
CREATE FUNCTION app_current_user_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO edubridge_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_current_tenant_id(), app_current_user_id() TO edubridge_app;
--> statement-breakpoint

-- Global tables (no tenant_id). Access is mediated by the auth and tenancy services.
GRANT SELECT, INSERT, UPDATE ON users TO edubridge_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON sessions TO edubridge_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON login_attempts TO edubridge_app;
--> statement-breakpoint

-- Tenants: readable for slug resolution; only the current tenant may be updated; provisioning is
-- a platform operation performed with the owner role.
GRANT SELECT, UPDATE (name, timezone, updated_at) ON tenants TO edubridge_app;
--> statement-breakpoint
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenants_select ON tenants FOR SELECT TO edubridge_app USING (true);
--> statement-breakpoint
CREATE POLICY tenants_update ON tenants FOR UPDATE TO edubridge_app
  USING (id = app_current_tenant_id()) WITH CHECK (id = app_current_tenant_id());
--> statement-breakpoint

-- Memberships: visible within the current tenant, and a user can always see their own memberships
-- (needed to list "my schools"). Never deleted by the application; suspend instead.
GRANT SELECT, INSERT, UPDATE ON memberships TO edubridge_app;
--> statement-breakpoint
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY memberships_select ON memberships FOR SELECT
  USING (tenant_id = app_current_tenant_id() OR user_id = app_current_user_id());
--> statement-breakpoint
CREATE POLICY memberships_insert ON memberships FOR INSERT
  WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
CREATE POLICY memberships_update ON memberships FOR UPDATE
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint

-- Audit events: append-only.
GRANT SELECT, INSERT ON audit_events TO edubridge_app;
--> statement-breakpoint
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY audit_events_select ON audit_events FOR SELECT
  USING (tenant_id = app_current_tenant_id());
--> statement-breakpoint
CREATE POLICY audit_events_insert ON audit_events FOR INSERT
  WITH CHECK (tenant_id = app_current_tenant_id());
