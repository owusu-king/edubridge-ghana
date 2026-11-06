CREATE TABLE "fee_reminders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"guardian_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"recipient" text NOT NULL,
	"sent_on" date NOT NULL,
	"balance_pesewas" bigint NOT NULL,
	"sent_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fee_reminders_once_a_day" UNIQUE("tenant_id","student_id","channel","sent_on"),
	CONSTRAINT "fee_reminders_recipient" CHECK ("fee_reminders"."recipient" ~ '^[+][1-9][0-9]{7,14}$'),
	CONSTRAINT "fee_reminders_balance" CHECK ("fee_reminders"."balance_pesewas" between 1 and 1000000000)
);
--> statement-breakpoint
ALTER TABLE "fee_reminders" ADD CONSTRAINT "fee_reminders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_reminders" ADD CONSTRAINT "fee_reminders_sent_by_user_id_users_id_fk" FOREIGN KEY ("sent_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_reminders" ADD CONSTRAINT "fee_reminders_student_fk" FOREIGN KEY ("tenant_id","student_id") REFERENCES "public"."students"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_reminders" ADD CONSTRAINT "fee_reminders_guardian_fk" FOREIGN KEY ("tenant_id","guardian_id") REFERENCES "public"."guardians"("tenant_id","id") ON DELETE no action ON UPDATE no action;