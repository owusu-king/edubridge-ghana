CREATE TABLE "subject_teachers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"class_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"assigned_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subject_teachers_class_subject_unique" UNIQUE("tenant_id","class_id","subject_id")
);
--> statement-breakpoint
ALTER TABLE "school_preferences" ADD COLUMN "curriculum_template" text;--> statement-breakpoint
ALTER TABLE "school_preferences" ADD COLUMN "teaching_model" text DEFAULT 'class' NOT NULL;--> statement-breakpoint
ALTER TABLE "subject_teachers" ADD CONSTRAINT "subject_teachers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_teachers" ADD CONSTRAINT "subject_teachers_assigned_by_user_id_users_id_fk" FOREIGN KEY ("assigned_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_teachers" ADD CONSTRAINT "subject_teachers_class_fk" FOREIGN KEY ("tenant_id","class_id") REFERENCES "public"."classes"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_teachers" ADD CONSTRAINT "subject_teachers_subject_fk" FOREIGN KEY ("tenant_id","subject_id") REFERENCES "public"."subjects"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_teachers" ADD CONSTRAINT "subject_teachers_membership_fk" FOREIGN KEY ("tenant_id","membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "subject_teachers_membership_idx" ON "subject_teachers" USING btree ("tenant_id","membership_id");--> statement-breakpoint
ALTER TABLE "school_preferences" ADD CONSTRAINT "school_preferences_teaching_model" CHECK ("teaching_model" in ('class', 'subject'));
--> statement-breakpoint
ALTER TABLE "school_preferences" ADD CONSTRAINT "school_preferences_curriculum_template" CHECK ("curriculum_template" is null or "curriculum_template" ~ '^[a-z_]{2,40}$');
--> statement-breakpoint
-- Subject teachers: changed and removed by academic staff (every change audited by the service).
GRANT SELECT, INSERT, UPDATE, DELETE ON subject_teachers TO edubridge_app;
--> statement-breakpoint
ALTER TABLE subject_teachers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE subject_teachers FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY subject_teachers_tenant ON subject_teachers
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
