CREATE TABLE "transport_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"term_id" uuid NOT NULL,
	"route_id" uuid NOT NULL,
	"stop_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"ended_by_user_id" uuid,
	CONSTRAINT "transport_assignments_ended" CHECK (("transport_assignments"."ended_at" is null) = ("transport_assignments"."ended_by_user_id" is null))
);
--> statement-breakpoint
CREATE TABLE "transport_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" "citext" NOT NULL,
	"vehicle_id" uuid,
	"fare_pesewas" bigint,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transport_routes_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "transport_routes_tenant_name_unique" UNIQUE("tenant_id","name"),
	CONSTRAINT "transport_routes_name" CHECK (char_length("transport_routes"."name") between 1 and 60),
	CONSTRAINT "transport_routes_fare" CHECK ("transport_routes"."fare_pesewas" is null or "transport_routes"."fare_pesewas" between 0 and 100000000000)
);
--> statement-breakpoint
CREATE TABLE "transport_settings" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"fee_item_id" uuid,
	"notify_families" boolean DEFAULT true NOT NULL,
	"updated_by_user_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transport_stops" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"route_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sequence" integer NOT NULL,
	"morning_time" text,
	"afternoon_time" text,
	"fare_pesewas" bigint,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transport_stops_route_id_unique" UNIQUE("tenant_id","route_id","id"),
	CONSTRAINT "transport_stops_name" CHECK (char_length("transport_stops"."name") between 1 and 80),
	CONSTRAINT "transport_stops_times" CHECK (("transport_stops"."morning_time" is null or "transport_stops"."morning_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') and ("transport_stops"."afternoon_time" is null or "transport_stops"."afternoon_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')),
	CONSTRAINT "transport_stops_fare" CHECK ("transport_stops"."fare_pesewas" is null or "transport_stops"."fare_pesewas" between 0 and 100000000000)
);
--> statement-breakpoint
CREATE TABLE "transport_trip_marks" (
	"tenant_id" uuid NOT NULL,
	"trip_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"stop_id" uuid,
	"boarded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"boarded_by_user_id" uuid NOT NULL,
	"left_at" timestamp with time zone,
	"left_by_user_id" uuid,
	CONSTRAINT "transport_trip_marks_trip_id_student_id_pk" PRIMARY KEY("trip_id","student_id"),
	CONSTRAINT "transport_trip_marks_left" CHECK (("transport_trip_marks"."left_at" is null) = ("transport_trip_marks"."left_by_user_id" is null)),
	CONSTRAINT "transport_trip_marks_order" CHECK ("transport_trip_marks"."left_at" is null or "transport_trip_marks"."left_at" >= "transport_trip_marks"."boarded_at")
);
--> statement-breakpoint
CREATE TABLE "transport_trips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"route_id" uuid NOT NULL,
	"on_date" date NOT NULL,
	"direction" text NOT NULL,
	"vehicle_id" uuid,
	"started_by_user_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transport_trips_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "transport_trips_one_per_run" UNIQUE("tenant_id","route_id","on_date","direction")
);
--> statement-breakpoint
CREATE TABLE "transport_vehicles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" "citext" NOT NULL,
	"registration" text,
	"seats" integer,
	"driver_name" text,
	"driver_phone" text,
	"attendant_name" text,
	"attendant_phone" text,
	"note" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transport_vehicles_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "transport_vehicles_tenant_name_unique" UNIQUE("tenant_id","name"),
	CONSTRAINT "transport_vehicles_name" CHECK (char_length("transport_vehicles"."name") between 1 and 60),
	CONSTRAINT "transport_vehicles_seats" CHECK ("transport_vehicles"."seats" is null or "transport_vehicles"."seats" between 1 and 200),
	CONSTRAINT "transport_vehicles_phones" CHECK (("transport_vehicles"."driver_phone" is null or "transport_vehicles"."driver_phone" ~ '^\+[1-9][0-9]{7,14}$') and ("transport_vehicles"."attendant_phone" is null or "transport_vehicles"."attendant_phone" ~ '^\+[1-9][0-9]{7,14}$')),
	CONSTRAINT "transport_vehicles_text_lengths" CHECK (coalesce(char_length("transport_vehicles"."registration"), 0) <= 20 and coalesce(char_length("transport_vehicles"."driver_name"), 0) <= 120 and coalesce(char_length("transport_vehicles"."attendant_name"), 0) <= 120 and coalesce(char_length("transport_vehicles"."note"), 0) <= 300)
);
--> statement-breakpoint
ALTER TABLE "transport_assignments" ADD CONSTRAINT "transport_assignments_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transport_assignments" ADD CONSTRAINT "transport_assignments_ended_by_user_id_users_id_fk" FOREIGN KEY ("ended_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transport_assignments" ADD CONSTRAINT "transport_assignments_tenant_id_student_id_students_tenant_id_id_fk" FOREIGN KEY ("tenant_id","student_id") REFERENCES "public"."students"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transport_assignments" ADD CONSTRAINT "transport_assignments_tenant_id_term_id_terms_tenant_id_id_fk" FOREIGN KEY ("tenant_id","term_id") REFERENCES "public"."terms"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transport_assignments" ADD CONSTRAINT "transport_assignments_tenant_id_route_id_stop_id_transport_stops_tenant_id_route_id_id_fk" FOREIGN KEY ("tenant_id","route_id","stop_id") REFERENCES "public"."transport_stops"("tenant_id","route_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transport_routes" ADD CONSTRAINT "transport_routes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transport_routes" ADD CONSTRAINT "transport_routes_tenant_id_vehicle_id_transport_vehicles_tenant_id_id_fk" FOREIGN KEY ("tenant_id","vehicle_id") REFERENCES "public"."transport_vehicles"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transport_settings" ADD CONSTRAINT "transport_settings_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transport_settings" ADD CONSTRAINT "transport_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transport_settings" ADD CONSTRAINT "transport_settings_tenant_id_fee_item_id_fee_items_tenant_id_id_fk" FOREIGN KEY ("tenant_id","fee_item_id") REFERENCES "public"."fee_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transport_stops" ADD CONSTRAINT "transport_stops_tenant_id_route_id_transport_routes_tenant_id_id_fk" FOREIGN KEY ("tenant_id","route_id") REFERENCES "public"."transport_routes"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transport_trip_marks" ADD CONSTRAINT "transport_trip_marks_boarded_by_user_id_users_id_fk" FOREIGN KEY ("boarded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transport_trip_marks" ADD CONSTRAINT "transport_trip_marks_left_by_user_id_users_id_fk" FOREIGN KEY ("left_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transport_trip_marks" ADD CONSTRAINT "transport_trip_marks_tenant_id_trip_id_transport_trips_tenant_id_id_fk" FOREIGN KEY ("tenant_id","trip_id") REFERENCES "public"."transport_trips"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transport_trip_marks" ADD CONSTRAINT "transport_trip_marks_tenant_id_student_id_students_tenant_id_id_fk" FOREIGN KEY ("tenant_id","student_id") REFERENCES "public"."students"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transport_trips" ADD CONSTRAINT "transport_trips_started_by_user_id_users_id_fk" FOREIGN KEY ("started_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transport_trips" ADD CONSTRAINT "transport_trips_tenant_id_route_id_transport_routes_tenant_id_id_fk" FOREIGN KEY ("tenant_id","route_id") REFERENCES "public"."transport_routes"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transport_trips" ADD CONSTRAINT "transport_trips_tenant_id_vehicle_id_transport_vehicles_tenant_id_id_fk" FOREIGN KEY ("tenant_id","vehicle_id") REFERENCES "public"."transport_vehicles"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transport_vehicles" ADD CONSTRAINT "transport_vehicles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "transport_assignments_one_open" ON "transport_assignments" USING btree ("tenant_id","student_id","term_id") WHERE "transport_assignments"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "transport_assignments_route_idx" ON "transport_assignments" USING btree ("tenant_id","term_id","route_id");--> statement-breakpoint
CREATE INDEX "transport_trip_marks_student_idx" ON "transport_trip_marks" USING btree ("tenant_id","student_id");