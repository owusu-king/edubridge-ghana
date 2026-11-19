CREATE TABLE "stored_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"owner_id" uuid,
	"filename" text NOT NULL,
	"mime" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"content" "bytea" NOT NULL,
	"uploaded_by_user_id" uuid NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"removed_by_user_id" uuid,
	CONSTRAINT "stored_files_size" CHECK ("stored_files"."size_bytes" between 1 and 5242880),
	CONSTRAINT "stored_files_filename_length" CHECK (char_length("stored_files"."filename") between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "student_medical" (
	"tenant_id" uuid NOT NULL,
	"student_id" uuid PRIMARY KEY NOT NULL,
	"blood_group" text,
	"allergies" text,
	"conditions" text,
	"medications" text,
	"doctor_name" text,
	"doctor_phone" text,
	"emergency_notes" text,
	"updated_by_user_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "school_preferences" ADD COLUMN "brand_color" text;
--> statement-breakpoint
ALTER TABLE "school_preferences" ADD COLUMN "logo_file_id" uuid;
--> statement-breakpoint
ALTER TABLE "school_preferences" ADD COLUMN "admission_prefix" text;
--> statement-breakpoint
ALTER TABLE "school_preferences" ADD COLUMN "admission_digits" integer DEFAULT 4 NOT NULL;
--> statement-breakpoint
ALTER TABLE "student_guardians" ADD COLUMN "is_fee_payer" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "student_guardians" ADD COLUMN "is_emergency_contact" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "student_guardians" ADD COLUMN "can_pick_up" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "student_guardians" ADD COLUMN "receives_messages" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN "preferred_name" text;
--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN "status_changed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN "photo_file_id" uuid;
--> statement-breakpoint
ALTER TABLE "stored_files" ADD CONSTRAINT "stored_files_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "stored_files" ADD CONSTRAINT "stored_files_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "stored_files" ADD CONSTRAINT "stored_files_removed_by_user_id_users_id_fk" FOREIGN KEY ("removed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "student_medical" ADD CONSTRAINT "student_medical_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "student_medical" ADD CONSTRAINT "student_medical_student_fk" FOREIGN KEY ("tenant_id","student_id") REFERENCES "public"."students"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "stored_files_owner_idx" ON "stored_files" USING btree ("tenant_id","purpose","owner_id");
--> statement-breakpoint
-- Files: stored privately, served only through routes that check access; marked removed, never deleted.
GRANT SELECT, INSERT ON stored_files TO edubridge_app;
--> statement-breakpoint
GRANT UPDATE (removed_at, removed_by_user_id) ON stored_files TO edubridge_app;
--> statement-breakpoint
ALTER TABLE stored_files ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE stored_files FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY stored_files_tenant ON stored_files
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
CREATE TRIGGER stored_files_no_delete BEFORE DELETE ON stored_files
  FOR EACH ROW EXECUTE FUNCTION history_record_immutable();
--> statement-breakpoint
-- Medical information: restricted by the service to permitted roles; every view and change is audited.
GRANT SELECT, INSERT, UPDATE ON student_medical TO edubridge_app;
--> statement-breakpoint
ALTER TABLE student_medical ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE student_medical FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY student_medical_tenant ON student_medical
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
