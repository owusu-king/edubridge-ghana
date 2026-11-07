CREATE TABLE "support_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"granted_by_user_id" uuid NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"ended_by_user_id" uuid,
	CONSTRAINT "support_grants_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "support_grants_note_length" CHECK (char_length("support_grants"."note") <= 300),
	CONSTRAINT "support_grants_duration" CHECK ("support_grants"."expires_at" > "support_grants"."created_at" and "support_grants"."expires_at" <= "support_grants"."created_at" + interval '7 days')
);
--> statement-breakpoint
CREATE TABLE "support_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"path" text NOT NULL,
	"kind" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "support_grant_id" uuid DEFAULT nullif(current_setting('app.support_grant_id', true), '')::uuid;--> statement-breakpoint
ALTER TABLE "support_grants" ADD CONSTRAINT "support_grants_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_grants" ADD CONSTRAINT "support_grants_granted_by_user_id_users_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_grants" ADD CONSTRAINT "support_grants_ended_by_user_id_users_id_fk" FOREIGN KEY ("ended_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_views" ADD CONSTRAINT "support_views_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_views" ADD CONSTRAINT "support_views_grant_fk" FOREIGN KEY ("tenant_id","grant_id") REFERENCES "public"."support_grants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "support_grants_tenant_time_idx" ON "support_grants" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "support_views_grant_time_idx" ON "support_views" USING btree ("tenant_id","grant_id","at");