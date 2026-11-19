CREATE TABLE "scheduled_announcements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"audience" text NOT NULL,
	"audience_id" uuid,
	"sms" boolean DEFAULT false NOT NULL,
	"send_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"announcement_id" uuid,
	"note" text,
	"created_by_user_id" uuid NOT NULL,
	"cancelled_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scheduled_announcements_title_length" CHECK (char_length("scheduled_announcements"."title") between 2 and 100),
	CONSTRAINT "scheduled_announcements_body_length" CHECK (char_length("scheduled_announcements"."body") between 1 and 2000),
	CONSTRAINT "scheduled_announcements_audience_id" CHECK (("scheduled_announcements"."audience" = 'school') = ("scheduled_announcements"."audience_id" is null)),
	CONSTRAINT "scheduled_announcements_posted" CHECK (("scheduled_announcements"."status" = 'posted') = ("scheduled_announcements"."announcement_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "scheduled_announcements" ADD CONSTRAINT "scheduled_announcements_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_announcements" ADD CONSTRAINT "scheduled_announcements_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_announcements" ADD CONSTRAINT "scheduled_announcements_cancelled_by_user_id_users_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_announcements" ADD CONSTRAINT "scheduled_announcements_announcement_fk" FOREIGN KEY ("tenant_id","announcement_id") REFERENCES "public"."announcements"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scheduled_announcements_due_idx" ON "scheduled_announcements" USING btree ("status","send_at");