CREATE TABLE "finance_check_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"check_key" text NOT NULL,
	"rule" text NOT NULL,
	"note" text NOT NULL,
	"reviewed_by_user_id" uuid NOT NULL,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_check_reviews_lengths" CHECK (char_length("finance_check_reviews"."check_key") between 3 and 300 and char_length("finance_check_reviews"."note") between 3 and 500)
);
--> statement-breakpoint
ALTER TABLE "finance_check_reviews" ADD CONSTRAINT "finance_check_reviews_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_check_reviews" ADD CONSTRAINT "finance_check_reviews_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "finance_check_reviews_key" ON "finance_check_reviews" USING btree ("tenant_id","check_key");