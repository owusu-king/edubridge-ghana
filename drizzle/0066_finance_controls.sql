CREATE TABLE "finance_period_locks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"locked_through" date,
	"reason" text,
	"set_by_user_id" uuid NOT NULL,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"refund_number" text,
	"amount_pesewas" bigint NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"paid_by_user_id" uuid,
	"paid_on" date,
	"method" text,
	"reference" text,
	"ledger_entry_id" uuid,
	CONSTRAINT "refunds_tenant_number_unique" UNIQUE("tenant_id","refund_number"),
	CONSTRAINT "refunds_amount_range" CHECK ("refunds"."amount_pesewas" between 1 and 1000000000),
	CONSTRAINT "refunds_reason_length" CHECK (char_length("refunds"."reason") between 3 and 300),
	CONSTRAINT "refunds_paid_fields" CHECK (("refunds"."status" = 'paid') = ("refunds"."paid_on" is not null and "refunds"."ledger_entry_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "student_fee_options" (
	"tenant_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"fee_item_id" uuid NOT NULL,
	"added_by_user_id" uuid,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "student_fee_options_student_id_fee_item_id_pk" PRIMARY KEY("student_id","fee_item_id")
);
--> statement-breakpoint
ALTER TABLE "ledger_entries" DROP CONSTRAINT "ledger_entries_amount_sign";--> statement-breakpoint
ALTER TABLE "fee_concessions" ADD COLUMN "approved_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "fee_concessions" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "fee_items" ADD COLUMN "category" text DEFAULT 'other' NOT NULL;--> statement-breakpoint
ALTER TABLE "fee_items" ADD COLUMN "optional" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "provisional_reference" text;--> statement-breakpoint
ALTER TABLE "school_preferences" ADD COLUMN "discount_approval_basis_points" integer;--> statement-breakpoint
ALTER TABLE "school_preferences" ADD COLUMN "discount_approval_pesewas" bigint;--> statement-breakpoint
ALTER TABLE "finance_period_locks" ADD CONSTRAINT "finance_period_locks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_period_locks" ADD CONSTRAINT "finance_period_locks_set_by_user_id_users_id_fk" FOREIGN KEY ("set_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_paid_by_user_id_users_id_fk" FOREIGN KEY ("paid_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_student_fk" FOREIGN KEY ("tenant_id","student_id") REFERENCES "public"."students"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_fee_options" ADD CONSTRAINT "student_fee_options_added_by_user_id_users_id_fk" FOREIGN KEY ("added_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_fee_options" ADD CONSTRAINT "student_fee_options_student_fk" FOREIGN KEY ("tenant_id","student_id") REFERENCES "public"."students"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_fee_options" ADD CONSTRAINT "student_fee_options_item_fk" FOREIGN KEY ("tenant_id","fee_item_id") REFERENCES "public"."fee_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "finance_period_locks_tenant_idx" ON "finance_period_locks" USING btree ("tenant_id","set_at");--> statement-breakpoint
CREATE INDEX "refunds_tenant_idx" ON "refunds" USING btree ("tenant_id","status");--> statement-breakpoint
ALTER TABLE "fee_concessions" ADD CONSTRAINT "fee_concessions_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_tenant_provisional_unique" UNIQUE("tenant_id","provisional_reference");--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_amount_sign" CHECK (("ledger_entries"."kind" in ('charge', 'refund') and "ledger_entries"."amount_pesewas" > 0)
        or ("ledger_entries"."kind" in ('payment', 'discount') and "ledger_entries"."amount_pesewas" < 0)
        or ("ledger_entries"."kind" in ('adjustment', 'opening_balance', 'reversal') and "ledger_entries"."amount_pesewas" <> 0));