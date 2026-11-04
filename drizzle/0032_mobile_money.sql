CREATE TABLE "mobile_money_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"network" text NOT NULL,
	"msisdn" text NOT NULL,
	"amount_pesewas" bigint NOT NULL,
	"currency" text DEFAULT 'GHS' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"provider_reference" text,
	"transaction_id" text,
	"status_reason" text,
	"payment_id" uuid,
	"idempotency_key" text NOT NULL,
	"requested_by_user_id" uuid,
	"last_checked_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mobile_money_requests_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "mobile_money_requests_tenant_idempotency_unique" UNIQUE("tenant_id","idempotency_key"),
	CONSTRAINT "mobile_money_requests_payment_unique" UNIQUE("payment_id"),
	CONSTRAINT "mobile_money_requests_amount_range" CHECK ("mobile_money_requests"."amount_pesewas" between 1 and 1000000000),
	CONSTRAINT "mobile_money_requests_currency" CHECK ("mobile_money_requests"."currency" = 'GHS'),
	CONSTRAINT "mobile_money_requests_msisdn" CHECK ("mobile_money_requests"."msisdn" ~ '^[+]233[25][0-9]{8}$'),
	CONSTRAINT "mobile_money_requests_paid" CHECK (("mobile_money_requests"."status" = 'successful') = ("mobile_money_requests"."payment_id" is not null)),
	CONSTRAINT "mobile_money_requests_reason" CHECK (("mobile_money_requests"."status" in ('failed', 'needs_review')) = ("mobile_money_requests"."status_reason" is not null)),
	CONSTRAINT "mobile_money_requests_completed" CHECK (("mobile_money_requests"."status" in ('successful', 'failed', 'needs_review')) = ("mobile_money_requests"."completed_at" is not null)),
	CONSTRAINT "mobile_money_requests_lengths" CHECK (char_length("mobile_money_requests"."provider") between 1 and 40
        and ("mobile_money_requests"."provider_reference" is null or char_length("mobile_money_requests"."provider_reference") between 1 and 120)
        and ("mobile_money_requests"."transaction_id" is null or char_length("mobile_money_requests"."transaction_id") between 1 and 60)
        and ("mobile_money_requests"."status_reason" is null or char_length("mobile_money_requests"."status_reason") between 1 and 200))
);
--> statement-breakpoint
ALTER TABLE "mobile_money_requests" ADD CONSTRAINT "mobile_money_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mobile_money_requests" ADD CONSTRAINT "mobile_money_requests_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mobile_money_requests" ADD CONSTRAINT "mobile_money_requests_student_fk" FOREIGN KEY ("tenant_id","student_id") REFERENCES "public"."students"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mobile_money_requests" ADD CONSTRAINT "mobile_money_requests_payment_fk" FOREIGN KEY ("tenant_id","payment_id") REFERENCES "public"."payments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mobile_money_requests_student_idx" ON "mobile_money_requests" USING btree ("tenant_id","student_id","created_at");