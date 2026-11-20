CREATE TABLE "bank_deposit_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"deposit_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"amount_pesewas" bigint NOT NULL,
	"released" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bank_deposits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"deposit_number" text NOT NULL,
	"account_id" uuid NOT NULL,
	"deposited_on" date NOT NULL,
	"slip_reference" text,
	"amount_pesewas" bigint NOT NULL,
	"recorded_by_user_id" uuid,
	"cancelled_at" timestamp with time zone,
	"cancelled_by_user_id" uuid,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_deposits_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "bank_deposits_number_unique" UNIQUE("tenant_id","deposit_number"),
	CONSTRAINT "bank_deposits_amount" CHECK ("bank_deposits"."amount_pesewas" > 0),
	CONSTRAINT "bank_deposits_cancel" CHECK (("bank_deposits"."cancelled_at" is null) = ("bank_deposits"."cancel_reason" is null)
        and ("bank_deposits"."cancel_reason" is null or char_length("bank_deposits"."cancel_reason") between 3 and 200)),
	CONSTRAINT "bank_deposits_slip" CHECK ("bank_deposits"."slip_reference" is null or char_length("bank_deposits"."slip_reference") between 1 and 60)
);
--> statement-breakpoint
CREATE TABLE "bank_statement_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"lines_added" integer NOT NULL,
	"lines_skipped" integer NOT NULL,
	"imported_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_statement_imports_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "bank_statement_imports_name" CHECK (char_length("bank_statement_imports"."file_name") between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "bank_statement_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"import_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"line_on" date NOT NULL,
	"description" text NOT NULL,
	"reference" text,
	"amount_pesewas" bigint NOT NULL,
	"line_key" text NOT NULL,
	"matched_kind" text,
	"matched_id" uuid,
	"match_note" text,
	"matched_by_user_id" uuid,
	"matched_at" timestamp with time zone,
	CONSTRAINT "bank_statement_lines_key_unique" UNIQUE("account_id","line_key"),
	CONSTRAINT "bank_statement_lines_amount" CHECK ("bank_statement_lines"."amount_pesewas" <> 0),
	CONSTRAINT "bank_statement_lines_match" CHECK (("bank_statement_lines"."matched_kind" is null) = ("bank_statement_lines"."matched_at" is null)
        and (("bank_statement_lines"."matched_kind" = 'other') = ("bank_statement_lines"."match_note" is not null))
        and (("bank_statement_lines"."matched_kind" is null or "bank_statement_lines"."matched_kind" = 'other') = ("bank_statement_lines"."matched_id" is null))),
	CONSTRAINT "bank_statement_lines_lengths" CHECK (char_length("bank_statement_lines"."description") between 1 and 300
        and ("bank_statement_lines"."reference" is null or char_length("bank_statement_lines"."reference") between 1 and 120)
        and ("bank_statement_lines"."match_note" is null or char_length("bank_statement_lines"."match_note") between 3 and 200))
);
--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"expense_number" text NOT NULL,
	"spent_on" date NOT NULL,
	"category" text NOT NULL,
	"payee" text NOT NULL,
	"description" text,
	"amount_pesewas" bigint NOT NULL,
	"account_id" uuid NOT NULL,
	"method" text NOT NULL,
	"reference" text,
	"status" text NOT NULL,
	"recorded_by_user_id" uuid,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"voided_by_user_id" uuid,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expenses_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "expenses_number_unique" UNIQUE("tenant_id","expense_number"),
	CONSTRAINT "expenses_amount" CHECK ("expenses"."amount_pesewas" between 1 and 100000000000),
	CONSTRAINT "expenses_lengths" CHECK (char_length("expenses"."category") between 2 and 60 and char_length("expenses"."payee") between 2 and 120
        and ("expenses"."description" is null or char_length("expenses"."description") between 1 and 500)
        and ("expenses"."reference" is null or char_length("expenses"."reference") between 1 and 60)
        and ("expenses"."decision_note" is null or char_length("expenses"."decision_note") between 1 and 200)
        and ("expenses"."void_reason" is null or char_length("expenses"."void_reason") between 3 and 200)),
	CONSTRAINT "expenses_void" CHECK (("expenses"."status" = 'voided') = ("expenses"."voided_at" is not null) and ("expenses"."voided_at" is null) = ("expenses"."void_reason" is null)),
	CONSTRAINT "expenses_decided" CHECK (("expenses"."status" = 'pending') = ("expenses"."decided_at" is null))
);
--> statement-breakpoint
CREATE TABLE "finance_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"institution" text,
	"account_ending" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_accounts_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "finance_accounts_lengths" CHECK (char_length("finance_accounts"."name") between 2 and 80
        and ("finance_accounts"."institution" is null or char_length("finance_accounts"."institution") between 2 and 80)
        and ("finance_accounts"."account_ending" is null or "finance_accounts"."account_ending" ~ '^[0-9]{2,6}$'))
);
--> statement-breakpoint
ALTER TABLE "school_preferences" ADD COLUMN "expense_approval_minor" bigint DEFAULT 100000 NOT NULL;--> statement-breakpoint
ALTER TABLE "bank_deposit_items" ADD CONSTRAINT "bank_deposit_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_deposit_items" ADD CONSTRAINT "bank_deposit_items_deposit_fk" FOREIGN KEY ("tenant_id","deposit_id") REFERENCES "public"."bank_deposits"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_deposit_items" ADD CONSTRAINT "bank_deposit_items_payment_fk" FOREIGN KEY ("tenant_id","payment_id") REFERENCES "public"."payments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_deposits" ADD CONSTRAINT "bank_deposits_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_deposits" ADD CONSTRAINT "bank_deposits_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_deposits" ADD CONSTRAINT "bank_deposits_cancelled_by_user_id_users_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_deposits" ADD CONSTRAINT "bank_deposits_account_fk" FOREIGN KEY ("tenant_id","account_id") REFERENCES "public"."finance_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_imports" ADD CONSTRAINT "bank_statement_imports_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_imports" ADD CONSTRAINT "bank_statement_imports_imported_by_user_id_users_id_fk" FOREIGN KEY ("imported_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_imports" ADD CONSTRAINT "bank_statement_imports_account_fk" FOREIGN KEY ("tenant_id","account_id") REFERENCES "public"."finance_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_matched_by_user_id_users_id_fk" FOREIGN KEY ("matched_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_import_fk" FOREIGN KEY ("tenant_id","import_id") REFERENCES "public"."bank_statement_imports"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_account_fk" FOREIGN KEY ("tenant_id","account_id") REFERENCES "public"."finance_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_voided_by_user_id_users_id_fk" FOREIGN KEY ("voided_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_account_fk" FOREIGN KEY ("tenant_id","account_id") REFERENCES "public"."finance_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_accounts" ADD CONSTRAINT "finance_accounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_accounts" ADD CONSTRAINT "finance_accounts_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bank_deposit_items_one_live" ON "bank_deposit_items" USING btree ("payment_id") WHERE not "bank_deposit_items"."released";--> statement-breakpoint
CREATE INDEX "bank_deposit_items_deposit_idx" ON "bank_deposit_items" USING btree ("tenant_id","deposit_id");--> statement-breakpoint
CREATE INDEX "bank_deposits_account_idx" ON "bank_deposits" USING btree ("tenant_id","account_id","deposited_on");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_statement_lines_one_match" ON "bank_statement_lines" USING btree ("matched_kind","matched_id") WHERE "bank_statement_lines"."matched_id" is not null;--> statement-breakpoint
CREATE INDEX "bank_statement_lines_account_idx" ON "bank_statement_lines" USING btree ("tenant_id","account_id","line_on");--> statement-breakpoint
CREATE INDEX "expenses_spent_idx" ON "expenses" USING btree ("tenant_id","spent_on");--> statement-breakpoint
CREATE UNIQUE INDEX "finance_accounts_name_unique" ON "finance_accounts" USING btree ("tenant_id",lower("name"));