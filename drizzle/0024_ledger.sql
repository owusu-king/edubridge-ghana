CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_number" bigint GENERATED ALWAYS AS IDENTITY (sequence name "ledger_entries_entry_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"term_id" uuid,
	"kind" text NOT NULL,
	"fee_item_id" uuid,
	"description" text NOT NULL,
	"amount_pesewas" bigint NOT NULL,
	"billing_key" text,
	"reverses_entry_id" uuid,
	"effective_on" date NOT NULL,
	"recorded_by_user_id" uuid,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entries_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "ledger_entries_billing_key_unique" UNIQUE("tenant_id","student_id","billing_key"),
	CONSTRAINT "ledger_entries_reversed_once" UNIQUE("reverses_entry_id"),
	CONSTRAINT "ledger_entries_amount_sign" CHECK (("ledger_entries"."kind" = 'charge' and "ledger_entries"."amount_pesewas" > 0)
        or ("ledger_entries"."kind" in ('payment', 'discount') and "ledger_entries"."amount_pesewas" < 0)
        or ("ledger_entries"."kind" in ('adjustment', 'opening_balance', 'reversal') and "ledger_entries"."amount_pesewas" <> 0)),
	CONSTRAINT "ledger_entries_amount_range" CHECK (abs("ledger_entries"."amount_pesewas") <= 1000000000),
	CONSTRAINT "ledger_entries_reversal_link" CHECK (("ledger_entries"."kind" = 'reversal') = ("ledger_entries"."reverses_entry_id" is not null)),
	CONSTRAINT "ledger_entries_description_length" CHECK (char_length("ledger_entries"."description") between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_student_fk" FOREIGN KEY ("tenant_id","student_id") REFERENCES "public"."students"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_term_fk" FOREIGN KEY ("tenant_id","term_id") REFERENCES "public"."terms"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_item_fk" FOREIGN KEY ("tenant_id","fee_item_id") REFERENCES "public"."fee_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_reverses_fk" FOREIGN KEY ("tenant_id","reverses_entry_id") REFERENCES "public"."ledger_entries"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ledger_entries_student_idx" ON "ledger_entries" USING btree ("tenant_id","student_id","effective_on","entry_number");--> statement-breakpoint
CREATE INDEX "ledger_entries_term_idx" ON "ledger_entries" USING btree ("tenant_id","term_id");