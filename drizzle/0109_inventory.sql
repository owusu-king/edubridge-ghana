CREATE TABLE "asset_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"detail" text NOT NULL,
	"note" text,
	"by_user_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_events_detail" CHECK (char_length("asset_events"."detail") between 1 and 300),
	CONSTRAINT "asset_events_note" CHECK (coalesce(char_length("asset_events"."note"), 0) <= 300)
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"tag" text NOT NULL,
	"name" text NOT NULL,
	"category" text,
	"serial_number" text,
	"location" text,
	"custodian_membership_id" uuid,
	"custodian_name" text,
	"condition" text NOT NULL,
	"acquired_on" date,
	"cost_minor" bigint,
	"supplier_id" uuid,
	"note" text,
	"status" text DEFAULT 'active' NOT NULL,
	"disposed_at" timestamp with time zone,
	"disposal_reason" text,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assets_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "assets_tenant_tag_unique" UNIQUE("tenant_id","tag"),
	CONSTRAINT "assets_name" CHECK (char_length("assets"."name") between 1 and 120),
	CONSTRAINT "assets_cost" CHECK ("assets"."cost_minor" is null or "assets"."cost_minor" between 0 and 100000000000),
	CONSTRAINT "assets_text_lengths" CHECK (coalesce(char_length("assets"."category"), 0) <= 60 and coalesce(char_length("assets"."serial_number"), 0) <= 80 and coalesce(char_length("assets"."location"), 0) <= 120 and coalesce(char_length("assets"."custodian_name"), 0) <= 120 and coalesce(char_length("assets"."note"), 0) <= 300 and coalesce(char_length("assets"."disposal_reason"), 0) <= 300),
	CONSTRAINT "assets_disposed" CHECK (("assets"."status" = 'disposed') = ("assets"."disposed_at" is not null) and ("assets"."disposed_at" is null) = ("assets"."disposal_reason" is null))
);
--> statement-breakpoint
CREATE TABLE "inventory_suppliers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" "citext" NOT NULL,
	"contact_name" text,
	"phone" text,
	"email" text,
	"note" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_suppliers_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "inventory_suppliers_tenant_name_unique" UNIQUE("tenant_id","name"),
	CONSTRAINT "inventory_suppliers_name" CHECK (char_length("inventory_suppliers"."name") between 1 and 120),
	CONSTRAINT "inventory_suppliers_phone" CHECK ("inventory_suppliers"."phone" is null or "inventory_suppliers"."phone" ~ '^\+[1-9][0-9]{7,14}$'),
	CONSTRAINT "inventory_suppliers_text_lengths" CHECK (coalesce(char_length("inventory_suppliers"."contact_name"), 0) <= 120 and coalesce(char_length("inventory_suppliers"."email"), 0) <= 254 and coalesce(char_length("inventory_suppliers"."note"), 0) <= 300)
);
--> statement-breakpoint
CREATE TABLE "maintenance_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"location" text,
	"asset_id" uuid,
	"priority" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"assigned_to" text,
	"reported_by_user_id" uuid NOT NULL,
	"reported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "maintenance_requests_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "maintenance_requests_tenant_reference_unique" UNIQUE("tenant_id","reference"),
	CONSTRAINT "maintenance_requests_title" CHECK (char_length("maintenance_requests"."title") between 3 and 120),
	CONSTRAINT "maintenance_requests_text_lengths" CHECK (coalesce(char_length("maintenance_requests"."description"), 0) <= 2000 and coalesce(char_length("maintenance_requests"."location"), 0) <= 120 and coalesce(char_length("maintenance_requests"."assigned_to"), 0) <= 120)
);
--> statement-breakpoint
CREATE TABLE "maintenance_updates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"status" text,
	"assigned_to" text,
	"note" text,
	"by_user_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "maintenance_updates_text_lengths" CHECK (coalesce(char_length("maintenance_updates"."note"), 0) <= 1000 and coalesce(char_length("maintenance_updates"."assigned_to"), 0) <= 120)
);
--> statement-breakpoint
CREATE TABLE "purchase_request_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"description" text NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price_minor" bigint,
	"stock_item_id" uuid,
	"received_quantity" integer,
	CONSTRAINT "purchase_request_lines_description" CHECK (char_length("purchase_request_lines"."description") between 1 and 200),
	CONSTRAINT "purchase_request_lines_quantity" CHECK ("purchase_request_lines"."quantity" between 1 and 1000000),
	CONSTRAINT "purchase_request_lines_price" CHECK ("purchase_request_lines"."unit_price_minor" is null or "purchase_request_lines"."unit_price_minor" between 0 and 100000000000),
	CONSTRAINT "purchase_request_lines_received" CHECK ("purchase_request_lines"."received_quantity" is null or "purchase_request_lines"."received_quantity" between 0 and 1000000)
);
--> statement-breakpoint
CREATE TABLE "purchase_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"title" text NOT NULL,
	"reason" text,
	"supplier_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"closed_by_user_id" uuid,
	"closed_at" timestamp with time zone,
	"closing_note" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_requests_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "purchase_requests_tenant_reference_unique" UNIQUE("tenant_id","reference"),
	CONSTRAINT "purchase_requests_title" CHECK (char_length("purchase_requests"."title") between 3 and 120),
	CONSTRAINT "purchase_requests_text_lengths" CHECK (coalesce(char_length("purchase_requests"."reason"), 0) <= 1000 and coalesce(char_length("purchase_requests"."decision_note"), 0) <= 500 and coalesce(char_length("purchase_requests"."closing_note"), 0) <= 500),
	CONSTRAINT "purchase_requests_not_own" CHECK ("purchase_requests"."decided_by_user_id" is null or "purchase_requests"."decided_by_user_id" <> "purchase_requests"."requested_by_user_id"),
	CONSTRAINT "purchase_requests_decided" CHECK (("purchase_requests"."decided_at" is null) = ("purchase_requests"."decided_by_user_id" is null)),
	CONSTRAINT "purchase_requests_closed" CHECK (("purchase_requests"."closed_at" is null) = ("purchase_requests"."closed_by_user_id" is null))
);
--> statement-breakpoint
CREATE TABLE "stock_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" "citext" NOT NULL,
	"category" text,
	"unit" text NOT NULL,
	"reorder_level" integer,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_items_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "stock_items_tenant_name_unique" UNIQUE("tenant_id","name"),
	CONSTRAINT "stock_items_name" CHECK (char_length("stock_items"."name") between 1 and 80),
	CONSTRAINT "stock_items_unit" CHECK (char_length("stock_items"."unit") between 1 and 30),
	CONSTRAINT "stock_items_category" CHECK (coalesce(char_length("stock_items"."category"), 0) <= 60),
	CONSTRAINT "stock_items_reorder" CHECK ("stock_items"."reorder_level" is null or "stock_items"."reorder_level" between 0 and 1000000)
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"quantity" integer NOT NULL,
	"unit_cost_minor" bigint,
	"supplier_id" uuid,
	"purchase_request_id" uuid,
	"issued_to" text,
	"reason" text,
	"recorded_by_user_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_movements_kind" CHECK (("stock_movements"."kind" = 'received' and "stock_movements"."quantity" > 0) or ("stock_movements"."kind" = 'issued' and "stock_movements"."quantity" < 0 and "stock_movements"."issued_to" is not null) or ("stock_movements"."kind" = 'counted' and "stock_movements"."quantity" <> 0 and "stock_movements"."reason" is not null)),
	CONSTRAINT "stock_movements_quantity" CHECK ("stock_movements"."quantity" between -1000000 and 1000000),
	CONSTRAINT "stock_movements_cost" CHECK ("stock_movements"."unit_cost_minor" is null or ("stock_movements"."kind" = 'received' and "stock_movements"."unit_cost_minor" between 0 and 100000000000)),
	CONSTRAINT "stock_movements_text_lengths" CHECK (coalesce(char_length("stock_movements"."issued_to"), 0) <= 120 and coalesce(char_length("stock_movements"."reason"), 0) <= 300)
);
--> statement-breakpoint
ALTER TABLE "asset_events" ADD CONSTRAINT "asset_events_by_user_id_users_id_fk" FOREIGN KEY ("by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_events" ADD CONSTRAINT "asset_events_tenant_id_asset_id_assets_tenant_id_id_fk" FOREIGN KEY ("tenant_id","asset_id") REFERENCES "public"."assets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_tenant_id_custodian_membership_id_memberships_tenant_id_id_fk" FOREIGN KEY ("tenant_id","custodian_membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_tenant_id_supplier_id_inventory_suppliers_tenant_id_id_fk" FOREIGN KEY ("tenant_id","supplier_id") REFERENCES "public"."inventory_suppliers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_suppliers" ADD CONSTRAINT "inventory_suppliers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_requests" ADD CONSTRAINT "maintenance_requests_reported_by_user_id_users_id_fk" FOREIGN KEY ("reported_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_requests" ADD CONSTRAINT "maintenance_requests_tenant_id_asset_id_assets_tenant_id_id_fk" FOREIGN KEY ("tenant_id","asset_id") REFERENCES "public"."assets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_updates" ADD CONSTRAINT "maintenance_updates_by_user_id_users_id_fk" FOREIGN KEY ("by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_updates" ADD CONSTRAINT "maintenance_updates_tenant_id_request_id_maintenance_requests_tenant_id_id_fk" FOREIGN KEY ("tenant_id","request_id") REFERENCES "public"."maintenance_requests"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_request_lines" ADD CONSTRAINT "purchase_request_lines_tenant_id_request_id_purchase_requests_tenant_id_id_fk" FOREIGN KEY ("tenant_id","request_id") REFERENCES "public"."purchase_requests"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_request_lines" ADD CONSTRAINT "purchase_request_lines_tenant_id_stock_item_id_stock_items_tenant_id_id_fk" FOREIGN KEY ("tenant_id","stock_item_id") REFERENCES "public"."stock_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_requests" ADD CONSTRAINT "purchase_requests_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_requests" ADD CONSTRAINT "purchase_requests_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_requests" ADD CONSTRAINT "purchase_requests_closed_by_user_id_users_id_fk" FOREIGN KEY ("closed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_requests" ADD CONSTRAINT "purchase_requests_tenant_id_supplier_id_inventory_suppliers_tenant_id_id_fk" FOREIGN KEY ("tenant_id","supplier_id") REFERENCES "public"."inventory_suppliers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_tenant_id_item_id_stock_items_tenant_id_id_fk" FOREIGN KEY ("tenant_id","item_id") REFERENCES "public"."stock_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_tenant_id_supplier_id_inventory_suppliers_tenant_id_id_fk" FOREIGN KEY ("tenant_id","supplier_id") REFERENCES "public"."inventory_suppliers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "asset_events_asset_idx" ON "asset_events" USING btree ("tenant_id","asset_id","at");--> statement-breakpoint
CREATE INDEX "maintenance_requests_status_idx" ON "maintenance_requests" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "maintenance_updates_request_idx" ON "maintenance_updates" USING btree ("tenant_id","request_id","at");--> statement-breakpoint
CREATE INDEX "purchase_request_lines_request_idx" ON "purchase_request_lines" USING btree ("tenant_id","request_id","position");--> statement-breakpoint
CREATE INDEX "purchase_requests_status_idx" ON "purchase_requests" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "stock_movements_item_idx" ON "stock_movements" USING btree ("tenant_id","item_id","recorded_at");