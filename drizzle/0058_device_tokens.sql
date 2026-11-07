CREATE TABLE "device_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"user_agent" text,
	"ip_address" "inet",
	CONSTRAINT "device_tokens_name_length" CHECK (char_length("device_tokens"."name") between 1 and 80)
);
--> statement-breakpoint
ALTER TABLE "device_tokens" ADD CONSTRAINT "device_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "device_tokens_user_idx" ON "device_tokens" USING btree ("user_id");
--> statement-breakpoint
-- Tokens are revoked, never deleted by the app (the user row cascade removes them).
GRANT SELECT, INSERT, UPDATE (last_used_at, expires_at, revoked_at) ON device_tokens TO edubridge_app;
