CREATE TABLE "ai_feature_flags" (
	"task" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" uuid
);
--> statement-breakpoint
CREATE TABLE "ai_platform_months" (
	"month" date PRIMARY KEY NOT NULL,
	"tokens" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_school_limits" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"monthly_tokens" integer,
	"user_per_hour" integer,
	"user_daily_tokens" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" uuid
);
--> statement-breakpoint
CREATE TABLE "ai_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid,
	"request_id" uuid NOT NULL,
	"task" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cached_input_tokens" integer DEFAULT 0 NOT NULL,
	"cost_micros" bigint,
	"outcome" text NOT NULL,
	"detail" text,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "ai_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "ai_provider" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "ai_base_url" text;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "ai_identifiable_approved" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "ai_platform_monthly_tokens" integer DEFAULT 5000000 NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "ai_school_monthly_tokens" integer DEFAULT 500000 NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "ai_user_per_minute" integer DEFAULT 4 NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "ai_user_per_hour" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "ai_user_daily_tokens" integer DEFAULT 100000 NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "ai_max_output_tokens" integer DEFAULT 1500 NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_feature_flags" ADD CONSTRAINT "ai_feature_flags_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_school_limits" ADD CONSTRAINT "ai_school_limits_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_school_limits" ADD CONSTRAINT "ai_school_limits_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_usage_tenant_idx" ON "ai_usage" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_usage_user_idx" ON "ai_usage" USING btree ("tenant_id","user_id","created_at");