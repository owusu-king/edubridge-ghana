-- SMS segments (R3, notification foundation): a school is charged for the segments its message takes. The
-- usage row's segments always come from the queued message itself, whatever the caller sends, so no path
-- (staff screens, the worker, the parent sign-in function) can under- or over-charge.
CREATE FUNCTION sms_usage_segments_from_outbox() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  SELECT segments INTO NEW.segments FROM notification_outbox WHERE id = NEW.outbox_id;
  IF NEW.segments IS NULL THEN
    RAISE EXCEPTION 'sms usage needs a queued message' USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION sms_usage_segments_from_outbox() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER sms_usage_segments BEFORE INSERT ON sms_usage
  FOR EACH ROW EXECUTE FUNCTION sms_usage_segments_from_outbox();
