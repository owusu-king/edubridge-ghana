-- Boarding (R4-8, module boarding): tenant isolation, and history that cannot be rewritten. Houses, rooms and beds
-- are archived, never deleted; house staff and bed assignments are ended once; an exeat is signed back in once.

GRANT SELECT, INSERT, UPDATE ON boarding_houses TO edubridge_app;
--> statement-breakpoint
ALTER TABLE boarding_houses ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE boarding_houses FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY boarding_houses_tenant ON boarding_houses
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE boarding_houses ADD CONSTRAINT boarding_houses_values
  CHECK (kind in ('boys', 'girls', 'mixed') AND status in ('active', 'archived'));
--> statement-breakpoint

GRANT SELECT, INSERT ON boarding_rooms TO edubridge_app;
--> statement-breakpoint
GRANT UPDATE (name, status) ON boarding_rooms TO edubridge_app;
--> statement-breakpoint
ALTER TABLE boarding_rooms ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE boarding_rooms FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY boarding_rooms_tenant ON boarding_rooms
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE boarding_rooms ADD CONSTRAINT boarding_rooms_status CHECK (status in ('active', 'archived'));
--> statement-breakpoint

GRANT SELECT, INSERT ON boarding_beds TO edubridge_app;
--> statement-breakpoint
GRANT UPDATE (label, status) ON boarding_beds TO edubridge_app;
--> statement-breakpoint
ALTER TABLE boarding_beds ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE boarding_beds FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY boarding_beds_tenant ON boarding_beds
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE boarding_beds ADD CONSTRAINT boarding_beds_status CHECK (status in ('active', 'archived'));
--> statement-breakpoint

-- Ended once, never deleted (house staff and bed assignments share the rule).
CREATE FUNCTION boarding_end_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.ended_at IS NOT NULL OR NEW.ended_at IS NULL THEN
    RAISE EXCEPTION 'ended once and never deleted' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

GRANT SELECT, INSERT ON boarding_house_staff TO edubridge_app;
--> statement-breakpoint
GRANT UPDATE (ended_at, ended_by_user_id) ON boarding_house_staff TO edubridge_app;
--> statement-breakpoint
ALTER TABLE boarding_house_staff ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE boarding_house_staff FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY boarding_house_staff_tenant ON boarding_house_staff
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
CREATE TRIGGER boarding_house_staff_end_once BEFORE UPDATE OR DELETE ON boarding_house_staff
  FOR EACH ROW EXECUTE FUNCTION boarding_end_once();
--> statement-breakpoint

GRANT SELECT, INSERT ON boarding_assignments TO edubridge_app;
--> statement-breakpoint
GRANT UPDATE (ended_at, ended_by_user_id) ON boarding_assignments TO edubridge_app;
--> statement-breakpoint
ALTER TABLE boarding_assignments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE boarding_assignments FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY boarding_assignments_tenant ON boarding_assignments
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
CREATE TRIGGER boarding_assignments_end_once BEFORE UPDATE OR DELETE ON boarding_assignments
  FOR EACH ROW EXECUTE FUNCTION boarding_end_once();
--> statement-breakpoint

GRANT SELECT, INSERT ON boarding_exeats TO edubridge_app;
--> statement-breakpoint
GRANT UPDATE (back_at, back_by_user_id) ON boarding_exeats TO edubridge_app;
--> statement-breakpoint
ALTER TABLE boarding_exeats ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE boarding_exeats FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY boarding_exeats_tenant ON boarding_exeats
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
CREATE FUNCTION boarding_exeat_back_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.back_at IS NOT NULL OR NEW.back_at IS NULL THEN
    RAISE EXCEPTION 'an exeat is signed back in once and never deleted' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER boarding_exeats_back_once BEFORE UPDATE OR DELETE ON boarding_exeats
  FOR EACH ROW EXECUTE FUNCTION boarding_exeat_back_once();
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON boarding_settings TO edubridge_app;
--> statement-breakpoint
ALTER TABLE boarding_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE boarding_settings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY boarding_settings_tenant ON boarding_settings
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
