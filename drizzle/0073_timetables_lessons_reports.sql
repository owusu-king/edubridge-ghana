CREATE TABLE "lesson_mark_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"mark_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"from_reason" text,
	"to_reason" text,
	"version" integer NOT NULL,
	"source" text NOT NULL,
	"recorded_on_device_at" timestamp with time zone,
	"changed_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lesson_marks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"register_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"version" integer DEFAULT 1 NOT NULL,
	"recorded_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lesson_marks_register_student_unique" UNIQUE("register_id","student_id"),
	CONSTRAINT "lesson_marks_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "lesson_marks_reason_length" CHECK (coalesce(char_length("lesson_marks"."reason"), 0) <= 120),
	CONSTRAINT "lesson_marks_version" CHECK ("lesson_marks"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "lesson_registers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"class_id" uuid NOT NULL,
	"term_id" uuid NOT NULL,
	"date" date NOT NULL,
	"period_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"teacher_membership_id" uuid,
	"taken_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lesson_registers_slot_unique" UNIQUE("tenant_id","class_id","date","period_id"),
	CONSTRAINT "lesson_registers_tenant_id_unique" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "subject_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"term_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"comment" text NOT NULL,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subject_comments_unique" UNIQUE("tenant_id","term_id","student_id","subject_id"),
	CONSTRAINT "subject_comments_length" CHECK (char_length("subject_comments"."comment") between 1 and 400)
);
--> statement-breakpoint
CREATE TABLE "timetable_lessons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"term_id" uuid NOT NULL,
	"class_id" uuid NOT NULL,
	"weekday" integer NOT NULL,
	"period_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"membership_id" uuid,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "timetable_lessons_slot_unique" UNIQUE("tenant_id","term_id","class_id","weekday","period_id"),
	CONSTRAINT "timetable_lessons_weekday" CHECK ("timetable_lessons"."weekday" between 1 and 7)
);
--> statement-breakpoint
CREATE TABLE "timetable_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" "citext" NOT NULL,
	"starts_at" text NOT NULL,
	"ends_at" text NOT NULL,
	"kind" text DEFAULT 'lesson' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "timetable_periods_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "timetable_periods_name_unique" UNIQUE("tenant_id","name"),
	CONSTRAINT "timetable_periods_name_length" CHECK (char_length("timetable_periods"."name") between 1 and 40),
	CONSTRAINT "timetable_periods_times" CHECK ("timetable_periods"."starts_at" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' and "timetable_periods"."ends_at" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' and "timetable_periods"."ends_at" > "timetable_periods"."starts_at")
);
--> statement-breakpoint
ALTER TABLE "school_preferences" ADD COLUMN "report_card_style" text;--> statement-breakpoint
ALTER TABLE "school_preferences" ADD COLUMN "lesson_attendance" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "lesson_mark_changes" ADD CONSTRAINT "lesson_mark_changes_changed_by_user_id_users_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_mark_changes" ADD CONSTRAINT "lesson_mark_changes_mark_fk" FOREIGN KEY ("tenant_id","mark_id") REFERENCES "public"."lesson_marks"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_marks" ADD CONSTRAINT "lesson_marks_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_marks" ADD CONSTRAINT "lesson_marks_register_fk" FOREIGN KEY ("tenant_id","register_id") REFERENCES "public"."lesson_registers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_marks" ADD CONSTRAINT "lesson_marks_student_fk" FOREIGN KEY ("tenant_id","student_id") REFERENCES "public"."students"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_registers" ADD CONSTRAINT "lesson_registers_taken_by_user_id_users_id_fk" FOREIGN KEY ("taken_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_registers" ADD CONSTRAINT "lesson_registers_class_fk" FOREIGN KEY ("tenant_id","class_id") REFERENCES "public"."classes"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_registers" ADD CONSTRAINT "lesson_registers_term_fk" FOREIGN KEY ("tenant_id","term_id") REFERENCES "public"."terms"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_registers" ADD CONSTRAINT "lesson_registers_period_fk" FOREIGN KEY ("tenant_id","period_id") REFERENCES "public"."timetable_periods"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_registers" ADD CONSTRAINT "lesson_registers_subject_fk" FOREIGN KEY ("tenant_id","subject_id") REFERENCES "public"."subjects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_registers" ADD CONSTRAINT "lesson_registers_teacher_fk" FOREIGN KEY ("tenant_id","teacher_membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_comments" ADD CONSTRAINT "subject_comments_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_comments" ADD CONSTRAINT "subject_comments_term_fk" FOREIGN KEY ("tenant_id","term_id") REFERENCES "public"."terms"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_comments" ADD CONSTRAINT "subject_comments_student_fk" FOREIGN KEY ("tenant_id","student_id") REFERENCES "public"."students"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_comments" ADD CONSTRAINT "subject_comments_subject_fk" FOREIGN KEY ("tenant_id","subject_id") REFERENCES "public"."subjects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_lessons" ADD CONSTRAINT "timetable_lessons_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_lessons" ADD CONSTRAINT "timetable_lessons_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_lessons" ADD CONSTRAINT "timetable_lessons_term_fk" FOREIGN KEY ("tenant_id","term_id") REFERENCES "public"."terms"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_lessons" ADD CONSTRAINT "timetable_lessons_class_fk" FOREIGN KEY ("tenant_id","class_id") REFERENCES "public"."classes"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_lessons" ADD CONSTRAINT "timetable_lessons_period_fk" FOREIGN KEY ("tenant_id","period_id") REFERENCES "public"."timetable_periods"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_lessons" ADD CONSTRAINT "timetable_lessons_subject_fk" FOREIGN KEY ("tenant_id","subject_id") REFERENCES "public"."subjects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_lessons" ADD CONSTRAINT "timetable_lessons_membership_fk" FOREIGN KEY ("tenant_id","membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_periods" ADD CONSTRAINT "timetable_periods_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lesson_mark_changes_mark_idx" ON "lesson_mark_changes" USING btree ("tenant_id","mark_id");--> statement-breakpoint
CREATE INDEX "lesson_marks_student_idx" ON "lesson_marks" USING btree ("tenant_id","student_id");--> statement-breakpoint
CREATE INDEX "lesson_registers_term_idx" ON "lesson_registers" USING btree ("tenant_id","term_id","subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "timetable_lessons_teacher_slot_unique" ON "timetable_lessons" USING btree ("tenant_id","term_id","membership_id","weekday","period_id") WHERE "timetable_lessons"."membership_id" is not null;