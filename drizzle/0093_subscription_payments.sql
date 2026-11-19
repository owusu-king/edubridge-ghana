CREATE TABLE "subscription_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"provider" text NOT NULL,
	"amount_pesewas" bigint NOT NULL,
	"currency_code" text NOT NULL,
	"status" text DEFAULT 'initiated' NOT NULL,
	"provider_reference" text,
	"channel" text,
	"paid_at" timestamp with time zone,
	"initiated_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_payments_reference_unique" UNIQUE("reference"),
	CONSTRAINT "subscription_payments_amount" CHECK ("subscription_payments"."amount_pesewas" between 1 and 1000000000),
	CONSTRAINT "subscription_payments_currency" CHECK ("subscription_payments"."currency_code" ~ '^[A-Z]{3}$'),
	CONSTRAINT "subscription_payments_paid" CHECK (("subscription_payments"."status" = 'succeeded') = ("subscription_payments"."paid_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "subscription_payments" ADD CONSTRAINT "subscription_payments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_payments" ADD CONSTRAINT "subscription_payments_invoice_id_subscription_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."subscription_invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_payments" ADD CONSTRAINT "subscription_payments_initiated_by_user_id_users_id_fk" FOREIGN KEY ("initiated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "subscription_payments_invoice_idx" ON "subscription_payments" USING btree ("tenant_id","invoice_id");