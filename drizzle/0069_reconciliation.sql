CREATE TABLE "reconciliation_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"difference" text NOT NULL,
	"detail" text NOT NULL,
	"reviewed_at" timestamp with time zone,
	"reviewed_by_user_id" uuid,
	"review_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reconciliation_items_run_request_unique" UNIQUE("run_id","request_id")
);
--> statement-breakpoint
CREATE TABLE "reconciliation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"run_date" date NOT NULL,
	"checked" integer DEFAULT 0 NOT NULL,
	"matched" integer DEFAULT 0 NOT NULL,
	"differences" integer DEFAULT 0 NOT NULL,
	"errors" integer DEFAULT 0 NOT NULL,
	"finished_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reconciliation_runs_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "reconciliation_runs_day_unique" UNIQUE("tenant_id","provider","run_date")
);
--> statement-breakpoint
ALTER TABLE "guardians" ADD COLUMN "portal_invited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reconciliation_items" ADD CONSTRAINT "reconciliation_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_items" ADD CONSTRAINT "reconciliation_items_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_items" ADD CONSTRAINT "reconciliation_items_run_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."reconciliation_runs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_items" ADD CONSTRAINT "reconciliation_items_request_fk" FOREIGN KEY ("tenant_id","request_id") REFERENCES "public"."mobile_money_requests"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_runs" ADD CONSTRAINT "reconciliation_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reconciliation_items_open_idx" ON "reconciliation_items" USING btree ("tenant_id","reviewed_at");--> statement-breakpoint
-- Reconciliation runs are written by the worker (one per school, provider and day) and never changed.
GRANT SELECT, INSERT ON reconciliation_runs TO edubridge_app;
--> statement-breakpoint
ALTER TABLE reconciliation_runs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE reconciliation_runs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY reconciliation_runs_tenant ON reconciliation_runs
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
CREATE TRIGGER reconciliation_runs_immutable BEFORE UPDATE OR DELETE ON reconciliation_runs
  FOR EACH ROW EXECUTE FUNCTION history_record_immutable();
--> statement-breakpoint
-- Differences: only the review (who, when, what they found) can be added later; never deleted.
GRANT SELECT, INSERT ON reconciliation_items TO edubridge_app;
--> statement-breakpoint
GRANT UPDATE (reviewed_at, reviewed_by_user_id, review_note) ON reconciliation_items TO edubridge_app;
--> statement-breakpoint
ALTER TABLE reconciliation_items ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE reconciliation_items FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY reconciliation_items_tenant ON reconciliation_items
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
CREATE TRIGGER reconciliation_items_no_delete BEFORE DELETE ON reconciliation_items
  FOR EACH ROW EXECUTE FUNCTION history_record_immutable();
