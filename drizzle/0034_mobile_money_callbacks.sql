CREATE TABLE "mobile_money_callbacks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"request_id" uuid,
	"provider_reference" text,
	"body_sha256" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"processed_at" timestamp with time zone,
	"result" text,
	CONSTRAINT "mobile_money_callbacks_dedupe" UNIQUE("tenant_id","provider","body_sha256"),
	CONSTRAINT "mobile_money_callbacks_lengths" CHECK (char_length("mobile_money_callbacks"."provider") between 1 and 40
        and ("mobile_money_callbacks"."provider_reference" is null or char_length("mobile_money_callbacks"."provider_reference") between 1 and 120)
        and char_length("mobile_money_callbacks"."body_sha256") = 64
        and ("mobile_money_callbacks"."result" is null or char_length("mobile_money_callbacks"."result") between 1 and 40)),
	CONSTRAINT "mobile_money_callbacks_ref" CHECK ("mobile_money_callbacks"."request_id" is not null or "mobile_money_callbacks"."provider_reference" is not null),
	CONSTRAINT "mobile_money_callbacks_processed" CHECK (("mobile_money_callbacks"."processed_at" is null) = ("mobile_money_callbacks"."result" is null))
);
--> statement-breakpoint
ALTER TABLE "mobile_money_requests" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mobile_money_requests" ADD COLUMN "reviewed_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "mobile_money_requests" ADD COLUMN "review_note" text;--> statement-breakpoint
ALTER TABLE "mobile_money_callbacks" ADD CONSTRAINT "mobile_money_callbacks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mobile_money_callbacks_unprocessed_idx" ON "mobile_money_callbacks" USING btree ("tenant_id","received_at");--> statement-breakpoint
ALTER TABLE "mobile_money_requests" ADD CONSTRAINT "mobile_money_requests_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mobile_money_requests" ADD CONSTRAINT "mobile_money_requests_review" CHECK (("mobile_money_requests"."reviewed_at" is null) = ("mobile_money_requests"."review_note" is null)
        and ("mobile_money_requests"."reviewed_at" is null or "mobile_money_requests"."status" = 'needs_review')
        and ("mobile_money_requests"."review_note" is null or char_length("mobile_money_requests"."review_note") between 3 and 200));