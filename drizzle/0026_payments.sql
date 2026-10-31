CREATE TABLE "payment_voids" (
	"payment_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"voided_by_user_id" uuid,
	"voided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_voids_reason_length" CHECK (char_length("payment_voids"."reason") between 3 and 120)
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"receipt_number" text NOT NULL,
	"amount_pesewas" bigint NOT NULL,
	"method" text NOT NULL,
	"reference" text,
	"payer_name" text,
	"paid_on" date NOT NULL,
	"idempotency_key" text NOT NULL,
	"recorded_by_user_id" uuid,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "payments_tenant_receipt_unique" UNIQUE("tenant_id","receipt_number"),
	CONSTRAINT "payments_tenant_idempotency_unique" UNIQUE("tenant_id","idempotency_key"),
	CONSTRAINT "payments_amount_range" CHECK ("payments"."amount_pesewas" between 1 and 1000000000),
	CONSTRAINT "payments_reference_length" CHECK ("payments"."reference" is null or char_length("payments"."reference") between 1 and 60),
	CONSTRAINT "payments_payer_length" CHECK ("payments"."payer_name" is null or char_length("payments"."payer_name") between 1 and 120)
);
--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD COLUMN "payment_id" uuid;--> statement-breakpoint
ALTER TABLE "payment_voids" ADD CONSTRAINT "payment_voids_voided_by_user_id_users_id_fk" FOREIGN KEY ("voided_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_voids" ADD CONSTRAINT "payment_voids_payment_fk" FOREIGN KEY ("tenant_id","payment_id") REFERENCES "public"."payments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_student_fk" FOREIGN KEY ("tenant_id","student_id") REFERENCES "public"."students"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payments_tenant_paid_on_idx" ON "payments" USING btree ("tenant_id","paid_on");--> statement-breakpoint
CREATE INDEX "payments_student_idx" ON "payments" USING btree ("tenant_id","student_id");--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_payment_fk" FOREIGN KEY ("tenant_id","payment_id") REFERENCES "public"."payments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_payment_link" CHECK (("ledger_entries"."kind" = 'payment') <= ("ledger_entries"."payment_id" is not null));