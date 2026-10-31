CREATE TABLE "enrolments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"term_id" uuid NOT NULL,
	"class_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enrolments_term_student_unique" UNIQUE("term_id","student_id")
);
--> statement-breakpoint
CREATE TABLE "students" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"admission_number" "citext" NOT NULL,
	"first_name" text NOT NULL,
	"other_names" text,
	"last_name" text NOT NULL,
	"sex" text NOT NULL,
	"date_of_birth" date,
	"admitted_on" date,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "students_tenant_admission_unique" UNIQUE("tenant_id","admission_number"),
	CONSTRAINT "students_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "students_names_length" CHECK (char_length("students"."first_name") between 1 and 60 and char_length("students"."last_name") between 1 and 60)
);
--> statement-breakpoint
CREATE TABLE "tenant_counters" (
	"tenant_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "tenant_counters_tenant_id_key_pk" PRIMARY KEY("tenant_id","key")
);
--> statement-breakpoint
ALTER TABLE "enrolments" ADD CONSTRAINT "enrolments_student_fk" FOREIGN KEY ("tenant_id","student_id") REFERENCES "public"."students"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrolments" ADD CONSTRAINT "enrolments_term_fk" FOREIGN KEY ("tenant_id","term_id") REFERENCES "public"."terms"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrolments" ADD CONSTRAINT "enrolments_class_fk" FOREIGN KEY ("tenant_id","class_id") REFERENCES "public"."classes"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "students" ADD CONSTRAINT "students_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_counters" ADD CONSTRAINT "tenant_counters_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "enrolments_class_term_idx" ON "enrolments" USING btree ("tenant_id","class_id","term_id");--> statement-breakpoint
CREATE INDEX "students_tenant_name_idx" ON "students" USING btree ("tenant_id","last_name","first_name");