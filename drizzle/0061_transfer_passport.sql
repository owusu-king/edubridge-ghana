CREATE TABLE "learner_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"learner_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"record" jsonb NOT NULL,
	"sha256" text NOT NULL,
	"key_id" text NOT NULL,
	"signature" text NOT NULL,
	"issued_by_user_id" uuid NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	CONSTRAINT "learner_records_tenant_id_unique" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "learners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prior_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"source" text NOT NULL,
	"verified" boolean NOT NULL,
	"issuer_name" text NOT NULL,
	"issued_at" timestamp with time zone,
	"source_record_id" uuid,
	"sha256" text NOT NULL,
	"package" jsonb NOT NULL,
	"imported_by_user_id" uuid NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_tenant_id" uuid NOT NULL,
	"to_tenant_id" uuid NOT NULL,
	"requested_by" text NOT NULL,
	"requested_by_user_id" uuid,
	"child_first_name" text NOT NULL,
	"child_last_name" text NOT NULL,
	"child_date_of_birth" date,
	"guardian_phone" text NOT NULL,
	"from_student_id" uuid,
	"status" text NOT NULL,
	"consent_phone" text,
	"consented_at" timestamp with time zone,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"decline_reason" text,
	"record_id" uuid,
	"package" jsonb,
	"accepted_by_user_id" uuid,
	"accepted_at" timestamp with time zone,
	"to_student_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "transfers_two_schools" CHECK ("transfers"."from_tenant_id" <> "transfers"."to_tenant_id")
);
--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN "learner_id" uuid;--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN "left_reason" text;--> statement-breakpoint
ALTER TABLE "learner_records" ADD CONSTRAINT "learner_records_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learner_records" ADD CONSTRAINT "learner_records_learner_id_learners_id_fk" FOREIGN KEY ("learner_id") REFERENCES "public"."learners"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learner_records" ADD CONSTRAINT "learner_records_issued_by_user_id_users_id_fk" FOREIGN KEY ("issued_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learner_records" ADD CONSTRAINT "learner_records_student_fk" FOREIGN KEY ("tenant_id","student_id") REFERENCES "public"."students"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prior_records" ADD CONSTRAINT "prior_records_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prior_records" ADD CONSTRAINT "prior_records_imported_by_user_id_users_id_fk" FOREIGN KEY ("imported_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prior_records" ADD CONSTRAINT "prior_records_student_fk" FOREIGN KEY ("tenant_id","student_id") REFERENCES "public"."students"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_from_tenant_id_tenants_id_fk" FOREIGN KEY ("from_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_to_tenant_id_tenants_id_fk" FOREIGN KEY ("to_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_record_id_learner_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."learner_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_accepted_by_user_id_users_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "learner_records_student_idx" ON "learner_records" USING btree ("tenant_id","student_id");--> statement-breakpoint
CREATE INDEX "prior_records_student_idx" ON "prior_records" USING btree ("tenant_id","student_id");--> statement-breakpoint
CREATE INDEX "transfers_from_idx" ON "transfers" USING btree ("from_tenant_id","status");--> statement-breakpoint
CREATE INDEX "transfers_to_idx" ON "transfers" USING btree ("to_tenant_id","status");--> statement-breakpoint
ALTER TABLE "students" ADD CONSTRAINT "students_learner_id_learners_id_fk" FOREIGN KEY ("learner_id") REFERENCES "public"."learners"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "students" ADD CONSTRAINT "students_tenant_learner_unique" UNIQUE("tenant_id","learner_id");