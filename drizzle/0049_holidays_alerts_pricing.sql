CREATE TABLE "absence_alert_settings" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"consecutive_days" integer,
	"term_days" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" uuid,
	CONSTRAINT "absence_alert_settings_consecutive" CHECK ("absence_alert_settings"."consecutive_days" is null or "absence_alert_settings"."consecutive_days" between 1 and 30),
	CONSTRAINT "absence_alert_settings_term" CHECK ("absence_alert_settings"."term_days" is null or "absence_alert_settings"."term_days" between 1 and 100),
	CONSTRAINT "absence_alert_settings_some_rule" CHECK (not "absence_alert_settings"."enabled" or "absence_alert_settings"."consecutive_days" is not null or "absence_alert_settings"."term_days" is not null)
);
--> statement-breakpoint
CREATE TABLE "absence_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"term_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"days" integer NOT NULL,
	"guardian_id" uuid,
	"recipient" text NOT NULL,
	"outbox_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "absence_alerts_once" UNIQUE("tenant_id","student_id","term_id","kind","key")
);
--> statement-breakpoint
CREATE TABLE "platform_settings" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"sms_price_pesewas" bigint,
	"grace_days" integer DEFAULT 3 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" uuid,
	CONSTRAINT "platform_settings_single_row" CHECK ("platform_settings"."id"),
	CONSTRAINT "platform_settings_grace_range" CHECK ("platform_settings"."grace_days" between 0 and 60),
	CONSTRAINT "platform_settings_sms_price_range" CHECK ("platform_settings"."sms_price_pesewas" is null or "platform_settings"."sms_price_pesewas" between 0 and 100000)
);
--> statement-breakpoint
CREATE TABLE "school_holidays" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "school_holidays_dates" CHECK ("school_holidays"."ends_on" >= "school_holidays"."starts_on"),
	CONSTRAINT "school_holidays_span" CHECK ("school_holidays"."ends_on" - "school_holidays"."starts_on" <= 60),
	CONSTRAINT "school_holidays_name_length" CHECK (char_length("school_holidays"."name") between 2 and 80)
);
--> statement-breakpoint
ALTER TABLE "tenant_entitlements" ADD COLUMN "sms_price_pesewas" bigint;--> statement-breakpoint
ALTER TABLE "absence_alert_settings" ADD CONSTRAINT "absence_alert_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "absence_alert_settings" ADD CONSTRAINT "absence_alert_settings_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "absence_alerts" ADD CONSTRAINT "absence_alerts_outbox_id_notification_outbox_id_fk" FOREIGN KEY ("outbox_id") REFERENCES "public"."notification_outbox"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "absence_alerts" ADD CONSTRAINT "absence_alerts_student_fk" FOREIGN KEY ("tenant_id","student_id") REFERENCES "public"."students"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "absence_alerts" ADD CONSTRAINT "absence_alerts_term_fk" FOREIGN KEY ("tenant_id","term_id") REFERENCES "public"."terms"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD CONSTRAINT "platform_settings_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "school_holidays" ADD CONSTRAINT "school_holidays_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "school_holidays" ADD CONSTRAINT "school_holidays_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "absence_alerts_student_idx" ON "absence_alerts" USING btree ("tenant_id","student_id");--> statement-breakpoint
CREATE INDEX "school_holidays_tenant_idx" ON "school_holidays" USING btree ("tenant_id","starts_on");--> statement-breakpoint
ALTER TABLE "tenant_entitlements" ADD CONSTRAINT "tenant_entitlements_sms_price_range" CHECK ("tenant_entitlements"."sms_price_pesewas" is null or "tenant_entitlements"."sms_price_pesewas" between 0 and 100000);