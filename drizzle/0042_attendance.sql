CREATE TABLE "attendance_changes" (
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
CREATE TABLE "attendance_marks" (
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
	CONSTRAINT "attendance_marks_register_student_unique" UNIQUE("register_id","student_id"),
	CONSTRAINT "attendance_marks_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "attendance_marks_reason_length" CHECK (coalesce(char_length("attendance_marks"."reason"), 0) <= 120),
	CONSTRAINT "attendance_marks_version" CHECK ("attendance_marks"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "attendance_registers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"class_id" uuid NOT NULL,
	"term_id" uuid NOT NULL,
	"date" date NOT NULL,
	"taken_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attendance_registers_class_date_unique" UNIQUE("tenant_id","class_id","date"),
	CONSTRAINT "attendance_registers_tenant_id_unique" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "attendance_changes" ADD CONSTRAINT "attendance_changes_changed_by_user_id_users_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_changes" ADD CONSTRAINT "attendance_changes_mark_fk" FOREIGN KEY ("tenant_id","mark_id") REFERENCES "public"."attendance_marks"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_marks" ADD CONSTRAINT "attendance_marks_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_marks" ADD CONSTRAINT "attendance_marks_register_fk" FOREIGN KEY ("tenant_id","register_id") REFERENCES "public"."attendance_registers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_marks" ADD CONSTRAINT "attendance_marks_student_fk" FOREIGN KEY ("tenant_id","student_id") REFERENCES "public"."students"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_registers" ADD CONSTRAINT "attendance_registers_taken_by_user_id_users_id_fk" FOREIGN KEY ("taken_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_registers" ADD CONSTRAINT "attendance_registers_class_fk" FOREIGN KEY ("tenant_id","class_id") REFERENCES "public"."classes"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_registers" ADD CONSTRAINT "attendance_registers_term_fk" FOREIGN KEY ("tenant_id","term_id") REFERENCES "public"."terms"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attendance_changes_mark_idx" ON "attendance_changes" USING btree ("tenant_id","mark_id");--> statement-breakpoint
CREATE INDEX "attendance_marks_student_idx" ON "attendance_marks" USING btree ("tenant_id","student_id");--> statement-breakpoint
CREATE INDEX "attendance_registers_term_idx" ON "attendance_registers" USING btree ("tenant_id","term_id");