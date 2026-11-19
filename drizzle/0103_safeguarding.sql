CREATE TABLE "safeguarding_access" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"action" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "safeguarding_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"student_id" uuid NOT NULL,
	"category" text NOT NULL,
	"description" text NOT NULL,
	"occurred_on" date,
	"location" text,
	"immediate_action" text,
	"reported_by_user_id" uuid NOT NULL,
	"reported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"lead_membership_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "safeguarding_cases_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "safeguarding_cases_tenant_reference_unique" UNIQUE("tenant_id","reference"),
	CONSTRAINT "safeguarding_cases_description" CHECK (char_length("safeguarding_cases"."description") between 10 and 4000),
	CONSTRAINT "safeguarding_cases_text_lengths" CHECK (coalesce(char_length("safeguarding_cases"."location"), 0) <= 200 and coalesce(char_length("safeguarding_cases"."immediate_action"), 0) <= 2000)
);
--> statement-breakpoint
CREATE TABLE "safeguarding_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"mime" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"content" "bytea" NOT NULL,
	"uploaded_by_user_id" uuid NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"removed_by_user_id" uuid,
	CONSTRAINT "safeguarding_documents_size" CHECK ("safeguarding_documents"."size_bytes" between 1 and 5242880),
	CONSTRAINT "safeguarding_documents_filename" CHECK (char_length("safeguarding_documents"."filename") between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "safeguarding_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"body" text NOT NULL,
	"due_on" date,
	"done_at" timestamp with time zone,
	"done_by_user_id" uuid,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "safeguarding_entries_body" CHECK (char_length("safeguarding_entries"."body") between 1 and 4000),
	CONSTRAINT "safeguarding_entries_done" CHECK (("safeguarding_entries"."done_at" is null) = ("safeguarding_entries"."done_by_user_id" is null))
);
--> statement-breakpoint
CREATE TABLE "safeguarding_leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"granted_by_user_id" uuid NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"ended_by_user_id" uuid,
	CONSTRAINT "safeguarding_leads_ended" CHECK (("safeguarding_leads"."ended_at" is null) = ("safeguarding_leads"."ended_by_user_id" is null))
);
--> statement-breakpoint
ALTER TABLE "safeguarding_access" ADD CONSTRAINT "safeguarding_access_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safeguarding_access" ADD CONSTRAINT "safeguarding_access_tenant_id_case_id_safeguarding_cases_tenant_id_id_fk" FOREIGN KEY ("tenant_id","case_id") REFERENCES "public"."safeguarding_cases"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safeguarding_cases" ADD CONSTRAINT "safeguarding_cases_reported_by_user_id_users_id_fk" FOREIGN KEY ("reported_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safeguarding_cases" ADD CONSTRAINT "safeguarding_cases_tenant_id_student_id_students_tenant_id_id_fk" FOREIGN KEY ("tenant_id","student_id") REFERENCES "public"."students"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safeguarding_cases" ADD CONSTRAINT "safeguarding_cases_tenant_id_lead_membership_id_memberships_tenant_id_id_fk" FOREIGN KEY ("tenant_id","lead_membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safeguarding_documents" ADD CONSTRAINT "safeguarding_documents_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safeguarding_documents" ADD CONSTRAINT "safeguarding_documents_removed_by_user_id_users_id_fk" FOREIGN KEY ("removed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safeguarding_documents" ADD CONSTRAINT "safeguarding_documents_tenant_id_case_id_safeguarding_cases_tenant_id_id_fk" FOREIGN KEY ("tenant_id","case_id") REFERENCES "public"."safeguarding_cases"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safeguarding_entries" ADD CONSTRAINT "safeguarding_entries_done_by_user_id_users_id_fk" FOREIGN KEY ("done_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safeguarding_entries" ADD CONSTRAINT "safeguarding_entries_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safeguarding_entries" ADD CONSTRAINT "safeguarding_entries_tenant_id_case_id_safeguarding_cases_tenant_id_id_fk" FOREIGN KEY ("tenant_id","case_id") REFERENCES "public"."safeguarding_cases"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safeguarding_leads" ADD CONSTRAINT "safeguarding_leads_granted_by_user_id_users_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safeguarding_leads" ADD CONSTRAINT "safeguarding_leads_ended_by_user_id_users_id_fk" FOREIGN KEY ("ended_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safeguarding_leads" ADD CONSTRAINT "safeguarding_leads_tenant_id_membership_id_memberships_tenant_id_id_fk" FOREIGN KEY ("tenant_id","membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "safeguarding_access_case_idx" ON "safeguarding_access" USING btree ("tenant_id","case_id","at");--> statement-breakpoint
CREATE INDEX "safeguarding_cases_status_idx" ON "safeguarding_cases" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "safeguarding_documents_case_idx" ON "safeguarding_documents" USING btree ("tenant_id","case_id");--> statement-breakpoint
CREATE INDEX "safeguarding_entries_case_idx" ON "safeguarding_entries" USING btree ("tenant_id","case_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "safeguarding_leads_one_open" ON "safeguarding_leads" USING btree ("tenant_id","membership_id") WHERE "safeguarding_leads"."ended_at" is null;