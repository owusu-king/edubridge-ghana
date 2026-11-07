CREATE TABLE "term_move_enrolments" (
	"tenant_id" uuid NOT NULL,
	"move_id" uuid NOT NULL,
	"enrolment_id" uuid NOT NULL,
	CONSTRAINT "term_move_enrolments_move_id_enrolment_id_pk" PRIMARY KEY("move_id","enrolment_id")
);
--> statement-breakpoint
CREATE TABLE "term_moves" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"from_term_id" uuid NOT NULL,
	"to_term_id" uuid NOT NULL,
	"new_year" boolean NOT NULL,
	"placed" integer NOT NULL,
	"graduated_student_ids" uuid[] NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"undone_at" timestamp with time zone,
	"undone_by_user_id" uuid,
	CONSTRAINT "term_moves_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "term_moves_terms_differ" CHECK ("term_moves"."from_term_id" <> "term_moves"."to_term_id"),
	CONSTRAINT "term_moves_placed_range" CHECK ("term_moves"."placed" >= 0)
);
--> statement-breakpoint
ALTER TABLE "term_move_enrolments" ADD CONSTRAINT "term_move_enrolments_enrolment_id_enrolments_id_fk" FOREIGN KEY ("enrolment_id") REFERENCES "public"."enrolments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "term_move_enrolments" ADD CONSTRAINT "term_move_enrolments_move_fk" FOREIGN KEY ("tenant_id","move_id") REFERENCES "public"."term_moves"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "term_moves" ADD CONSTRAINT "term_moves_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "term_moves" ADD CONSTRAINT "term_moves_undone_by_user_id_users_id_fk" FOREIGN KEY ("undone_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "term_moves" ADD CONSTRAINT "term_moves_from_term_fk" FOREIGN KEY ("tenant_id","from_term_id") REFERENCES "public"."terms"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "term_moves" ADD CONSTRAINT "term_moves_to_term_fk" FOREIGN KEY ("tenant_id","to_term_id") REFERENCES "public"."terms"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "term_moves_tenant_idx" ON "term_moves" USING btree ("tenant_id","created_at");