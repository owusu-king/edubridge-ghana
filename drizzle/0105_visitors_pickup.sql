CREATE TABLE "pickup_collectors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"full_name" text NOT NULL,
	"relationship" text NOT NULL,
	"phone" text,
	"photo_file_id" uuid,
	"valid_until" date,
	"note" text,
	"added_by_user_id" uuid NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"ended_by_user_id" uuid,
	"end_reason" text,
	CONSTRAINT "pickup_collectors_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "pickup_collectors_name" CHECK (char_length("pickup_collectors"."full_name") between 2 and 120),
	CONSTRAINT "pickup_collectors_relationship" CHECK (char_length("pickup_collectors"."relationship") between 2 and 60),
	CONSTRAINT "pickup_collectors_phone_e164" CHECK ("pickup_collectors"."phone" is null or "pickup_collectors"."phone" ~ '^\+[1-9][0-9]{7,14}$'),
	CONSTRAINT "pickup_collectors_text_lengths" CHECK (coalesce(char_length("pickup_collectors"."note"), 0) <= 300 and coalesce(char_length("pickup_collectors"."end_reason"), 0) <= 300),
	CONSTRAINT "pickup_collectors_ended" CHECK (("pickup_collectors"."ended_at" is null) = ("pickup_collectors"."ended_by_user_id" is null) and ("pickup_collectors"."ended_at" is null) = ("pickup_collectors"."end_reason" is null))
);
--> statement-breakpoint
CREATE TABLE "pickups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"on_date" date NOT NULL,
	"outcome" text NOT NULL,
	"guardian_id" uuid,
	"collector_id" uuid,
	"person_name" text NOT NULL,
	"relationship" text,
	"reason" text,
	"note" text,
	"recorded_by_user_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cancelled_at" timestamp with time zone,
	"cancelled_by_user_id" uuid,
	"cancel_reason" text,
	CONSTRAINT "pickups_who" CHECK (("pickups"."outcome" = 'released' and ("pickups"."guardian_id" is null) <> ("pickups"."collector_id" is null) and "pickups"."reason" is null) or ("pickups"."outcome" = 'refused' and "pickups"."guardian_id" is null and "pickups"."collector_id" is null and "pickups"."reason" is not null)),
	CONSTRAINT "pickups_person" CHECK (char_length("pickups"."person_name") between 2 and 120),
	CONSTRAINT "pickups_text_lengths" CHECK (coalesce(char_length("pickups"."relationship"), 0) <= 60 and coalesce(char_length("pickups"."reason"), 0) <= 500 and coalesce(char_length("pickups"."note"), 0) <= 300 and coalesce(char_length("pickups"."cancel_reason"), 0) <= 300),
	CONSTRAINT "pickups_cancelled" CHECK (("pickups"."cancelled_at" is null) = ("pickups"."cancelled_by_user_id" is null) and ("pickups"."cancelled_at" is null) = ("pickups"."cancel_reason" is null))
);
--> statement-breakpoint
CREATE TABLE "visitor_visits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"campus_id" uuid,
	"full_name" text NOT NULL,
	"phone" text,
	"organisation" text,
	"purpose" text NOT NULL,
	"host_membership_id" uuid,
	"host_name" text,
	"badge" text,
	"note" text,
	"signed_in_at" timestamp with time zone DEFAULT now() NOT NULL,
	"signed_in_by_user_id" uuid NOT NULL,
	"signed_out_at" timestamp with time zone,
	"signed_out_by_user_id" uuid,
	CONSTRAINT "visitor_visits_name" CHECK (char_length("visitor_visits"."full_name") between 2 and 120),
	CONSTRAINT "visitor_visits_phone_e164" CHECK ("visitor_visits"."phone" is null or "visitor_visits"."phone" ~ '^\+[1-9][0-9]{7,14}$'),
	CONSTRAINT "visitor_visits_text_lengths" CHECK (coalesce(char_length("visitor_visits"."organisation"), 0) <= 120 and coalesce(char_length("visitor_visits"."host_name"), 0) <= 120 and coalesce(char_length("visitor_visits"."badge"), 0) <= 20 and coalesce(char_length("visitor_visits"."note"), 0) <= 500),
	CONSTRAINT "visitor_visits_signed_out" CHECK (("visitor_visits"."signed_out_at" is null) = ("visitor_visits"."signed_out_by_user_id" is null))
);
--> statement-breakpoint
ALTER TABLE "pickup_collectors" ADD CONSTRAINT "pickup_collectors_added_by_user_id_users_id_fk" FOREIGN KEY ("added_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pickup_collectors" ADD CONSTRAINT "pickup_collectors_ended_by_user_id_users_id_fk" FOREIGN KEY ("ended_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pickup_collectors" ADD CONSTRAINT "pickup_collectors_tenant_id_student_id_students_tenant_id_id_fk" FOREIGN KEY ("tenant_id","student_id") REFERENCES "public"."students"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pickups" ADD CONSTRAINT "pickups_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pickups" ADD CONSTRAINT "pickups_cancelled_by_user_id_users_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pickups" ADD CONSTRAINT "pickups_tenant_id_student_id_students_tenant_id_id_fk" FOREIGN KEY ("tenant_id","student_id") REFERENCES "public"."students"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pickups" ADD CONSTRAINT "pickups_tenant_id_guardian_id_guardians_tenant_id_id_fk" FOREIGN KEY ("tenant_id","guardian_id") REFERENCES "public"."guardians"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pickups" ADD CONSTRAINT "pickups_tenant_id_collector_id_pickup_collectors_tenant_id_id_fk" FOREIGN KEY ("tenant_id","collector_id") REFERENCES "public"."pickup_collectors"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visitor_visits" ADD CONSTRAINT "visitor_visits_signed_in_by_user_id_users_id_fk" FOREIGN KEY ("signed_in_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visitor_visits" ADD CONSTRAINT "visitor_visits_signed_out_by_user_id_users_id_fk" FOREIGN KEY ("signed_out_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visitor_visits" ADD CONSTRAINT "visitor_visits_tenant_id_campus_id_campuses_tenant_id_id_fk" FOREIGN KEY ("tenant_id","campus_id") REFERENCES "public"."campuses"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visitor_visits" ADD CONSTRAINT "visitor_visits_tenant_id_host_membership_id_memberships_tenant_id_id_fk" FOREIGN KEY ("tenant_id","host_membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pickup_collectors_student_idx" ON "pickup_collectors" USING btree ("tenant_id","student_id");--> statement-breakpoint
CREATE INDEX "pickups_day_idx" ON "pickups" USING btree ("tenant_id","on_date");--> statement-breakpoint
CREATE INDEX "pickups_student_idx" ON "pickups" USING btree ("tenant_id","student_id","recorded_at");--> statement-breakpoint
CREATE INDEX "visitor_visits_day_idx" ON "visitor_visits" USING btree ("tenant_id","signed_in_at");--> statement-breakpoint
CREATE INDEX "visitor_visits_on_site_idx" ON "visitor_visits" USING btree ("tenant_id") WHERE "visitor_visits"."signed_out_at" is null;