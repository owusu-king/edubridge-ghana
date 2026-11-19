CREATE TABLE "boarding_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"term_id" uuid NOT NULL,
	"bed_id" uuid NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"ended_by_user_id" uuid,
	CONSTRAINT "boarding_assignments_ended" CHECK (("boarding_assignments"."ended_at" is null) = ("boarding_assignments"."ended_by_user_id" is null))
);
--> statement-breakpoint
CREATE TABLE "boarding_beds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"label" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "boarding_beds_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "boarding_beds_room_label_unique" UNIQUE("tenant_id","room_id","label"),
	CONSTRAINT "boarding_beds_label" CHECK (char_length("boarding_beds"."label") between 1 and 30)
);
--> statement-breakpoint
CREATE TABLE "boarding_exeats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"house_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"collected_by" text NOT NULL,
	"expected_back_on" date NOT NULL,
	"out_at" timestamp with time zone DEFAULT now() NOT NULL,
	"out_by_user_id" uuid NOT NULL,
	"back_at" timestamp with time zone,
	"back_by_user_id" uuid,
	"note" text,
	CONSTRAINT "boarding_exeats_back" CHECK (("boarding_exeats"."back_at" is null) = ("boarding_exeats"."back_by_user_id" is null)),
	CONSTRAINT "boarding_exeats_text_lengths" CHECK (char_length("boarding_exeats"."reason") between 3 and 300 and char_length("boarding_exeats"."collected_by") between 2 and 120 and coalesce(char_length("boarding_exeats"."note"), 0) <= 300)
);
--> statement-breakpoint
CREATE TABLE "boarding_house_staff" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"house_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"added_by_user_id" uuid NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"ended_by_user_id" uuid,
	CONSTRAINT "boarding_house_staff_ended" CHECK (("boarding_house_staff"."ended_at" is null) = ("boarding_house_staff"."ended_by_user_id" is null))
);
--> statement-breakpoint
CREATE TABLE "boarding_houses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" "citext" NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "boarding_houses_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "boarding_houses_tenant_name_unique" UNIQUE("tenant_id","name"),
	CONSTRAINT "boarding_houses_name" CHECK (char_length("boarding_houses"."name") between 1 and 60)
);
--> statement-breakpoint
CREATE TABLE "boarding_rooms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"house_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "boarding_rooms_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "boarding_rooms_house_name_unique" UNIQUE("tenant_id","house_id","name"),
	CONSTRAINT "boarding_rooms_name" CHECK (char_length("boarding_rooms"."name") between 1 and 60)
);
--> statement-breakpoint
CREATE TABLE "boarding_settings" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"fee_item_id" uuid,
	"updated_by_user_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "boarding_assignments" ADD CONSTRAINT "boarding_assignments_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boarding_assignments" ADD CONSTRAINT "boarding_assignments_ended_by_user_id_users_id_fk" FOREIGN KEY ("ended_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boarding_assignments" ADD CONSTRAINT "boarding_assignments_tenant_id_student_id_students_tenant_id_id_fk" FOREIGN KEY ("tenant_id","student_id") REFERENCES "public"."students"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boarding_assignments" ADD CONSTRAINT "boarding_assignments_tenant_id_term_id_terms_tenant_id_id_fk" FOREIGN KEY ("tenant_id","term_id") REFERENCES "public"."terms"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boarding_assignments" ADD CONSTRAINT "boarding_assignments_tenant_id_bed_id_boarding_beds_tenant_id_id_fk" FOREIGN KEY ("tenant_id","bed_id") REFERENCES "public"."boarding_beds"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boarding_beds" ADD CONSTRAINT "boarding_beds_tenant_id_room_id_boarding_rooms_tenant_id_id_fk" FOREIGN KEY ("tenant_id","room_id") REFERENCES "public"."boarding_rooms"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boarding_exeats" ADD CONSTRAINT "boarding_exeats_out_by_user_id_users_id_fk" FOREIGN KEY ("out_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boarding_exeats" ADD CONSTRAINT "boarding_exeats_back_by_user_id_users_id_fk" FOREIGN KEY ("back_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boarding_exeats" ADD CONSTRAINT "boarding_exeats_tenant_id_student_id_students_tenant_id_id_fk" FOREIGN KEY ("tenant_id","student_id") REFERENCES "public"."students"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boarding_exeats" ADD CONSTRAINT "boarding_exeats_tenant_id_house_id_boarding_houses_tenant_id_id_fk" FOREIGN KEY ("tenant_id","house_id") REFERENCES "public"."boarding_houses"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boarding_house_staff" ADD CONSTRAINT "boarding_house_staff_added_by_user_id_users_id_fk" FOREIGN KEY ("added_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boarding_house_staff" ADD CONSTRAINT "boarding_house_staff_ended_by_user_id_users_id_fk" FOREIGN KEY ("ended_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boarding_house_staff" ADD CONSTRAINT "boarding_house_staff_tenant_id_house_id_boarding_houses_tenant_id_id_fk" FOREIGN KEY ("tenant_id","house_id") REFERENCES "public"."boarding_houses"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boarding_house_staff" ADD CONSTRAINT "boarding_house_staff_tenant_id_membership_id_memberships_tenant_id_id_fk" FOREIGN KEY ("tenant_id","membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boarding_houses" ADD CONSTRAINT "boarding_houses_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boarding_rooms" ADD CONSTRAINT "boarding_rooms_tenant_id_house_id_boarding_houses_tenant_id_id_fk" FOREIGN KEY ("tenant_id","house_id") REFERENCES "public"."boarding_houses"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boarding_settings" ADD CONSTRAINT "boarding_settings_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boarding_settings" ADD CONSTRAINT "boarding_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boarding_settings" ADD CONSTRAINT "boarding_settings_tenant_id_fee_item_id_fee_items_tenant_id_id_fk" FOREIGN KEY ("tenant_id","fee_item_id") REFERENCES "public"."fee_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "boarding_assignments_one_bed_per_student" ON "boarding_assignments" USING btree ("tenant_id","student_id","term_id") WHERE "boarding_assignments"."ended_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "boarding_assignments_one_student_per_bed" ON "boarding_assignments" USING btree ("tenant_id","bed_id","term_id") WHERE "boarding_assignments"."ended_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "boarding_exeats_one_open" ON "boarding_exeats" USING btree ("tenant_id","student_id") WHERE "boarding_exeats"."back_at" is null;--> statement-breakpoint
CREATE INDEX "boarding_exeats_house_idx" ON "boarding_exeats" USING btree ("tenant_id","house_id","out_at");--> statement-breakpoint
CREATE UNIQUE INDEX "boarding_house_staff_one_open" ON "boarding_house_staff" USING btree ("tenant_id","house_id","membership_id") WHERE "boarding_house_staff"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "boarding_house_staff_member_idx" ON "boarding_house_staff" USING btree ("tenant_id","membership_id");