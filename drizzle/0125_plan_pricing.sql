CREATE TABLE "sms_top_ups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"month" text NOT NULL,
	"messages" integer NOT NULL,
	"price_pesewas" bigint NOT NULL,
	"currency_code" text NOT NULL,
	"invoice_id" uuid,
	"added_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sms_top_ups_month" CHECK ("sms_top_ups"."month" ~ '^[0-9]{4}-[0-9]{2}$'),
	CONSTRAINT "sms_top_ups_messages" CHECK ("sms_top_ups"."messages" between 1 and 1000000),
	CONSTRAINT "sms_top_ups_price" CHECK ("sms_top_ups"."price_pesewas" between 0 and 1000000000),
	CONSTRAINT "sms_top_ups_currency_format" CHECK ("sms_top_ups"."currency_code" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "subscription_census" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"term_id" uuid NOT NULL,
	"counted_on" date NOT NULL,
	"active_students" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_census_term_unique" UNIQUE("tenant_id","term_id"),
	CONSTRAINT "subscription_census_count" CHECK ("subscription_census"."active_students" between 0 and 1000000)
);
--> statement-breakpoint
ALTER TABLE "subscription_invoices" ALTER COLUMN "created_by_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "plan_presets" ADD COLUMN "price_bands" jsonb;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "auto_invoicing" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "census_days" integer DEFAULT 21 NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "invoice_due_days" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "annual_discount_bp" integer DEFAULT 1200 NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "monthly_surcharge_bp" integer DEFAULT 1000 NOT NULL;--> statement-breakpoint
ALTER TABLE "subscription_invoices" ADD COLUMN "automatic" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "subscription_invoices" ADD COLUMN "student_count" integer;--> statement-breakpoint
ALTER TABLE "tenant_entitlements" ADD COLUMN "price_bands" jsonb;--> statement-breakpoint
ALTER TABLE "tenant_entitlements" ADD COLUMN "discount_bp" integer;--> statement-breakpoint
ALTER TABLE "tenant_entitlements" ADD COLUMN "discount_until" date;--> statement-breakpoint
ALTER TABLE "tenant_entitlements" ADD COLUMN "discount_label" text;--> statement-breakpoint
ALTER TABLE "sms_top_ups" ADD CONSTRAINT "sms_top_ups_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_top_ups" ADD CONSTRAINT "sms_top_ups_invoice_id_subscription_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."subscription_invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_top_ups" ADD CONSTRAINT "sms_top_ups_added_by_user_id_users_id_fk" FOREIGN KEY ("added_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_census" ADD CONSTRAINT "subscription_census_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_census" ADD CONSTRAINT "subscription_census_term_fk" FOREIGN KEY ("tenant_id","term_id") REFERENCES "public"."terms"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sms_top_ups_tenant_idx" ON "sms_top_ups" USING btree ("tenant_id","month");--> statement-breakpoint
ALTER TABLE "subscription_invoices" ADD CONSTRAINT "subscription_invoices_issuer" CHECK ("subscription_invoices"."automatic" or "subscription_invoices"."created_by_user_id" is not null);