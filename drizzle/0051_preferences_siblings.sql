CREATE TABLE "school_preferences" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"accountants_can_void" boolean DEFAULT false NOT NULL,
	"collection_rate_basis" text DEFAULT 'due' NOT NULL,
	"attendance_concern_percent" integer DEFAULT 80 NOT NULL,
	"attendance_concern_min_days" integer DEFAULT 5 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" uuid,
	CONSTRAINT "school_preferences_concern_percent" CHECK ("school_preferences"."attendance_concern_percent" between 1 and 100),
	CONSTRAINT "school_preferences_concern_days" CHECK ("school_preferences"."attendance_concern_min_days" between 1 and 100)
);
--> statement-breakpoint
CREATE TABLE "sibling_discount_rules" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"first_child" text DEFAULT 'eldest' NOT NULL,
	"second_percent_basis_points" integer,
	"later_percent_basis_points" integer,
	"fee_item_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" uuid,
	CONSTRAINT "sibling_discount_rules_second" CHECK ("sibling_discount_rules"."second_percent_basis_points" is null or "sibling_discount_rules"."second_percent_basis_points" between 1 and 10000),
	CONSTRAINT "sibling_discount_rules_later" CHECK ("sibling_discount_rules"."later_percent_basis_points" is null or "sibling_discount_rules"."later_percent_basis_points" between 1 and 10000)
);
--> statement-breakpoint
ALTER TABLE "fee_concessions" ADD COLUMN "source" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "school_preferences" ADD CONSTRAINT "school_preferences_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "school_preferences" ADD CONSTRAINT "school_preferences_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sibling_discount_rules" ADD CONSTRAINT "sibling_discount_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sibling_discount_rules" ADD CONSTRAINT "sibling_discount_rules_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sibling_discount_rules" ADD CONSTRAINT "sibling_discount_rules_item_fk" FOREIGN KEY ("tenant_id","fee_item_id") REFERENCES "public"."fee_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;