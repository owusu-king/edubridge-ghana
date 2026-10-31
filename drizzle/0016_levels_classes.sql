CREATE TABLE "classes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"level_id" uuid NOT NULL,
	"campus_id" uuid NOT NULL,
	"name" "citext" NOT NULL,
	"class_teacher_membership_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "classes_campus_name_unique" UNIQUE("tenant_id","campus_id","name"),
	CONSTRAINT "classes_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "classes_name_length" CHECK (char_length("classes"."name") between 1 and 40)
);
--> statement-breakpoint
CREATE TABLE "levels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" "citext" NOT NULL,
	"stage" text NOT NULL,
	"sequence" integer NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "levels_tenant_name_unique" UNIQUE("tenant_id","name"),
	CONSTRAINT "levels_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "levels_name_length" CHECK (char_length("levels"."name") between 1 and 40)
);
--> statement-breakpoint
ALTER TABLE "classes" ADD CONSTRAINT "classes_level_fk" FOREIGN KEY ("tenant_id","level_id") REFERENCES "public"."levels"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classes" ADD CONSTRAINT "classes_campus_fk" FOREIGN KEY ("tenant_id","campus_id") REFERENCES "public"."campuses"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classes" ADD CONSTRAINT "classes_class_teacher_fk" FOREIGN KEY ("tenant_id","class_teacher_membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "levels" ADD CONSTRAINT "levels_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;