CREATE TABLE "early_warning_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"indicator_key" text NOT NULL,
	"student_id" uuid NOT NULL,
	"rule" text NOT NULL,
	"outcome" text NOT NULL,
	"reason" text NOT NULL,
	"support_plan_id" uuid,
	"reviewed_by_user_id" uuid NOT NULL,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "early_warning_reviews_plan" CHECK (("early_warning_reviews"."outcome" = 'support_plan') = ("early_warning_reviews"."support_plan_id" is not null)),
	CONSTRAINT "early_warning_reviews_lengths" CHECK (char_length("early_warning_reviews"."indicator_key") between 3 and 200 and char_length("early_warning_reviews"."reason") between 3 and 500)
);
--> statement-breakpoint
CREATE TABLE "early_warning_rules" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"attendance_on" boolean DEFAULT true NOT NULL,
	"attendance_percent" integer DEFAULT 85 NOT NULL,
	"attendance_days" integer DEFAULT 28 NOT NULL,
	"absences_on" boolean DEFAULT true NOT NULL,
	"absences_in_a_row" integer DEFAULT 3 NOT NULL,
	"average_on" boolean DEFAULT true NOT NULL,
	"average_drop" integer DEFAULT 10 NOT NULL,
	"subjects_on" boolean DEFAULT true NOT NULL,
	"subjects_count" integer DEFAULT 2 NOT NULL,
	"pass_mark" integer DEFAULT 50 NOT NULL,
	"updated_by_user_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "early_warning_rules_ranges" CHECK ("early_warning_rules"."attendance_percent" between 50 and 100 and "early_warning_rules"."attendance_days" between 7 and 90 and "early_warning_rules"."absences_in_a_row" between 2 and 10 and "early_warning_rules"."average_drop" between 3 and 50 and "early_warning_rules"."subjects_count" between 1 and 10 and "early_warning_rules"."pass_mark" between 20 and 80)
);
--> statement-breakpoint
CREATE TABLE "support_plan_updates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"note" text NOT NULL,
	"review_on" date,
	"by_user_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_plan_updates_note" CHECK (char_length("support_plan_updates"."note") between 3 and 1000)
);
--> statement-breakpoint
CREATE TABLE "support_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"goal" text NOT NULL,
	"actions" text NOT NULL,
	"responsible" text NOT NULL,
	"review_on" date NOT NULL,
	"opened_by_user_id" uuid NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by_user_id" uuid,
	"outcome" text,
	CONSTRAINT "support_plans_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "support_plans_closed" CHECK (("support_plans"."closed_at" is null) = ("support_plans"."closed_by_user_id" is null) and ("support_plans"."closed_at" is null) = ("support_plans"."outcome" is null)),
	CONSTRAINT "support_plans_text_lengths" CHECK (char_length("support_plans"."goal") between 3 and 300 and char_length("support_plans"."actions") between 3 and 1000 and char_length("support_plans"."responsible") between 2 and 120 and coalesce(char_length("support_plans"."outcome"), 3) between 3 and 500)
);
--> statement-breakpoint
ALTER TABLE "early_warning_reviews" ADD CONSTRAINT "early_warning_reviews_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "early_warning_reviews" ADD CONSTRAINT "early_warning_reviews_tenant_id_student_id_students_tenant_id_id_fk" FOREIGN KEY ("tenant_id","student_id") REFERENCES "public"."students"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "early_warning_reviews" ADD CONSTRAINT "early_warning_reviews_tenant_id_support_plan_id_support_plans_tenant_id_id_fk" FOREIGN KEY ("tenant_id","support_plan_id") REFERENCES "public"."support_plans"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "early_warning_rules" ADD CONSTRAINT "early_warning_rules_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "early_warning_rules" ADD CONSTRAINT "early_warning_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_plan_updates" ADD CONSTRAINT "support_plan_updates_by_user_id_users_id_fk" FOREIGN KEY ("by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_plan_updates" ADD CONSTRAINT "support_plan_updates_tenant_id_plan_id_support_plans_tenant_id_id_fk" FOREIGN KEY ("tenant_id","plan_id") REFERENCES "public"."support_plans"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_plans" ADD CONSTRAINT "support_plans_opened_by_user_id_users_id_fk" FOREIGN KEY ("opened_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_plans" ADD CONSTRAINT "support_plans_closed_by_user_id_users_id_fk" FOREIGN KEY ("closed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_plans" ADD CONSTRAINT "support_plans_tenant_id_student_id_students_tenant_id_id_fk" FOREIGN KEY ("tenant_id","student_id") REFERENCES "public"."students"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "early_warning_reviews_key" ON "early_warning_reviews" USING btree ("tenant_id","indicator_key");--> statement-breakpoint
CREATE INDEX "early_warning_reviews_student_idx" ON "early_warning_reviews" USING btree ("tenant_id","student_id");--> statement-breakpoint
CREATE INDEX "support_plan_updates_plan_idx" ON "support_plan_updates" USING btree ("tenant_id","plan_id","at");--> statement-breakpoint
CREATE INDEX "support_plans_student_idx" ON "support_plans" USING btree ("tenant_id","student_id","opened_at");