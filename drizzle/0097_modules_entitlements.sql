CREATE TABLE "catalog_prices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"preset_id" uuid,
	"module" text,
	"billing_period" text NOT NULL,
	"currency_code" text NOT NULL,
	"price_pesewas" bigint NOT NULL,
	"unit" text NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "catalog_prices_owner" CHECK (("catalog_prices"."preset_id" is null) <> ("catalog_prices"."module" is null)),
	CONSTRAINT "catalog_prices_module_valid" CHECK ("catalog_prices"."module" is null or "catalog_prices"."module" = any(ARRAY['attendance','assessment','parent_view','fee_reminders','mobile_money','assistant','admissions','whatsapp','staff_hr','payroll','safeguarding','visitors_pickup','transport','inventory_assets','library','boarding','forecasting','early_warning','command_center','ai_drafting']::text[])),
	CONSTRAINT "catalog_prices_price" CHECK ("catalog_prices"."price_pesewas" between 0 and 1000000000),
	CONSTRAINT "catalog_prices_currency" CHECK ("catalog_prices"."currency_code" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "module_release_access" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"module" text NOT NULL,
	"granted_by_user_id" uuid NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"ended_by_user_id" uuid,
	CONSTRAINT "module_release_access_module_valid" CHECK ("module_release_access"."module" = any(ARRAY['attendance','assessment','parent_view','fee_reminders','mobile_money','assistant','admissions','whatsapp','staff_hr','payroll','safeguarding','visitors_pickup','transport','inventory_assets','library','boarding','forecasting','early_warning','command_center','ai_drafting']::text[])),
	CONSTRAINT "module_release_access_ended" CHECK (("module_release_access"."ended_at" is null) = ("module_release_access"."ended_by_user_id" is null))
);
--> statement-breakpoint
CREATE TABLE "school_modules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"module" text NOT NULL,
	"source" text NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date,
	"billing_period" text,
	"price_pesewas" bigint,
	"price_unit" text,
	"currency_code" text,
	"note" text,
	"granted_by_user_id" uuid NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"ended_by_user_id" uuid,
	"end_reason" text,
	CONSTRAINT "school_modules_module_valid" CHECK ("school_modules"."module" = any(ARRAY['attendance','assessment','parent_view','fee_reminders','mobile_money','assistant','admissions','whatsapp','staff_hr','payroll','safeguarding','visitors_pickup','transport','inventory_assets','library','boarding','forecasting','early_warning','command_center','ai_drafting']::text[])),
	CONSTRAINT "school_modules_dates" CHECK ("school_modules"."ends_on" is null or "school_modules"."ends_on" >= "school_modules"."starts_on"),
	CONSTRAINT "school_modules_price" CHECK (("school_modules"."price_pesewas" is null and "school_modules"."price_unit" is null and "school_modules"."currency_code" is null and "school_modules"."billing_period" is null)
        or ("school_modules"."price_pesewas" between 0 and 1000000000 and "school_modules"."price_unit" is not null and "school_modules"."currency_code" ~ '^[A-Z]{3}$' and "school_modules"."billing_period" is not null)),
	CONSTRAINT "school_modules_ended" CHECK (("school_modules"."ended_at" is null and "school_modules"."ended_by_user_id" is null and "school_modules"."end_reason" is null)
        or ("school_modules"."ended_at" is not null and "school_modules"."ended_by_user_id" is not null and char_length("school_modules"."end_reason") between 3 and 300)),
	CONSTRAINT "school_modules_note_length" CHECK (coalesce(char_length("school_modules"."note"), 0) <= 300)
);
--> statement-breakpoint
ALTER TABLE "plan_change_requests" DROP CONSTRAINT "plan_change_requests_what";--> statement-breakpoint
ALTER TABLE "tenant_entitlements" DROP CONSTRAINT "tenant_entitlements_features_valid";--> statement-breakpoint
ALTER TABLE "plan_change_requests" ADD COLUMN "kind" text DEFAULT 'plan' NOT NULL;--> statement-breakpoint
ALTER TABLE "plan_change_requests" ADD COLUMN "module" text;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "module_read_only_days" integer DEFAULT 90 NOT NULL;--> statement-breakpoint
ALTER TABLE "catalog_prices" ADD CONSTRAINT "catalog_prices_preset_id_plan_presets_id_fk" FOREIGN KEY ("preset_id") REFERENCES "public"."plan_presets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_prices" ADD CONSTRAINT "catalog_prices_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "module_release_access" ADD CONSTRAINT "module_release_access_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "module_release_access" ADD CONSTRAINT "module_release_access_granted_by_user_id_users_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "module_release_access" ADD CONSTRAINT "module_release_access_ended_by_user_id_users_id_fk" FOREIGN KEY ("ended_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "school_modules" ADD CONSTRAINT "school_modules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "school_modules" ADD CONSTRAINT "school_modules_granted_by_user_id_users_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "school_modules" ADD CONSTRAINT "school_modules_ended_by_user_id_users_id_fk" FOREIGN KEY ("ended_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_prices_one_preset_price" ON "catalog_prices" USING btree ("preset_id","billing_period","currency_code") WHERE "catalog_prices"."archived_at" is null and "catalog_prices"."preset_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_prices_one_module_price" ON "catalog_prices" USING btree ("module","billing_period","currency_code") WHERE "catalog_prices"."archived_at" is null and "catalog_prices"."module" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "module_release_access_one_open" ON "module_release_access" USING btree ("tenant_id","module") WHERE "module_release_access"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "school_modules_tenant_idx" ON "school_modules" USING btree ("tenant_id","module");--> statement-breakpoint
ALTER TABLE "plan_change_requests" ADD CONSTRAINT "plan_change_requests_module_valid" CHECK ("plan_change_requests"."module" is null or "plan_change_requests"."module" = any(ARRAY['attendance','assessment','parent_view','fee_reminders','mobile_money','assistant','admissions','whatsapp','staff_hr','payroll','safeguarding','visitors_pickup','transport','inventory_assets','library','boarding','forecasting','early_warning','command_center','ai_drafting']::text[]));--> statement-breakpoint
ALTER TABLE "plan_change_requests" ADD CONSTRAINT "plan_change_requests_what" CHECK (("plan_change_requests"."kind" = 'plan' and "plan_change_requests"."module" is null and ("plan_change_requests"."preset_id" is not null or "plan_change_requests"."message" is not null))
        or ("plan_change_requests"."kind" <> 'plan' and "plan_change_requests"."module" is not null and "plan_change_requests"."preset_id" is null));--> statement-breakpoint
ALTER TABLE "platform_settings" ADD CONSTRAINT "platform_settings_read_only_days_range" CHECK ("platform_settings"."module_read_only_days" between 0 and 365);--> statement-breakpoint
ALTER TABLE "tenant_entitlements" ADD CONSTRAINT "tenant_entitlements_features_valid" CHECK ("tenant_entitlements"."features" <@ ARRAY['attendance','assessment','parent_view','fee_reminders','mobile_money','assistant','admissions','whatsapp','staff_hr','payroll','safeguarding','visitors_pickup','transport','inventory_assets','library','boarding','forecasting','early_warning','command_center','ai_drafting']::text[]);