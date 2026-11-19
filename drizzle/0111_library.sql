CREATE TABLE "library_copies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"title_id" uuid NOT NULL,
	"number" text NOT NULL,
	"shelf" text,
	"status" text DEFAULT 'active' NOT NULL,
	"withdrawn_at" timestamp with time zone,
	"withdrawn_reason" text,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "library_copies_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "library_copies_tenant_number_unique" UNIQUE("tenant_id","number"),
	CONSTRAINT "library_copies_shelf" CHECK (coalesce(char_length("library_copies"."shelf"), 0) <= 60),
	CONSTRAINT "library_copies_withdrawn" CHECK (("library_copies"."status" = 'withdrawn') = ("library_copies"."withdrawn_at" is not null) and ("library_copies"."withdrawn_at" is null) = ("library_copies"."withdrawn_reason" is null))
);
--> statement-breakpoint
CREATE TABLE "library_loans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"copy_id" uuid NOT NULL,
	"student_id" uuid,
	"membership_id" uuid,
	"loaned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"loaned_by_user_id" uuid NOT NULL,
	"due_on" date NOT NULL,
	"renewals" integer DEFAULT 0 NOT NULL,
	"returned_at" timestamp with time zone,
	"returned_by_user_id" uuid,
	"lost_at" timestamp with time zone,
	"lost_by_user_id" uuid,
	"fine_minor" bigint,
	"ledger_entry_id" uuid,
	CONSTRAINT "library_loans_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "library_loans_borrower" CHECK (("library_loans"."student_id" is null) <> ("library_loans"."membership_id" is null)),
	CONSTRAINT "library_loans_returned" CHECK (("library_loans"."returned_at" is null) = ("library_loans"."returned_by_user_id" is null)),
	CONSTRAINT "library_loans_lost" CHECK (("library_loans"."lost_at" is null) = ("library_loans"."lost_by_user_id" is null)),
	CONSTRAINT "library_loans_closed_once" CHECK ("library_loans"."returned_at" is null or "library_loans"."lost_at" is null),
	CONSTRAINT "library_loans_fine" CHECK (("library_loans"."fine_minor" is null or "library_loans"."fine_minor" > 0) and ("library_loans"."ledger_entry_id" is null or "library_loans"."fine_minor" is not null)),
	CONSTRAINT "library_loans_renewals" CHECK ("library_loans"."renewals" between 0 and 100)
);
--> statement-breakpoint
CREATE TABLE "library_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"title_id" uuid NOT NULL,
	"student_id" uuid,
	"membership_id" uuid,
	"status" text DEFAULT 'waiting' NOT NULL,
	"held_copy_id" uuid,
	"reserved_by_user_id" uuid NOT NULL,
	"reserved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"closed_by_user_id" uuid,
	CONSTRAINT "library_reservations_borrower" CHECK (("library_reservations"."student_id" is null) <> ("library_reservations"."membership_id" is null)),
	CONSTRAINT "library_reservations_ready" CHECK ("library_reservations"."status" <> 'ready' or ("library_reservations"."held_copy_id" is not null and "library_reservations"."ready_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "library_settings" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"loan_days" integer DEFAULT 14 NOT NULL,
	"max_loans" integer DEFAULT 3 NOT NULL,
	"fines_enabled" boolean DEFAULT false NOT NULL,
	"fine_per_day_minor" bigint,
	"fine_cap_minor" bigint,
	"updated_by_user_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "library_settings_loan_days" CHECK ("library_settings"."loan_days" between 1 and 365),
	CONSTRAINT "library_settings_max_loans" CHECK ("library_settings"."max_loans" between 1 and 50),
	CONSTRAINT "library_settings_fines" CHECK (("library_settings"."fine_per_day_minor" is null or "library_settings"."fine_per_day_minor" between 1 and 100000000) and ("library_settings"."fine_cap_minor" is null or "library_settings"."fine_cap_minor" between 1 and 100000000000) and (not "library_settings"."fines_enabled" or "library_settings"."fine_per_day_minor" is not null))
);
--> statement-breakpoint
CREATE TABLE "library_titles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"title" text NOT NULL,
	"author" text,
	"isbn" text,
	"publisher" text,
	"published_year" integer,
	"category" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "library_titles_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "library_titles_title" CHECK (char_length("library_titles"."title") between 1 and 200),
	CONSTRAINT "library_titles_isbn" CHECK ("library_titles"."isbn" is null or "library_titles"."isbn" ~ '^([0-9]{9}[0-9X]|[0-9]{13})$'),
	CONSTRAINT "library_titles_year" CHECK ("library_titles"."published_year" is null or "library_titles"."published_year" between 1450 and 2200),
	CONSTRAINT "library_titles_text_lengths" CHECK (coalesce(char_length("library_titles"."author"), 0) <= 200 and coalesce(char_length("library_titles"."publisher"), 0) <= 120 and coalesce(char_length("library_titles"."category"), 0) <= 60)
);
--> statement-breakpoint
ALTER TABLE "library_copies" ADD CONSTRAINT "library_copies_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_copies" ADD CONSTRAINT "library_copies_tenant_id_title_id_library_titles_tenant_id_id_fk" FOREIGN KEY ("tenant_id","title_id") REFERENCES "public"."library_titles"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_loans" ADD CONSTRAINT "library_loans_loaned_by_user_id_users_id_fk" FOREIGN KEY ("loaned_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_loans" ADD CONSTRAINT "library_loans_returned_by_user_id_users_id_fk" FOREIGN KEY ("returned_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_loans" ADD CONSTRAINT "library_loans_lost_by_user_id_users_id_fk" FOREIGN KEY ("lost_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_loans" ADD CONSTRAINT "library_loans_tenant_id_copy_id_library_copies_tenant_id_id_fk" FOREIGN KEY ("tenant_id","copy_id") REFERENCES "public"."library_copies"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_loans" ADD CONSTRAINT "library_loans_tenant_id_student_id_students_tenant_id_id_fk" FOREIGN KEY ("tenant_id","student_id") REFERENCES "public"."students"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_loans" ADD CONSTRAINT "library_loans_tenant_id_membership_id_memberships_tenant_id_id_fk" FOREIGN KEY ("tenant_id","membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_loans" ADD CONSTRAINT "library_loans_tenant_id_ledger_entry_id_ledger_entries_tenant_id_id_fk" FOREIGN KEY ("tenant_id","ledger_entry_id") REFERENCES "public"."ledger_entries"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_reservations" ADD CONSTRAINT "library_reservations_reserved_by_user_id_users_id_fk" FOREIGN KEY ("reserved_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_reservations" ADD CONSTRAINT "library_reservations_closed_by_user_id_users_id_fk" FOREIGN KEY ("closed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_reservations" ADD CONSTRAINT "library_reservations_tenant_id_title_id_library_titles_tenant_id_id_fk" FOREIGN KEY ("tenant_id","title_id") REFERENCES "public"."library_titles"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_reservations" ADD CONSTRAINT "library_reservations_tenant_id_held_copy_id_library_copies_tenant_id_id_fk" FOREIGN KEY ("tenant_id","held_copy_id") REFERENCES "public"."library_copies"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_reservations" ADD CONSTRAINT "library_reservations_tenant_id_student_id_students_tenant_id_id_fk" FOREIGN KEY ("tenant_id","student_id") REFERENCES "public"."students"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_reservations" ADD CONSTRAINT "library_reservations_tenant_id_membership_id_memberships_tenant_id_id_fk" FOREIGN KEY ("tenant_id","membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_settings" ADD CONSTRAINT "library_settings_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_settings" ADD CONSTRAINT "library_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_titles" ADD CONSTRAINT "library_titles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "library_copies_title_idx" ON "library_copies" USING btree ("tenant_id","title_id");--> statement-breakpoint
CREATE UNIQUE INDEX "library_loans_one_open_per_copy" ON "library_loans" USING btree ("tenant_id","copy_id") WHERE "library_loans"."returned_at" is null and "library_loans"."lost_at" is null;--> statement-breakpoint
CREATE INDEX "library_loans_student_idx" ON "library_loans" USING btree ("tenant_id","student_id");--> statement-breakpoint
CREATE INDEX "library_loans_member_idx" ON "library_loans" USING btree ("tenant_id","membership_id");--> statement-breakpoint
CREATE INDEX "library_reservations_title_idx" ON "library_reservations" USING btree ("tenant_id","title_id","status","reserved_at");--> statement-breakpoint
CREATE UNIQUE INDEX "library_reservations_one_held_copy" ON "library_reservations" USING btree ("tenant_id","held_copy_id") WHERE "library_reservations"."status" = 'ready';--> statement-breakpoint
CREATE UNIQUE INDEX "library_reservations_one_student" ON "library_reservations" USING btree ("tenant_id","title_id","student_id") WHERE "library_reservations"."status" in ('waiting', 'ready') and "library_reservations"."student_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "library_reservations_one_member" ON "library_reservations" USING btree ("tenant_id","title_id","membership_id") WHERE "library_reservations"."status" in ('waiting', 'ready') and "library_reservations"."membership_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "library_titles_isbn_unique" ON "library_titles" USING btree ("tenant_id","isbn") WHERE "library_titles"."isbn" is not null;