CREATE TABLE "fee_concessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"label" text NOT NULL,
	"fee_item_id" uuid,
	"percent_basis_points" integer,
	"amount_pesewas" bigint,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by_user_id" uuid,
	"ended_at" timestamp with time zone,
	"ended_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fee_concessions_label_length" CHECK (char_length("fee_concessions"."label") between 2 and 60),
	CONSTRAINT "fee_concessions_one_kind" CHECK (("fee_concessions"."percent_basis_points" is null) <> ("fee_concessions"."amount_pesewas" is null)),
	CONSTRAINT "fee_concessions_percent_range" CHECK ("fee_concessions"."percent_basis_points" is null or "fee_concessions"."percent_basis_points" between 1 and 10000),
	CONSTRAINT "fee_concessions_amount_range" CHECK ("fee_concessions"."amount_pesewas" is null or ("fee_concessions"."amount_pesewas" between 1 and 1000000000 and "fee_concessions"."fee_item_id" is not null)),
	CONSTRAINT "fee_concessions_ended" CHECK (("fee_concessions"."status" = 'ended') = ("fee_concessions"."ended_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "fee_concessions" ADD CONSTRAINT "fee_concessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_concessions" ADD CONSTRAINT "fee_concessions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_concessions" ADD CONSTRAINT "fee_concessions_ended_by_user_id_users_id_fk" FOREIGN KEY ("ended_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_concessions" ADD CONSTRAINT "fee_concessions_student_fk" FOREIGN KEY ("tenant_id","student_id") REFERENCES "public"."students"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_concessions" ADD CONSTRAINT "fee_concessions_item_fk" FOREIGN KEY ("tenant_id","fee_item_id") REFERENCES "public"."fee_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fee_concessions_student_idx" ON "fee_concessions" USING btree ("tenant_id","student_id");