CREATE TABLE "platform_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_secrets" (
	"name" text PRIMARY KEY NOT NULL,
	"sealed" text NOT NULL,
	"hint" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" uuid
);
--> statement-breakpoint
CREATE TABLE "record_signing_keys" (
	"key_id" text PRIMARY KEY NOT NULL,
	"public_key" text NOT NULL,
	"private_key_sealed" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid,
	"retired_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "assistant_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "assistant_model" text DEFAULT 'claude-opus-5-5' NOT NULL;
--> statement-breakpoint
ALTER TABLE "school_preferences" ADD COLUMN "assistant_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "school_preferences" ADD COLUMN "assistant_share_names" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "school_preferences" ADD COLUMN "offline_receipts_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "platform_events" ADD CONSTRAINT "platform_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "platform_secrets" ADD CONSTRAINT "platform_secrets_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "record_signing_keys" ADD CONSTRAINT "record_signing_keys_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "platform_events_time_idx" ON "platform_events" USING btree ("occurred_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "record_signing_keys_one_active" ON "record_signing_keys" USING btree ("status") WHERE "record_signing_keys"."status" = 'active';
--> statement-breakpoint
-- Platform-managed integrations. Only platform administrators change them (app_is_platform_admin); the app
-- reads them to run the assistant and to sign and verify records (values are sealed).
GRANT UPDATE (assistant_enabled, assistant_model) ON platform_settings TO edubridge_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON platform_secrets TO edubridge_app;
--> statement-breakpoint
ALTER TABLE platform_secrets ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform_secrets FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY platform_secrets_read ON platform_secrets FOR SELECT USING (true);
--> statement-breakpoint
CREATE POLICY platform_secrets_insert ON platform_secrets FOR INSERT WITH CHECK (app_is_platform_admin());
--> statement-breakpoint
CREATE POLICY platform_secrets_update ON platform_secrets FOR UPDATE
  USING (app_is_platform_admin()) WITH CHECK (app_is_platform_admin());
--> statement-breakpoint
CREATE POLICY platform_secrets_delete ON platform_secrets FOR DELETE USING (app_is_platform_admin());
--> statement-breakpoint
GRANT SELECT, INSERT ON record_signing_keys TO edubridge_app;
--> statement-breakpoint
GRANT UPDATE (status, retired_at) ON record_signing_keys TO edubridge_app;
--> statement-breakpoint
ALTER TABLE record_signing_keys ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE record_signing_keys FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY record_signing_keys_read ON record_signing_keys FOR SELECT USING (true);
--> statement-breakpoint
CREATE POLICY record_signing_keys_insert ON record_signing_keys FOR INSERT WITH CHECK (app_is_platform_admin());
--> statement-breakpoint
CREATE POLICY record_signing_keys_update ON record_signing_keys FOR UPDATE
  USING (app_is_platform_admin()) WITH CHECK (app_is_platform_admin());
--> statement-breakpoint
-- A key is only ever retired (never reactivated or deleted), so old records keep verifying.
CREATE FUNCTION signing_key_retire_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'active' OR NEW.status <> 'retired' OR NEW.retired_at IS NULL THEN
    RAISE EXCEPTION 'a signing key can only be retired, once' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER record_signing_keys_retire_only BEFORE UPDATE ON record_signing_keys
  FOR EACH ROW EXECUTE FUNCTION signing_key_retire_only();
--> statement-breakpoint
CREATE TRIGGER record_signing_keys_no_delete BEFORE DELETE ON record_signing_keys
  FOR EACH ROW EXECUTE FUNCTION history_record_immutable();
--> statement-breakpoint
GRANT SELECT, INSERT ON platform_events TO edubridge_app;
--> statement-breakpoint
ALTER TABLE platform_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY platform_events_read ON platform_events FOR SELECT USING (app_is_platform_admin());
--> statement-breakpoint
CREATE POLICY platform_events_insert ON platform_events FOR INSERT WITH CHECK (app_is_platform_admin());
--> statement-breakpoint
CREATE TRIGGER platform_events_no_update_delete BEFORE UPDATE OR DELETE ON platform_events
  FOR EACH ROW EXECUTE FUNCTION history_record_immutable();
