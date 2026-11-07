CREATE TABLE "announcement_reads" (
	"tenant_id" uuid NOT NULL,
	"announcement_id" uuid NOT NULL,
	"phone" text NOT NULL,
	"read_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "announcement_reads_announcement_id_phone_pk" PRIMARY KEY("announcement_id","phone")
);
--> statement-breakpoint
CREATE TABLE "announcements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"audience" text NOT NULL,
	"audience_id" uuid,
	"sms_count" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "announcements_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "announcements_title_length" CHECK (char_length("announcements"."title") between 2 and 100),
	CONSTRAINT "announcements_body_length" CHECK (char_length("announcements"."body") between 1 and 2000),
	CONSTRAINT "announcements_audience_id" CHECK (("announcements"."audience" = 'school') = ("announcements"."audience_id" is null))
);
--> statement-breakpoint
ALTER TABLE "school_preferences" ADD COLUMN "payment_receipt_sms" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "school_preferences" ADD COLUMN "auto_reminders_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "school_preferences" ADD COLUMN "auto_reminder_interval_days" integer DEFAULT 14 NOT NULL;--> statement-breakpoint
ALTER TABLE "school_preferences" ADD COLUMN "auto_reminder_min_pesewas" bigint DEFAULT 10000 NOT NULL;--> statement-breakpoint
ALTER TABLE "school_preferences" ADD COLUMN "auto_reminders_last_run_on" date;--> statement-breakpoint
ALTER TABLE "school_preferences" ADD COLUMN "contact_phone" text;--> statement-breakpoint
ALTER TABLE "school_preferences" ADD COLUMN "contact_email" text;--> statement-breakpoint
ALTER TABLE "school_preferences" ADD COLUMN "contact_whatsapp" text;--> statement-breakpoint
ALTER TABLE "school_preferences" ADD COLUMN "office_hours" text;--> statement-breakpoint
ALTER TABLE "sms_usage" ADD COLUMN "student_id" uuid;--> statement-breakpoint
ALTER TABLE "announcement_reads" ADD CONSTRAINT "announcement_reads_announcement_fk" FOREIGN KEY ("tenant_id","announcement_id") REFERENCES "public"."announcements"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "announcements_tenant_idx" ON "announcements" USING btree ("tenant_id","created_at");--> statement-breakpoint
ALTER TABLE "school_preferences" ADD CONSTRAINT "school_preferences_reminder_interval" CHECK ("school_preferences"."auto_reminder_interval_days" between 7 and 90);--> statement-breakpoint
ALTER TABLE "school_preferences" ADD CONSTRAINT "school_preferences_reminder_min" CHECK ("school_preferences"."auto_reminder_min_pesewas" between 0 and 1000000000);--> statement-breakpoint
ALTER TABLE "school_preferences" ADD CONSTRAINT "school_preferences_office_hours" CHECK ("school_preferences"."office_hours" is null or char_length("school_preferences"."office_hours") <= 120);