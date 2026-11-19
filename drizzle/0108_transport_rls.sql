-- Transport (R4-5, module transport): tenant isolation, and history that cannot be rewritten. Vehicles, routes
-- and stops are archived, never deleted (no DELETE grant). An assignment is ended once; a trip is never changed;
-- a child's getting off is marked once after boarding, and nothing is deleted.

GRANT SELECT, INSERT, UPDATE ON transport_vehicles TO edubridge_app;
--> statement-breakpoint
ALTER TABLE transport_vehicles ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE transport_vehicles FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY transport_vehicles_tenant ON transport_vehicles
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE transport_vehicles ADD CONSTRAINT transport_vehicles_status CHECK (status in ('active', 'archived'));
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON transport_routes TO edubridge_app;
--> statement-breakpoint
ALTER TABLE transport_routes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE transport_routes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY transport_routes_tenant ON transport_routes
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE transport_routes ADD CONSTRAINT transport_routes_status CHECK (status in ('active', 'archived'));
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON transport_stops TO edubridge_app;
--> statement-breakpoint
ALTER TABLE transport_stops ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE transport_stops FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY transport_stops_tenant ON transport_stops
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE transport_stops ADD CONSTRAINT transport_stops_status CHECK (status in ('active', 'archived'));
--> statement-breakpoint

GRANT SELECT, INSERT ON transport_assignments TO edubridge_app;
--> statement-breakpoint
GRANT UPDATE (ended_at, ended_by_user_id) ON transport_assignments TO edubridge_app;
--> statement-breakpoint
ALTER TABLE transport_assignments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE transport_assignments FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY transport_assignments_tenant ON transport_assignments
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE transport_assignments ADD CONSTRAINT transport_assignments_direction
  CHECK (direction in ('both', 'to_school', 'from_school'));
--> statement-breakpoint
CREATE FUNCTION transport_assignment_end_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.ended_at IS NOT NULL OR NEW.ended_at IS NULL THEN
    RAISE EXCEPTION 'a transport assignment is ended once and never deleted' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER transport_assignments_end_once BEFORE UPDATE OR DELETE ON transport_assignments
  FOR EACH ROW EXECUTE FUNCTION transport_assignment_end_once();
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON transport_settings TO edubridge_app;
--> statement-breakpoint
ALTER TABLE transport_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE transport_settings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY transport_settings_tenant ON transport_settings
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint

GRANT SELECT, INSERT ON transport_trips TO edubridge_app;
--> statement-breakpoint
ALTER TABLE transport_trips ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE transport_trips FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY transport_trips_tenant ON transport_trips
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE transport_trips ADD CONSTRAINT transport_trips_direction
  CHECK (direction in ('to_school', 'from_school'));
--> statement-breakpoint

GRANT SELECT, INSERT ON transport_trip_marks TO edubridge_app;
--> statement-breakpoint
GRANT UPDATE (left_at, left_by_user_id) ON transport_trip_marks TO edubridge_app;
--> statement-breakpoint
ALTER TABLE transport_trip_marks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE transport_trip_marks FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY transport_trip_marks_tenant ON transport_trip_marks
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
CREATE FUNCTION transport_trip_mark_left_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.left_at IS NOT NULL OR NEW.left_at IS NULL THEN
    RAISE EXCEPTION 'a trip mark is made once and never deleted' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER transport_trip_marks_left_once BEFORE UPDATE OR DELETE ON transport_trip_marks
  FOR EACH ROW EXECUTE FUNCTION transport_trip_mark_left_once();
