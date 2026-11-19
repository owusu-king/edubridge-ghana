CREATE TABLE "application_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"note" text,
	"actor_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_events_note_length" CHECK (coalesce(char_length("application_events"."note"), 0) <= 500)
);
--> statement-breakpoint
CREATE TABLE "application_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"phone" text NOT NULL,
	"code_hash" text NOT NULL,
	"draft" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"ip_address" "inet",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_verifications_phone" CHECK ("application_verifications"."phone" ~ '^[+][1-9][0-9]{7,14}$')
);
--> statement-breakpoint
CREATE TABLE "applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"status" text DEFAULT 'inquiry' NOT NULL,
	"source" text NOT NULL,
	"child_first_name" text,
	"child_other_names" text,
	"child_last_name" text,
	"sex" text,
	"date_of_birth" date,
	"previous_school" text,
	"level_id" uuid NOT NULL,
	"entry_term_id" uuid,
	"guardian_name" text,
	"guardian_phone" text,
	"guardian_email" text,
	"guardian_relationship" text,
	"notes" text,
	"assessment_at" timestamp with time zone,
	"assessment_note" text,
	"offered_at" timestamp with time zone,
	"offer_class_id" uuid,
	"offer_respond_by" date,
	"offer_fees" jsonb,
	"closed_at" timestamp with time zone,
	"student_id" uuid,
	"erased_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "applications_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "applications_reference_unique" UNIQUE("tenant_id","reference"),
	CONSTRAINT "applications_student_unique" UNIQUE("tenant_id","student_id"),
	CONSTRAINT "applications_personal_details" CHECK ("applications"."erased_at" is not null or ("applications"."child_first_name" is not null and "applications"."child_last_name" is not null and "applications"."guardian_name" is not null)),
	CONSTRAINT "applications_text_lengths" CHECK (coalesce(char_length("applications"."child_first_name"), 0) <= 60 and coalesce(char_length("applications"."child_other_names"), 0) <= 60 and coalesce(char_length("applications"."child_last_name"), 0) <= 60 and coalesce(char_length("applications"."guardian_name"), 0) <= 120 and coalesce(char_length("applications"."previous_school"), 0) <= 120 and coalesce(char_length("applications"."notes"), 0) <= 1000 and coalesce(char_length("applications"."assessment_note"), 0) <= 500),
	CONSTRAINT "applications_phone" CHECK ("applications"."guardian_phone" is null or "applications"."guardian_phone" ~ '^[+][1-9][0-9]{7,14}$'),
	CONSTRAINT "applications_enrolled_student" CHECK (("applications"."status" = 'enrolled') = ("applications"."student_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "school_preferences" ADD COLUMN "online_applications" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "school_preferences" ADD COLUMN "admission_fees" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "application_events" ADD CONSTRAINT "application_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_events" ADD CONSTRAINT "application_events_application_fk" FOREIGN KEY ("tenant_id","application_id") REFERENCES "public"."applications"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_verifications" ADD CONSTRAINT "application_verifications_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_level_fk" FOREIGN KEY ("tenant_id","level_id") REFERENCES "public"."levels"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_term_fk" FOREIGN KEY ("tenant_id","entry_term_id") REFERENCES "public"."terms"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_class_fk" FOREIGN KEY ("tenant_id","offer_class_id") REFERENCES "public"."classes"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_student_fk" FOREIGN KEY ("tenant_id","student_id") REFERENCES "public"."students"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "application_events_application_idx" ON "application_events" USING btree ("tenant_id","application_id","created_at");--> statement-breakpoint
CREATE INDEX "application_verifications_phone_idx" ON "application_verifications" USING btree ("tenant_id","phone","created_at");--> statement-breakpoint
CREATE INDEX "application_verifications_created_idx" ON "application_verifications" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "applications_status_idx" ON "applications" USING btree ("tenant_id","status","created_at");--> statement-breakpoint
CREATE INDEX "applications_phone_idx" ON "applications" USING btree ("tenant_id","guardian_phone");