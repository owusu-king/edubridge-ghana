CREATE TABLE "student_subject_choices" (
	"tenant_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "student_subject_choices_student_id_subject_id_pk" PRIMARY KEY("student_id","subject_id")
);
--> statement-breakpoint
ALTER TABLE "level_subjects" ADD COLUMN "elective" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "student_subject_choices" ADD CONSTRAINT "student_subject_choices_student_fk" FOREIGN KEY ("tenant_id","student_id") REFERENCES "public"."students"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_subject_choices" ADD CONSTRAINT "student_subject_choices_subject_fk" FOREIGN KEY ("tenant_id","subject_id") REFERENCES "public"."subjects"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "student_subject_choices_subject_idx" ON "student_subject_choices" USING btree ("tenant_id","subject_id");