CREATE TABLE "balance_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"guardian_id" uuid NOT NULL,
	"recipient" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "balance_links_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "balance_links_recipient" CHECK ("balance_links"."recipient" ~ '^[+][1-9][0-9]{7,14}$')
);
--> statement-breakpoint
CREATE TABLE "parent_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"phone" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_agent" text,
	"ip_address" "inet",
	CONSTRAINT "parent_sessions_phone" CHECK ("parent_sessions"."phone" ~ '^[+][1-9][0-9]{7,14}$')
);
--> statement-breakpoint
CREATE TABLE "parent_sign_in_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone" text NOT NULL,
	"code_hash" text NOT NULL,
	"tenant_ids" uuid[] NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"ip_address" "inet",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "parent_sign_in_codes_phone" CHECK ("parent_sign_in_codes"."phone" ~ '^[+][1-9][0-9]{7,14}$')
);
--> statement-breakpoint
ALTER TABLE "guardians" ADD COLUMN "portal_blocked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "guardians" ADD COLUMN "portal_blocked_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "balance_links" ADD CONSTRAINT "balance_links_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "balance_links" ADD CONSTRAINT "balance_links_student_fk" FOREIGN KEY ("tenant_id","student_id") REFERENCES "public"."students"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "balance_links" ADD CONSTRAINT "balance_links_guardian_fk" FOREIGN KEY ("tenant_id","guardian_id") REFERENCES "public"."guardians"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "parent_sessions_phone_idx" ON "parent_sessions" USING btree ("phone");--> statement-breakpoint
CREATE INDEX "parent_sessions_expires_idx" ON "parent_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "parent_sign_in_codes_phone_idx" ON "parent_sign_in_codes" USING btree ("phone","created_at");--> statement-breakpoint
CREATE INDEX "parent_sign_in_codes_created_idx" ON "parent_sign_in_codes" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "guardians" ADD CONSTRAINT "guardians_portal_blocked_by_user_id_users_id_fk" FOREIGN KEY ("portal_blocked_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;