-- The public landing page (2026-11-19): "Try the demo school" and "Book a visit".
--
-- Demo visitors: the app only reads which accounts they are (db/context.ts makes every school transaction of
-- such an account read-only). Only the demo script adds one, as the migration owner.
GRANT SELECT ON demo_visitors TO edubridge_app;
--> statement-breakpoint
-- A demo visitor account is shared by everyone who presses the button, so it may never belong to a real school:
-- the database refuses the membership, whatever code asks for it.
CREATE FUNCTION memberships_demo_visitor_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM demo_visitors WHERE user_id = NEW.user_id)
     AND NOT EXISTS (SELECT 1 FROM tenants WHERE id = NEW.tenant_id AND is_demo) THEN
    RAISE EXCEPTION 'demo_visitor_membership: a demo visitor account can only belong to a demo school';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER memberships_demo_visitor_guard BEFORE INSERT OR UPDATE OF user_id, tenant_id ON memberships
  FOR EACH ROW EXECUTE FUNCTION memberships_demo_visitor_guard();
--> statement-breakpoint
-- And an account cannot be made a demo visitor while it belongs to a real school.
-- Memberships are behind row-level security even for their owner, so the account's own memberships are read
-- through the policy that lets a user see theirs (app.user_id), which is put back afterwards.
CREATE FUNCTION demo_visitors_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  previous_user text := current_setting('app.user_id', true);
  real_school boolean;
BEGIN
  PERFORM set_config('app.user_id', NEW.user_id::text, true);
  SELECT EXISTS (
    SELECT 1 FROM memberships m JOIN tenants t ON t.id = m.tenant_id
    WHERE m.user_id = NEW.user_id AND NOT t.is_demo
  ) INTO real_school;
  PERFORM set_config('app.user_id', coalesce(previous_user, ''), true);
  IF real_school THEN
    RAISE EXCEPTION 'demo_visitor_membership: this account belongs to a school that is not a demo';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER demo_visitors_guard BEFORE INSERT ON demo_visitors
  FOR EACH ROW EXECUTE FUNCTION demo_visitors_guard();
--> statement-breakpoint
-- Enquiries: anyone may send one (through the app's checks), only the platform reads them, and the only change
-- is marking one handled, once. Nothing is deleted.
GRANT SELECT, INSERT ON sales_enquiries TO edubridge_app;
--> statement-breakpoint
GRANT UPDATE (handled_at, handled_by_user_id) ON sales_enquiries TO edubridge_app;
--> statement-breakpoint
ALTER TABLE sales_enquiries
  ADD CONSTRAINT sales_enquiries_role_check
    CHECK (role IN ('proprietor', 'head', 'bursar', 'administrator', 'other')),
  ADD CONSTRAINT sales_enquiries_students_check
    CHECK (students IN ('under_150', '150_400', '400_800', 'over_800')),
  ADD CONSTRAINT sales_enquiries_lengths_check
    CHECK (
      char_length(name) BETWEEN 1 AND 120 AND char_length(school_name) BETWEEN 1 AND 160
      AND char_length(town) BETWEEN 1 AND 120 AND char_length(phone) BETWEEN 8 AND 20
      AND (email IS NULL OR char_length(email) <= 254)
      AND (message IS NULL OR char_length(message) <= 1000)
    ),
  ADD CONSTRAINT sales_enquiries_handled_check
    CHECK ((handled_at IS NULL) = (handled_by_user_id IS NULL));
--> statement-breakpoint
CREATE FUNCTION sales_enquiries_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.handled_at IS NOT NULL THEN
    RAISE EXCEPTION 'enquiry_handled: this enquiry is already marked as handled';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER sales_enquiries_guard BEFORE UPDATE ON sales_enquiries
  FOR EACH ROW EXECUTE FUNCTION sales_enquiries_guard();
