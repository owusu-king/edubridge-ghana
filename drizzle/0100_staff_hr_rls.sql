-- Staff and HR (R4-1, module staff_hr): grants, tenant isolation, and the rules that keep employment history,
-- leave decisions and staff attendance trustworthy. Nothing here is ever deleted by the app.

-- The school's own lists: renamed and archived, never deleted.
GRANT SELECT, INSERT ON staff_departments, staff_positions, leave_types TO edubridge_app;
--> statement-breakpoint
GRANT UPDATE (name, archived_at) ON staff_departments, staff_positions TO edubridge_app;
--> statement-breakpoint
GRANT UPDATE (name, days_per_year, paid, archived_at) ON leave_types TO edubridge_app;
--> statement-breakpoint
-- Staff records: every column but the identity and staff number can be corrected.
GRANT SELECT, INSERT ON staff TO edubridge_app;
--> statement-breakpoint
GRANT UPDATE (membership_id, first_name, last_name, other_names, sex, date_of_birth, phone, email, address,
  qualifications, emergency_name, emergency_relationship, emergency_phone, employment_type, department_id,
  position_id, campus_id, started_on, status, left_on, leaving_reason, updated_at) ON staff TO edubridge_app;
--> statement-breakpoint
-- Employment history is insert-only.
GRANT SELECT, INSERT ON staff_employment_events TO edubridge_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON leave_requests TO edubridge_app;
--> statement-breakpoint
GRANT UPDATE (status, decided_by_user_id, decided_at, decision_note, cancelled_by_user_id, cancelled_at)
  ON leave_requests TO edubridge_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON staff_attendance TO edubridge_app;
--> statement-breakpoint
GRANT UPDATE (status, note, version, recorded_by_user_id, recorded_at) ON staff_attendance TO edubridge_app;
--> statement-breakpoint

ALTER TABLE staff_departments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE staff_departments FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY staff_departments_tenant ON staff_departments
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE staff_positions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE staff_positions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY staff_positions_tenant ON staff_positions
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE staff ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE staff FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY staff_tenant ON staff
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE staff_employment_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE staff_employment_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY staff_employment_events_tenant ON staff_employment_events
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE leave_types ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE leave_types FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY leave_types_tenant ON leave_types
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE leave_requests ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE leave_requests FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY leave_requests_tenant ON leave_requests
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE staff_attendance ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE staff_attendance FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY staff_attendance_tenant ON staff_attendance
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint

ALTER TABLE staff ADD CONSTRAINT staff_enums
  CHECK (employment_type in ('permanent', 'contract', 'part_time', 'national_service', 'volunteer', 'casual')
    AND status in ('active', 'left') AND (sex is null or sex in ('female', 'male')));
--> statement-breakpoint
ALTER TABLE staff_employment_events ADD CONSTRAINT staff_employment_events_enums
  CHECK (kind in ('started', 'changed', 'left', 'returned')
    AND employment_type in ('permanent', 'contract', 'part_time', 'national_service', 'volunteer', 'casual'));
--> statement-breakpoint
ALTER TABLE leave_requests ADD CONSTRAINT leave_requests_status
  CHECK (status in ('pending', 'approved', 'declined', 'cancelled'));
--> statement-breakpoint
ALTER TABLE staff_attendance ADD CONSTRAINT staff_attendance_status
  CHECK (status in ('present', 'late', 'absent', 'off_duty'));
--> statement-breakpoint

-- Employment history is never changed or removed, by any role.
CREATE FUNCTION staff_employment_event_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'employment history is never changed or removed' USING ERRCODE = 'check_violation';
END $$;
--> statement-breakpoint
CREATE TRIGGER staff_employment_events_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON staff_employment_events
  FOR EACH STATEMENT EXECUTE FUNCTION staff_employment_event_immutable();
--> statement-breakpoint

-- Leave: waiting can become approved, declined or cancelled; approved can become cancelled; nothing else.
-- The request itself (who, what, when, how many days, why) never changes, and no request is deleted.
CREATE FUNCTION leave_request_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'leave requests are never deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.staff_id <> OLD.staff_id OR NEW.leave_type_id <> OLD.leave_type_id
    OR NEW.starts_on <> OLD.starts_on OR NEW.ends_on <> OLD.ends_on OR NEW.days <> OLD.days
    OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.requested_by_user_id <> OLD.requested_by_user_id
    OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a leave request cannot be rewritten' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT ((OLD.status = 'pending' AND NEW.status IN ('approved', 'declined', 'cancelled'))
    OR (OLD.status = 'approved' AND NEW.status = 'cancelled')) THEN
    RAISE EXCEPTION 'leave cannot go from % to %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.decided_at IS NOT NULL AND (NEW.decided_at IS DISTINCT FROM OLD.decided_at
    OR NEW.decided_by_user_id IS DISTINCT FROM OLD.decided_by_user_id
    OR NEW.decision_note IS DISTINCT FROM OLD.decision_note) THEN
    RAISE EXCEPTION 'a leave decision is made once' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER leave_requests_transition BEFORE UPDATE OR DELETE ON leave_requests
  FOR EACH ROW EXECUTE FUNCTION leave_request_transition();
--> statement-breakpoint

-- Staff attendance: each change steps the version by one, so a change made from an old copy cannot land.
CREATE FUNCTION staff_attendance_version_step() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'staff attendance is never deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.version <> OLD.version + 1 OR NEW.staff_id <> OLD.staff_id OR NEW.date <> OLD.date
    OR NEW.tenant_id <> OLD.tenant_id THEN
    RAISE EXCEPTION 'a staff attendance change must step the version by one' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER staff_attendance_version_step BEFORE UPDATE OR DELETE ON staff_attendance
  FOR EACH ROW EXECUTE FUNCTION staff_attendance_version_step();
