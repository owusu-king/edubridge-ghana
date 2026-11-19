CREATE TABLE "consent_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"form_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"guardian_id" uuid NOT NULL,
	"answer" text NOT NULL,
	"note" text,
	"source" text NOT NULL,
	"phone" text,
	"recorded_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consent_answers_note_length" CHECK (coalesce(char_length("consent_answers"."note"), 0) <= 300),
	CONSTRAINT "consent_answers_source" CHECK (("consent_answers"."source" = 'parent_view' and "consent_answers"."phone" ~ '^[+][1-9][0-9]{7,14}$' and "consent_answers"."recorded_by_user_id" is null) or ("consent_answers"."source" = 'office' and "consent_answers"."phone" is null and "consent_answers"."recorded_by_user_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "consent_forms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"event_id" uuid,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"deadline" date NOT NULL,
	"audience" text NOT NULL,
	"audience_id" uuid,
	"sms_count" integer DEFAULT 0 NOT NULL,
	"push_count" integer DEFAULT 0 NOT NULL,
	"last_reminded_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancelled_by_user_id" uuid,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consent_forms_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "consent_forms_title_length" CHECK (char_length("consent_forms"."title") between 2 and 100),
	CONSTRAINT "consent_forms_body_length" CHECK (char_length("consent_forms"."body") between 1 and 4000),
	CONSTRAINT "consent_forms_audience_id" CHECK (("consent_forms"."audience" = 'school') = ("consent_forms"."audience_id" is null))
);
--> statement-breakpoint
CREATE TABLE "school_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"title" text NOT NULL,
	"details" text,
	"location" text,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"start_time" text,
	"end_time" text,
	"audience" text NOT NULL,
	"audience_id" uuid,
	"reminder" text DEFAULT 'none' NOT NULL,
	"reminder_days_before" integer DEFAULT 1 NOT NULL,
	"reminded_at" timestamp with time zone,
	"reminder_sms_count" integer DEFAULT 0 NOT NULL,
	"reminder_push_count" integer DEFAULT 0 NOT NULL,
	"cancelled_at" timestamp with time zone,
	"cancelled_by_user_id" uuid,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "school_events_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "school_events_title_length" CHECK (char_length("school_events"."title") between 2 and 100),
	CONSTRAINT "school_events_text_lengths" CHECK (coalesce(char_length("school_events"."details"), 0) <= 2000 and coalesce(char_length("school_events"."location"), 0) <= 120),
	CONSTRAINT "school_events_dates" CHECK ("school_events"."ends_on" >= "school_events"."starts_on" and "school_events"."ends_on" - "school_events"."starts_on" <= 60),
	CONSTRAINT "school_events_times" CHECK (("school_events"."start_time" is null or "school_events"."start_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') and ("school_events"."end_time" is null or ("school_events"."start_time" is not null and "school_events"."end_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' and ("school_events"."ends_on" > "school_events"."starts_on" or "school_events"."end_time" > "school_events"."start_time")))),
	CONSTRAINT "school_events_audience_id" CHECK (("school_events"."audience" = 'school') = ("school_events"."audience_id" is null)),
	CONSTRAINT "school_events_reminder_days" CHECK ("school_events"."reminder_days_before" between 1 and 14)
);
--> statement-breakpoint
ALTER TABLE "consent_answers" ADD CONSTRAINT "consent_answers_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_answers" ADD CONSTRAINT "consent_answers_form_fk" FOREIGN KEY ("tenant_id","form_id") REFERENCES "public"."consent_forms"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_answers" ADD CONSTRAINT "consent_answers_student_fk" FOREIGN KEY ("tenant_id","student_id") REFERENCES "public"."students"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_answers" ADD CONSTRAINT "consent_answers_guardian_fk" FOREIGN KEY ("tenant_id","guardian_id") REFERENCES "public"."guardians"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_forms" ADD CONSTRAINT "consent_forms_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_forms" ADD CONSTRAINT "consent_forms_cancelled_by_user_id_users_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_forms" ADD CONSTRAINT "consent_forms_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_forms" ADD CONSTRAINT "consent_forms_event_fk" FOREIGN KEY ("tenant_id","event_id") REFERENCES "public"."school_events"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "school_events" ADD CONSTRAINT "school_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "school_events" ADD CONSTRAINT "school_events_cancelled_by_user_id_users_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "school_events" ADD CONSTRAINT "school_events_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "consent_answers_form_idx" ON "consent_answers" USING btree ("tenant_id","form_id","student_id","created_at");--> statement-breakpoint
CREATE INDEX "consent_forms_tenant_idx" ON "consent_forms" USING btree ("tenant_id","deadline");--> statement-breakpoint
CREATE INDEX "school_events_tenant_idx" ON "school_events" USING btree ("tenant_id","starts_on");