CREATE TABLE "plan_change_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"preset_id" uuid,
	"message" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_change_requests_what" CHECK ("plan_change_requests"."preset_id" is not null or "plan_change_requests"."message" is not null),
	CONSTRAINT "plan_change_requests_text_lengths" CHECK (coalesce(char_length("plan_change_requests"."message"), 0) <= 500 and coalesce(char_length("plan_change_requests"."decision_note"), 0) <= 300),
	CONSTRAINT "plan_change_requests_decided" CHECK (("plan_change_requests"."status" = 'pending') = ("plan_change_requests"."decided_at" is null))
);
--> statement-breakpoint
CREATE TABLE "plan_presets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" "citext" NOT NULL,
	"description" text,
	"features" text[] NOT NULL,
	"max_campuses" integer DEFAULT 1 NOT NULL,
	"max_students" integer,
	"max_sms_per_month" integer,
	"billing_period" text DEFAULT 'termly' NOT NULL,
	"price_pesewas" bigint,
	"currency_code" text DEFAULT 'GHS' NOT NULL,
	"archived_at" timestamp with time zone,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_presets_name_unique" UNIQUE("name"),
	CONSTRAINT "plan_presets_name_length" CHECK (char_length("plan_presets"."name") between 2 and 60),
	CONSTRAINT "plan_presets_description_length" CHECK (coalesce(char_length("plan_presets"."description"), 0) <= 300),
	CONSTRAINT "plan_presets_max_campuses" CHECK ("plan_presets"."max_campuses" between 1 and 1000),
	CONSTRAINT "plan_presets_max_students" CHECK ("plan_presets"."max_students" is null or "plan_presets"."max_students" between 1 and 1000000),
	CONSTRAINT "plan_presets_max_sms" CHECK ("plan_presets"."max_sms_per_month" is null or "plan_presets"."max_sms_per_month" between 0 and 1000000),
	CONSTRAINT "plan_presets_price" CHECK ("plan_presets"."price_pesewas" is null or "plan_presets"."price_pesewas" between 0 and 1000000000),
	CONSTRAINT "plan_presets_currency" CHECK ("plan_presets"."currency_code" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "invoice_issuer_details" text;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "invoice_payment_instructions" text;--> statement-breakpoint
ALTER TABLE "tenant_entitlements" ADD COLUMN "plan_preset_id" uuid;--> statement-breakpoint
ALTER TABLE "tenant_entitlements" ADD COLUMN "status_auto" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "plan_change_requests" ADD CONSTRAINT "plan_change_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_change_requests" ADD CONSTRAINT "plan_change_requests_preset_id_plan_presets_id_fk" FOREIGN KEY ("preset_id") REFERENCES "public"."plan_presets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_change_requests" ADD CONSTRAINT "plan_change_requests_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_change_requests" ADD CONSTRAINT "plan_change_requests_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_presets" ADD CONSTRAINT "plan_presets_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plan_change_requests_tenant_idx" ON "plan_change_requests" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "plan_change_requests_one_pending" ON "plan_change_requests" USING btree ("tenant_id") WHERE "plan_change_requests"."status" = 'pending';