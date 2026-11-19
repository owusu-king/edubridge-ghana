CREATE TABLE "leave_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"leave_type_id" uuid NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"days" integer NOT NULL,
	"reason" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"cancelled_by_user_id" uuid,
	"cancelled_at" timestamp with time zone,
	CONSTRAINT "leave_requests_dates" CHECK ("leave_requests"."ends_on" >= "leave_requests"."starts_on"),
	CONSTRAINT "leave_requests_days" CHECK ("leave_requests"."days" between 1 and 366),
	CONSTRAINT "leave_requests_text_lengths" CHECK (coalesce(char_length("leave_requests"."reason"), 0) <= 300 and coalesce(char_length("leave_requests"."decision_note"), 0) <= 300),
	CONSTRAINT "leave_requests_cancelled" CHECK (("leave_requests"."status" = 'cancelled') = ("leave_requests"."cancelled_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "leave_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" "citext" NOT NULL,
	"days_per_year" integer,
	"paid" boolean DEFAULT true NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "leave_types_tenant_name_unique" UNIQUE("tenant_id","name"),
	CONSTRAINT "leave_types_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "leave_types_name_length" CHECK (char_length("leave_types"."name") between 2 and 60),
	CONSTRAINT "leave_types_days" CHECK ("leave_types"."days_per_year" is null or "leave_types"."days_per_year" between 0 and 366)
);
--> statement-breakpoint
CREATE TABLE "staff" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"staff_number" "citext" NOT NULL,
	"membership_id" uuid,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"other_names" text,
	"sex" text,
	"date_of_birth" date,
	"phone" text,
	"email" "citext",
	"address" text,
	"qualifications" text,
	"emergency_name" text,
	"emergency_relationship" text,
	"emergency_phone" text,
	"employment_type" text NOT NULL,
	"department_id" uuid,
	"position_id" uuid,
	"campus_id" uuid,
	"started_on" date NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"left_on" date,
	"leaving_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_tenant_number_unique" UNIQUE("tenant_id","staff_number"),
	CONSTRAINT "staff_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "staff_names" CHECK (char_length("staff"."first_name") between 1 and 80 and char_length("staff"."last_name") between 1 and 80),
	CONSTRAINT "staff_phone" CHECK ("staff"."phone" is null or "staff"."phone" ~ '^[+][1-9][0-9]{7,14}$'),
	CONSTRAINT "staff_emergency_phone" CHECK ("staff"."emergency_phone" is null or "staff"."emergency_phone" ~ '^[+][1-9][0-9]{7,14}$'),
	CONSTRAINT "staff_left" CHECK (("staff"."status" = 'active' and "staff"."left_on" is null and "staff"."leaving_reason" is null) or ("staff"."status" = 'left' and "staff"."left_on" is not null)),
	CONSTRAINT "staff_text_lengths" CHECK (coalesce(char_length("staff"."address"), 0) <= 300 and coalesce(char_length("staff"."qualifications"), 0) <= 500 and coalesce(char_length("staff"."leaving_reason"), 0) <= 300)
);
--> statement-breakpoint
CREATE TABLE "staff_attendance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"date" date NOT NULL,
	"status" text NOT NULL,
	"note" text,
	"version" integer DEFAULT 1 NOT NULL,
	"recorded_by_user_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_attendance_one_a_day" UNIQUE("tenant_id","staff_id","date"),
	CONSTRAINT "staff_attendance_note_length" CHECK (coalesce(char_length("staff_attendance"."note"), 0) <= 200),
	CONSTRAINT "staff_attendance_version" CHECK ("staff_attendance"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "staff_departments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" "citext" NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_departments_tenant_name_unique" UNIQUE("tenant_id","name"),
	CONSTRAINT "staff_departments_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "staff_departments_name_length" CHECK (char_length("staff_departments"."name") between 2 and 80)
);
--> statement-breakpoint
CREATE TABLE "staff_employment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"effective_on" date NOT NULL,
	"employment_type" text NOT NULL,
	"department_id" uuid,
	"position_id" uuid,
	"campus_id" uuid,
	"note" text,
	"recorded_by_user_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_employment_events_note_length" CHECK (coalesce(char_length("staff_employment_events"."note"), 0) <= 300)
);
--> statement-breakpoint
CREATE TABLE "staff_positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" "citext" NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_positions_tenant_name_unique" UNIQUE("tenant_id","name"),
	CONSTRAINT "staff_positions_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "staff_positions_name_length" CHECK (char_length("staff_positions"."name") between 2 and 80)
);
--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_cancelled_by_user_id_users_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_tenant_id_staff_id_staff_tenant_id_id_fk" FOREIGN KEY ("tenant_id","staff_id") REFERENCES "public"."staff"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_tenant_id_leave_type_id_leave_types_tenant_id_id_fk" FOREIGN KEY ("tenant_id","leave_type_id") REFERENCES "public"."leave_types"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_types" ADD CONSTRAINT "leave_types_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff" ADD CONSTRAINT "staff_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff" ADD CONSTRAINT "staff_tenant_id_membership_id_memberships_tenant_id_id_fk" FOREIGN KEY ("tenant_id","membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff" ADD CONSTRAINT "staff_tenant_id_department_id_staff_departments_tenant_id_id_fk" FOREIGN KEY ("tenant_id","department_id") REFERENCES "public"."staff_departments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff" ADD CONSTRAINT "staff_tenant_id_position_id_staff_positions_tenant_id_id_fk" FOREIGN KEY ("tenant_id","position_id") REFERENCES "public"."staff_positions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff" ADD CONSTRAINT "staff_tenant_id_campus_id_campuses_tenant_id_id_fk" FOREIGN KEY ("tenant_id","campus_id") REFERENCES "public"."campuses"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_attendance" ADD CONSTRAINT "staff_attendance_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_attendance" ADD CONSTRAINT "staff_attendance_tenant_id_staff_id_staff_tenant_id_id_fk" FOREIGN KEY ("tenant_id","staff_id") REFERENCES "public"."staff"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_departments" ADD CONSTRAINT "staff_departments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_employment_events" ADD CONSTRAINT "staff_employment_events_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_employment_events" ADD CONSTRAINT "staff_employment_events_tenant_id_staff_id_staff_tenant_id_id_fk" FOREIGN KEY ("tenant_id","staff_id") REFERENCES "public"."staff"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_positions" ADD CONSTRAINT "staff_positions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "leave_requests_staff_idx" ON "leave_requests" USING btree ("tenant_id","staff_id","starts_on");--> statement-breakpoint
CREATE INDEX "leave_requests_status_idx" ON "leave_requests" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_one_per_membership" ON "staff" USING btree ("tenant_id","membership_id") WHERE "staff"."membership_id" is not null;--> statement-breakpoint
CREATE INDEX "staff_tenant_name_idx" ON "staff" USING btree ("tenant_id","last_name","first_name");--> statement-breakpoint
CREATE INDEX "staff_attendance_date_idx" ON "staff_attendance" USING btree ("tenant_id","date");--> statement-breakpoint
CREATE INDEX "staff_employment_events_staff_idx" ON "staff_employment_events" USING btree ("tenant_id","staff_id","effective_on");