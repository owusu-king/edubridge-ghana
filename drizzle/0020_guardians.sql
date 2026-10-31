CREATE TABLE "guardians" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"full_name" text NOT NULL,
	"phone" text,
	"email" "citext",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guardians_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "guardians_contact" CHECK ("guardians"."phone" is not null or "guardians"."email" is not null),
	CONSTRAINT "guardians_phone_e164" CHECK ("guardians"."phone" is null or "guardians"."phone" ~ '^\+[1-9][0-9]{7,14}$'),
	CONSTRAINT "guardians_name_length" CHECK (char_length("guardians"."full_name") between 2 and 120)
);
--> statement-breakpoint
CREATE TABLE "student_guardians" (
	"tenant_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"guardian_id" uuid NOT NULL,
	"relationship" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "student_guardians_student_id_guardian_id_pk" PRIMARY KEY("student_id","guardian_id")
);
--> statement-breakpoint
ALTER TABLE "guardians" ADD CONSTRAINT "guardians_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_guardians" ADD CONSTRAINT "student_guardians_student_fk" FOREIGN KEY ("tenant_id","student_id") REFERENCES "public"."students"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_guardians" ADD CONSTRAINT "student_guardians_guardian_fk" FOREIGN KEY ("tenant_id","guardian_id") REFERENCES "public"."guardians"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "student_guardians_guardian_idx" ON "student_guardians" USING btree ("tenant_id","guardian_id");