CREATE TABLE "payment_plan_instalments" (
	"tenant_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"due_on" date NOT NULL,
	"amount_pesewas" bigint NOT NULL,
	CONSTRAINT "payment_plan_instalments_plan_id_sequence_pk" PRIMARY KEY("plan_id","sequence"),
	CONSTRAINT "payment_plan_instalments_sequence_range" CHECK ("payment_plan_instalments"."sequence" between 1 and 12),
	CONSTRAINT "payment_plan_instalments_amount_range" CHECK ("payment_plan_instalments"."amount_pesewas" between 1 and 1000000000)
);
--> statement-breakpoint
CREATE TABLE "payment_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"total_pesewas" bigint NOT NULL,
	"starts_on" date NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by_user_id" uuid,
	"cancelled_at" timestamp with time zone,
	"cancelled_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_plans_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "payment_plans_total_range" CHECK ("payment_plans"."total_pesewas" between 1 and 1000000000),
	CONSTRAINT "payment_plans_cancelled" CHECK (("payment_plans"."status" = 'cancelled') = ("payment_plans"."cancelled_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "payment_plan_instalments" ADD CONSTRAINT "payment_plan_instalments_plan_fk" FOREIGN KEY ("tenant_id","plan_id") REFERENCES "public"."payment_plans"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_plans" ADD CONSTRAINT "payment_plans_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_plans" ADD CONSTRAINT "payment_plans_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_plans" ADD CONSTRAINT "payment_plans_cancelled_by_user_id_users_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_plans" ADD CONSTRAINT "payment_plans_student_fk" FOREIGN KEY ("tenant_id","student_id") REFERENCES "public"."students"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_plans_student_idx" ON "payment_plans" USING btree ("tenant_id","student_id");