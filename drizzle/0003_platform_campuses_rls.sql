-- Platform administration, plan limits, campuses and invitations.
-- Tenant-owned tables: ENABLE + FORCE row-level security (enforced by the isolation test suite).

-- Platform administrators are granted with the owner role (scripts/platform-admin.ts); the app may only read.
GRANT SELECT ON platform_admins TO edubridge_app;
--> statement-breakpoint
CREATE FUNCTION app_is_platform_admin() RETURNS boolean
  LANGUAGE sql STABLE
  AS $$ SELECT EXISTS (SELECT 1 FROM platform_admins WHERE user_id = app_current_user_id()) $$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_is_platform_admin() TO edubridge_app;
--> statement-breakpoint

-- Creating and suspending schools: the app role has no INSERT or status privilege on tenants.
-- These functions run as the owner and refuse unless the acting user is a platform administrator.
CREATE FUNCTION platform_create_tenant(p_slug text, p_name text, p_country text, p_currency text, p_timezone text)
  RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  new_id uuid;
BEGIN
  IF NOT app_is_platform_admin() THEN
    RAISE EXCEPTION 'platform administrator required' USING ERRCODE = '42501';
  END IF;
  INSERT INTO tenants (slug, name, country_code, currency_code, timezone)
    VALUES (p_slug, p_name, p_country, p_currency, p_timezone)
    RETURNING id INTO new_id;
  RETURN new_id;
END
$$;
--> statement-breakpoint
CREATE FUNCTION platform_set_tenant_status(p_tenant_id uuid, p_status text)
  RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
BEGIN
  IF NOT app_is_platform_admin() THEN
    RAISE EXCEPTION 'platform administrator required' USING ERRCODE = '42501';
  END IF;
  UPDATE tenants SET status = p_status, updated_at = now() WHERE id = p_tenant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant not found' USING ERRCODE = 'P0002';
  END IF;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION platform_create_tenant(text, text, text, text, text), platform_set_tenant_status(uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform_create_tenant(text, text, text, text, text), platform_set_tenant_status(uuid, text) TO edubridge_app;
--> statement-breakpoint

-- Plan limits: schools can read their own; only platform administrators can write.
GRANT SELECT, INSERT, UPDATE ON tenant_entitlements TO edubridge_app;
--> statement-breakpoint
ALTER TABLE tenant_entitlements ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tenant_entitlements FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_entitlements_select ON tenant_entitlements FOR SELECT
  USING (tenant_id = app_current_tenant_id() OR app_is_platform_admin());
--> statement-breakpoint
CREATE POLICY tenant_entitlements_insert ON tenant_entitlements FOR INSERT
  WITH CHECK (tenant_id = app_current_tenant_id() AND app_is_platform_admin());
--> statement-breakpoint
CREATE POLICY tenant_entitlements_update ON tenant_entitlements FOR UPDATE
  USING (tenant_id = app_current_tenant_id() AND app_is_platform_admin())
  WITH CHECK (tenant_id = app_current_tenant_id() AND app_is_platform_admin());
--> statement-breakpoint

-- Campuses: archived, never deleted.
GRANT SELECT, INSERT, UPDATE ON campuses TO edubridge_app;
--> statement-breakpoint
ALTER TABLE campuses ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE campuses FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY campuses_select ON campuses FOR SELECT USING (tenant_id = app_current_tenant_id());
--> statement-breakpoint
CREATE POLICY campuses_insert ON campuses FOR INSERT WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
CREATE POLICY campuses_update ON campuses FOR UPDATE
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint

-- Campus scope of memberships. A user may read their own scope rows (needed to resolve their context).
GRANT SELECT, INSERT, DELETE ON membership_campuses TO edubridge_app;
--> statement-breakpoint
ALTER TABLE membership_campuses ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE membership_campuses FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY membership_campuses_select ON membership_campuses FOR SELECT USING (tenant_id = app_current_tenant_id());
--> statement-breakpoint
CREATE POLICY membership_campuses_insert ON membership_campuses FOR INSERT WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
CREATE POLICY membership_campuses_delete ON membership_campuses FOR DELETE USING (tenant_id = app_current_tenant_id());
--> statement-breakpoint

-- Invitations: visible within the tenant, or to whoever presents the secret token
-- (the accept flow sets app.invitation_token_hash before it knows the tenant).
GRANT SELECT, INSERT, UPDATE ON invitations TO edubridge_app;
--> statement-breakpoint
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE invitations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY invitations_select ON invitations FOR SELECT
  USING (
    tenant_id = app_current_tenant_id()
    OR token_hash = nullif(current_setting('app.invitation_token_hash', true), '')
  );
--> statement-breakpoint
CREATE POLICY invitations_insert ON invitations FOR INSERT WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
CREATE POLICY invitations_update ON invitations FOR UPDATE
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
