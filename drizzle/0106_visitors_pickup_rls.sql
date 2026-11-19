-- Visitors and pickup (R4-4, module visitors_pickup): tenant isolation, and history that cannot be rewritten.
-- A visit is signed out once; a collector is ended once; a pickup or refusal is cancelled once. Nothing is
-- deleted, and nothing else changes (column grants and triggers).

GRANT SELECT, INSERT ON visitor_visits TO edubridge_app;
--> statement-breakpoint
GRANT UPDATE (signed_out_at, signed_out_by_user_id) ON visitor_visits TO edubridge_app;
--> statement-breakpoint
ALTER TABLE visitor_visits ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE visitor_visits FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY visitor_visits_tenant ON visitor_visits
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE visitor_visits ADD CONSTRAINT visitor_visits_purpose
  CHECK (purpose in ('meeting', 'family', 'delivery', 'contractor', 'official', 'interview', 'other'));
--> statement-breakpoint
CREATE FUNCTION visitor_visit_sign_out_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.signed_out_at IS NOT NULL OR NEW.signed_out_at IS NULL THEN
    RAISE EXCEPTION 'a visit is signed out once and never deleted' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER visitor_visits_sign_out_once BEFORE UPDATE OR DELETE ON visitor_visits
  FOR EACH ROW EXECUTE FUNCTION visitor_visit_sign_out_once();
--> statement-breakpoint

GRANT SELECT, INSERT ON pickup_collectors TO edubridge_app;
--> statement-breakpoint
GRANT UPDATE (ended_at, ended_by_user_id, end_reason) ON pickup_collectors TO edubridge_app;
--> statement-breakpoint
ALTER TABLE pickup_collectors ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE pickup_collectors FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY pickup_collectors_tenant ON pickup_collectors
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
CREATE FUNCTION pickup_collector_end_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.ended_at IS NOT NULL OR NEW.ended_at IS NULL THEN
    RAISE EXCEPTION 'a collector is ended once and never deleted' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER pickup_collectors_end_once BEFORE UPDATE OR DELETE ON pickup_collectors
  FOR EACH ROW EXECUTE FUNCTION pickup_collector_end_once();
--> statement-breakpoint

GRANT SELECT, INSERT ON pickups TO edubridge_app;
--> statement-breakpoint
GRANT UPDATE (cancelled_at, cancelled_by_user_id, cancel_reason) ON pickups TO edubridge_app;
--> statement-breakpoint
ALTER TABLE pickups ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE pickups FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY pickups_tenant ON pickups
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE pickups ADD CONSTRAINT pickups_outcome CHECK (outcome in ('released', 'refused'));
--> statement-breakpoint
CREATE FUNCTION pickup_cancel_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.cancelled_at IS NOT NULL OR NEW.cancelled_at IS NULL THEN
    RAISE EXCEPTION 'a pickup record is cancelled once and never deleted' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER pickups_cancel_once BEFORE UPDATE OR DELETE ON pickups
  FOR EACH ROW EXECUTE FUNCTION pickup_cancel_once();
