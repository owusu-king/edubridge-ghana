CREATE TABLE "mobile_money_request_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"amount_pesewas" bigint NOT NULL,
	"payment_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mobile_money_request_shares_one_per_child" UNIQUE("request_id","student_id"),
	CONSTRAINT "mobile_money_request_shares_payment_unique" UNIQUE("payment_id"),
	CONSTRAINT "mobile_money_request_shares_amount_range" CHECK ("mobile_money_request_shares"."amount_pesewas" between 1 and 1000000000)
);
--> statement-breakpoint
ALTER TABLE "mobile_money_request_shares" ADD CONSTRAINT "mobile_money_request_shares_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mobile_money_request_shares" ADD CONSTRAINT "mobile_money_request_shares_request_fk" FOREIGN KEY ("tenant_id","request_id") REFERENCES "public"."mobile_money_requests"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mobile_money_request_shares" ADD CONSTRAINT "mobile_money_request_shares_student_fk" FOREIGN KEY ("tenant_id","student_id") REFERENCES "public"."students"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mobile_money_request_shares" ADD CONSTRAINT "mobile_money_request_shares_payment_fk" FOREIGN KEY ("tenant_id","payment_id") REFERENCES "public"."payments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mobile_money_request_shares_student_idx" ON "mobile_money_request_shares" USING btree ("tenant_id","student_id");