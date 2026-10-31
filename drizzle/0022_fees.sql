CREATE TABLE "fee_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" "citext" NOT NULL,
	"sequence" integer NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fee_items_tenant_name_unique" UNIQUE("tenant_id","name"),
	CONSTRAINT "fee_items_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "fee_items_name_length" CHECK (char_length("fee_items"."name") between 1 and 60)
);
--> statement-breakpoint
CREATE TABLE "fee_structure_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"term_id" uuid NOT NULL,
	"fee_item_id" uuid NOT NULL,
	"level_id" uuid NOT NULL,
	"class_id" uuid,
	"amount_pesewas" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fee_structure_lines_unique" UNIQUE NULLS NOT DISTINCT("term_id","fee_item_id","level_id","class_id"),
	CONSTRAINT "fee_structure_lines_amount_range" CHECK ("fee_structure_lines"."amount_pesewas" between 0 and 1000000000)
);
--> statement-breakpoint
ALTER TABLE "fee_items" ADD CONSTRAINT "fee_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_structure_lines" ADD CONSTRAINT "fee_structure_lines_term_fk" FOREIGN KEY ("tenant_id","term_id") REFERENCES "public"."terms"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_structure_lines" ADD CONSTRAINT "fee_structure_lines_item_fk" FOREIGN KEY ("tenant_id","fee_item_id") REFERENCES "public"."fee_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_structure_lines" ADD CONSTRAINT "fee_structure_lines_level_fk" FOREIGN KEY ("tenant_id","level_id") REFERENCES "public"."levels"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_structure_lines" ADD CONSTRAINT "fee_structure_lines_class_fk" FOREIGN KEY ("tenant_id","class_id") REFERENCES "public"."classes"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fee_structure_lines_term_idx" ON "fee_structure_lines" USING btree ("tenant_id","term_id");