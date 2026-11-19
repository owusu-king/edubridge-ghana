CREATE TABLE "pay_components" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" "citext" NOT NULL,
	"kind" text NOT NULL,
	"basis" text NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pay_components_tenant_name_unique" UNIQUE("tenant_id","name"),
	CONSTRAINT "pay_components_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "pay_components_name_length" CHECK (char_length("pay_components"."name") between 2 and 60),
	CONSTRAINT "pay_components_basis" CHECK (not ("pay_components"."kind" = 'earning' and "pay_components"."basis" = 'percent_gross'))
);
--> statement-breakpoint
CREATE TABLE "payroll_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"month" text NOT NULL,
	"kind" text NOT NULL,
	"description" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_run_id" uuid,
	"cancelled_by_user_id" uuid,
	"cancelled_at" timestamp with time zone,
	CONSTRAINT "payroll_adjustments_month" CHECK ("payroll_adjustments"."month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "payroll_adjustments_amount" CHECK ("payroll_adjustments"."amount_minor" between 1 and 100000000000),
	CONSTRAINT "payroll_adjustments_description" CHECK (char_length("payroll_adjustments"."description") between 3 and 120),
	CONSTRAINT "payroll_adjustments_once" CHECK ("payroll_adjustments"."applied_run_id" is null or "payroll_adjustments"."cancelled_at" is null)
);
--> statement-breakpoint
CREATE TABLE "payroll_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"staff_name" text NOT NULL,
	"staff_number" text NOT NULL,
	"position" text,
	"salary_id" uuid NOT NULL,
	"basic_minor" bigint NOT NULL,
	"gross_minor" bigint NOT NULL,
	"deductions_minor" bigint NOT NULL,
	"net_minor" bigint NOT NULL,
	"employer_minor" bigint NOT NULL,
	"items" jsonb NOT NULL,
	CONSTRAINT "payroll_lines_run_staff_unique" UNIQUE("run_id","staff_id"),
	CONSTRAINT "payroll_lines_sums" CHECK ("payroll_lines"."net_minor" = "payroll_lines"."gross_minor" - "payroll_lines"."deductions_minor")
);
--> statement-breakpoint
CREATE TABLE "payroll_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"month" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"currency_code" text NOT NULL,
	"prepared_by_user_id" uuid NOT NULL,
	"prepared_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_by_user_id" uuid,
	"approved_at" timestamp with time zone,
	"cancelled_by_user_id" uuid,
	"cancelled_at" timestamp with time zone,
	CONSTRAINT "payroll_runs_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "payroll_runs_month" CHECK ("payroll_runs"."month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "payroll_runs_currency" CHECK ("payroll_runs"."currency_code" ~ '^[A-Z]{3}$'),
	CONSTRAINT "payroll_runs_states" CHECK (("payroll_runs"."status" = 'approved') = ("payroll_runs"."approved_at" is not null) and ("payroll_runs"."status" = 'cancelled') = ("payroll_runs"."cancelled_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "staff_salaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"effective_month" text NOT NULL,
	"basic_minor" bigint NOT NULL,
	"currency_code" text NOT NULL,
	"note" text,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_salaries_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "staff_salaries_month" CHECK ("staff_salaries"."effective_month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "staff_salaries_basic" CHECK ("staff_salaries"."basic_minor" between 0 and 100000000000),
	CONSTRAINT "staff_salaries_currency" CHECK ("staff_salaries"."currency_code" ~ '^[A-Z]{3}$'),
	CONSTRAINT "staff_salaries_note_length" CHECK (coalesce(char_length("staff_salaries"."note"), 0) <= 300)
);
--> statement-breakpoint
CREATE TABLE "staff_salary_components" (
	"tenant_id" uuid NOT NULL,
	"salary_id" uuid NOT NULL,
	"component_id" uuid NOT NULL,
	"value" bigint NOT NULL,
	CONSTRAINT "staff_salary_components_salary_id_component_id_pk" PRIMARY KEY("salary_id","component_id"),
	CONSTRAINT "staff_salary_components_value" CHECK ("staff_salary_components"."value" between 0 and 100000000000)
);
--> statement-breakpoint
ALTER TABLE "pay_components" ADD CONSTRAINT "pay_components_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_adjustments" ADD CONSTRAINT "payroll_adjustments_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_adjustments" ADD CONSTRAINT "payroll_adjustments_cancelled_by_user_id_users_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_adjustments" ADD CONSTRAINT "payroll_adjustments_tenant_id_staff_id_staff_tenant_id_id_fk" FOREIGN KEY ("tenant_id","staff_id") REFERENCES "public"."staff"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_adjustments" ADD CONSTRAINT "payroll_adjustments_tenant_id_applied_run_id_payroll_runs_tenant_id_id_fk" FOREIGN KEY ("tenant_id","applied_run_id") REFERENCES "public"."payroll_runs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_tenant_id_run_id_payroll_runs_tenant_id_id_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."payroll_runs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_tenant_id_staff_id_staff_tenant_id_id_fk" FOREIGN KEY ("tenant_id","staff_id") REFERENCES "public"."staff"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_tenant_id_salary_id_staff_salaries_tenant_id_id_fk" FOREIGN KEY ("tenant_id","salary_id") REFERENCES "public"."staff_salaries"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_prepared_by_user_id_users_id_fk" FOREIGN KEY ("prepared_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_cancelled_by_user_id_users_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_salaries" ADD CONSTRAINT "staff_salaries_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_salaries" ADD CONSTRAINT "staff_salaries_tenant_id_staff_id_staff_tenant_id_id_fk" FOREIGN KEY ("tenant_id","staff_id") REFERENCES "public"."staff"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_salary_components" ADD CONSTRAINT "staff_salary_components_tenant_id_salary_id_staff_salaries_tenant_id_id_fk" FOREIGN KEY ("tenant_id","salary_id") REFERENCES "public"."staff_salaries"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_salary_components" ADD CONSTRAINT "staff_salary_components_tenant_id_component_id_pay_components_tenant_id_id_fk" FOREIGN KEY ("tenant_id","component_id") REFERENCES "public"."pay_components"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payroll_adjustments_staff_idx" ON "payroll_adjustments" USING btree ("tenant_id","staff_id");--> statement-breakpoint
CREATE INDEX "payroll_lines_staff_idx" ON "payroll_lines" USING btree ("tenant_id","staff_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_runs_one_per_month" ON "payroll_runs" USING btree ("tenant_id","month") WHERE "payroll_runs"."status" <> 'cancelled';--> statement-breakpoint
CREATE INDEX "staff_salaries_staff_idx" ON "staff_salaries" USING btree ("tenant_id","staff_id","effective_month");