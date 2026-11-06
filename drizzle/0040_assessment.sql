CREATE TABLE "assessment_schemes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"term_id" uuid NOT NULL,
	"components" jsonb NOT NULL,
	"show_positions" boolean DEFAULT false NOT NULL,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assessment_schemes_term_unique" UNIQUE("tenant_id","term_id"),
	CONSTRAINT "assessment_schemes_components" CHECK (jsonb_typeof("assessment_schemes"."components") = 'array')
);
--> statement-breakpoint
CREATE TABLE "assessment_scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"term_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"component_key" text NOT NULL,
	"score_tenths" integer NOT NULL,
	"entered_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assessment_scores_unique" UNIQUE("tenant_id","term_id","student_id","subject_id","component_key"),
	CONSTRAINT "assessment_scores_range" CHECK ("assessment_scores"."score_tenths" between 0 and 10000),
	CONSTRAINT "assessment_scores_key" CHECK (char_length("assessment_scores"."component_key") between 1 and 20)
);
--> statement-breakpoint
CREATE TABLE "grading_scales" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"stage" text NOT NULL,
	"bands" jsonb NOT NULL,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grading_scales_stage_unique" UNIQUE("tenant_id","stage"),
	CONSTRAINT "grading_scales_bands" CHECK (jsonb_typeof("grading_scales"."bands") = 'array')
);
--> statement-breakpoint
CREATE TABLE "level_subjects" (
	"tenant_id" uuid NOT NULL,
	"level_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "level_subjects_level_id_subject_id_pk" PRIMARY KEY("level_id","subject_id")
);
--> statement-breakpoint
CREATE TABLE "report_card_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"term_id" uuid NOT NULL,
	"class_ids" uuid[] NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"error" text,
	"requested_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "report_card_batches_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "report_card_batches_classes" CHECK (cardinality("report_card_batches"."class_ids") between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "report_card_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"class_id" uuid NOT NULL,
	"class_name" text NOT NULL,
	"report_count" integer NOT NULL,
	"pdf" "bytea",
	"sha256" text,
	"byte_size" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "report_card_files_batch_class_unique" UNIQUE("batch_id","class_id"),
	CONSTRAINT "report_card_files_pdf" CHECK (("report_card_files"."report_count" = 0) = ("report_card_files"."pdf" is null))
);
--> statement-breakpoint
CREATE TABLE "report_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"term_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"attitude" text,
	"conduct" text,
	"interest" text,
	"class_teacher_remark" text,
	"head_teacher_remark" text,
	"days_present" integer,
	"days_open" integer,
	"snapshot" jsonb,
	"published_at" timestamp with time zone,
	"published_by_user_id" uuid,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "report_cards_term_student_unique" UNIQUE("tenant_id","term_id","student_id"),
	CONSTRAINT "report_cards_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "report_cards_published_complete" CHECK (("report_cards"."status" = 'published') = ("report_cards"."snapshot" is not null and "report_cards"."published_at" is not null)),
	CONSTRAINT "report_cards_attendance" CHECK (("report_cards"."days_open" is null or "report_cards"."days_open" between 0 and 366) and ("report_cards"."days_present" is null or ("report_cards"."days_present" >= 0 and ("report_cards"."days_open" is null or "report_cards"."days_present" <= "report_cards"."days_open")))),
	CONSTRAINT "report_cards_text_length" CHECK (coalesce(char_length("report_cards"."attitude"), 0) <= 60 and coalesce(char_length("report_cards"."conduct"), 0) <= 60 and coalesce(char_length("report_cards"."interest"), 0) <= 60 and coalesce(char_length("report_cards"."class_teacher_remark"), 0) <= 500 and coalesce(char_length("report_cards"."head_teacher_remark"), 0) <= 500)
);
--> statement-breakpoint
CREATE TABLE "subjects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" "citext" NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subjects_tenant_name_unique" UNIQUE("tenant_id","name"),
	CONSTRAINT "subjects_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "subjects_name_length" CHECK (char_length("subjects"."name") between 1 and 60)
);
--> statement-breakpoint
ALTER TABLE "assessment_schemes" ADD CONSTRAINT "assessment_schemes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_schemes" ADD CONSTRAINT "assessment_schemes_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_schemes" ADD CONSTRAINT "assessment_schemes_term_fk" FOREIGN KEY ("tenant_id","term_id") REFERENCES "public"."terms"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_scores" ADD CONSTRAINT "assessment_scores_entered_by_user_id_users_id_fk" FOREIGN KEY ("entered_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_scores" ADD CONSTRAINT "assessment_scores_term_fk" FOREIGN KEY ("tenant_id","term_id") REFERENCES "public"."terms"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_scores" ADD CONSTRAINT "assessment_scores_student_fk" FOREIGN KEY ("tenant_id","student_id") REFERENCES "public"."students"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_scores" ADD CONSTRAINT "assessment_scores_subject_fk" FOREIGN KEY ("tenant_id","subject_id") REFERENCES "public"."subjects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grading_scales" ADD CONSTRAINT "grading_scales_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grading_scales" ADD CONSTRAINT "grading_scales_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "level_subjects" ADD CONSTRAINT "level_subjects_level_fk" FOREIGN KEY ("tenant_id","level_id") REFERENCES "public"."levels"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "level_subjects" ADD CONSTRAINT "level_subjects_subject_fk" FOREIGN KEY ("tenant_id","subject_id") REFERENCES "public"."subjects"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_card_batches" ADD CONSTRAINT "report_card_batches_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_card_batches" ADD CONSTRAINT "report_card_batches_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_card_batches" ADD CONSTRAINT "report_card_batches_term_fk" FOREIGN KEY ("tenant_id","term_id") REFERENCES "public"."terms"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_card_files" ADD CONSTRAINT "report_card_files_batch_fk" FOREIGN KEY ("tenant_id","batch_id") REFERENCES "public"."report_card_batches"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_cards" ADD CONSTRAINT "report_cards_published_by_user_id_users_id_fk" FOREIGN KEY ("published_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_cards" ADD CONSTRAINT "report_cards_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_cards" ADD CONSTRAINT "report_cards_term_fk" FOREIGN KEY ("tenant_id","term_id") REFERENCES "public"."terms"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_cards" ADD CONSTRAINT "report_cards_student_fk" FOREIGN KEY ("tenant_id","student_id") REFERENCES "public"."students"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subjects" ADD CONSTRAINT "subjects_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assessment_scores_subject_idx" ON "assessment_scores" USING btree ("tenant_id","term_id","subject_id");--> statement-breakpoint
CREATE INDEX "level_subjects_tenant_idx" ON "level_subjects" USING btree ("tenant_id","level_id");--> statement-breakpoint
CREATE INDEX "report_card_batches_status_idx" ON "report_card_batches" USING btree ("tenant_id","status");