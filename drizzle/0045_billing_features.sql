CREATE TABLE "sms_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"outbox_id" uuid NOT NULL,
	"shared_with" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sms_usage_outbox_tenant_unique" UNIQUE("outbox_id","tenant_id"),
	CONSTRAINT "sms_usage_shared_with_range" CHECK ("sms_usage"."shared_with" between 1 and 100)
);
--> statement-breakpoint
CREATE TABLE "subscription_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"invoice_number" text NOT NULL,
	"lines" jsonb NOT NULL,
	"total_pesewas" bigint NOT NULL,
	"currency_code" text NOT NULL,
	"period_starts_on" date NOT NULL,
	"period_ends_on" date NOT NULL,
	"issued_on" date NOT NULL,
	"due_on" date NOT NULL,
	"paid_on" date,
	"payment_reference" text,
	"payment_recorded_by_user_id" uuid,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"voided_by_user_id" uuid,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_invoices_invoice_number_unique" UNIQUE("invoice_number"),
	CONSTRAINT "subscription_invoices_total_range" CHECK ("subscription_invoices"."total_pesewas" between 1 and 1000000000),
	CONSTRAINT "subscription_invoices_period" CHECK ("subscription_invoices"."period_ends_on" >= "subscription_invoices"."period_starts_on"),
	CONSTRAINT "subscription_invoices_due" CHECK ("subscription_invoices"."due_on" >= "subscription_invoices"."issued_on"),
	CONSTRAINT "subscription_invoices_paid_or_void" CHECK ("subscription_invoices"."paid_on" is null or "subscription_invoices"."voided_at" is null),
	CONSTRAINT "subscription_invoices_void_reason" CHECK (("subscription_invoices"."voided_at" is null) = ("subscription_invoices"."void_reason" is null)),
	CONSTRAINT "subscription_invoices_currency_format" CHECK ("subscription_invoices"."currency_code" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
ALTER TABLE "tenant_entitlements" ADD COLUMN "features" text[] DEFAULT ARRAY['attendance','assessment','parent_view','fee_reminders','mobile_money']::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_entitlements" ADD COLUMN "max_sms_per_month" integer;--> statement-breakpoint
ALTER TABLE "tenant_entitlements" ADD COLUMN "subscription_status" text DEFAULT 'trial' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_entitlements" ADD COLUMN "billing_period" text DEFAULT 'termly' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_entitlements" ADD COLUMN "trial_ends_on" date;--> statement-breakpoint
ALTER TABLE "tenant_entitlements" ADD COLUMN "paid_until" date;--> statement-breakpoint
ALTER TABLE "tenant_entitlements" ADD COLUMN "price_pesewas" bigint;--> statement-breakpoint
ALTER TABLE "tenant_entitlements" ADD COLUMN "billing_notes" text;--> statement-breakpoint
ALTER TABLE "sms_usage" ADD CONSTRAINT "sms_usage_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_usage" ADD CONSTRAINT "sms_usage_outbox_id_notification_outbox_id_fk" FOREIGN KEY ("outbox_id") REFERENCES "public"."notification_outbox"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_invoices" ADD CONSTRAINT "subscription_invoices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_invoices" ADD CONSTRAINT "subscription_invoices_payment_recorded_by_user_id_users_id_fk" FOREIGN KEY ("payment_recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_invoices" ADD CONSTRAINT "subscription_invoices_voided_by_user_id_users_id_fk" FOREIGN KEY ("voided_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_invoices" ADD CONSTRAINT "subscription_invoices_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sms_usage_tenant_created_idx" ON "sms_usage" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "subscription_invoices_tenant_idx" ON "subscription_invoices" USING btree ("tenant_id","issued_on");--> statement-breakpoint
ALTER TABLE "tenant_entitlements" ADD CONSTRAINT "tenant_entitlements_features_valid" CHECK ("tenant_entitlements"."features" <@ ARRAY['attendance','assessment','parent_view','fee_reminders','mobile_money']::text[]);--> statement-breakpoint
ALTER TABLE "tenant_entitlements" ADD CONSTRAINT "tenant_entitlements_max_sms_range" CHECK ("tenant_entitlements"."max_sms_per_month" is null or "tenant_entitlements"."max_sms_per_month" between 0 and 1000000);--> statement-breakpoint
ALTER TABLE "tenant_entitlements" ADD CONSTRAINT "tenant_entitlements_price_range" CHECK ("tenant_entitlements"."price_pesewas" is null or "tenant_entitlements"."price_pesewas" between 0 and 1000000000);--> statement-breakpoint
ALTER TABLE "tenant_entitlements" ADD CONSTRAINT "tenant_entitlements_notes_length" CHECK ("tenant_entitlements"."billing_notes" is null or char_length("tenant_entitlements"."billing_notes") <= 500);