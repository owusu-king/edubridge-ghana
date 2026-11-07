CREATE TABLE "assistant_queries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"question" text NOT NULL,
	"answer" text,
	"status" text NOT NULL,
	"tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"support_grant_id" uuid DEFAULT nullif(current_setting('app.support_grant_id', true), '')::uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assistant_queries_question_length" CHECK (char_length("assistant_queries"."question") between 1 and 500)
);
--> statement-breakpoint
ALTER TABLE "assistant_queries" ADD CONSTRAINT "assistant_queries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "assistant_queries" ADD CONSTRAINT "assistant_queries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "assistant_queries_tenant_time_idx" ON "assistant_queries" USING btree ("tenant_id","created_at");
--> statement-breakpoint
-- Questions to the school assistant: kept as asked and answered, never changed.
GRANT SELECT, INSERT ON assistant_queries TO edubridge_app;
--> statement-breakpoint
ALTER TABLE assistant_queries ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE assistant_queries FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY assistant_queries_tenant ON assistant_queries
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
CREATE TRIGGER assistant_queries_no_update_delete BEFORE UPDATE OR DELETE ON assistant_queries
  FOR EACH ROW EXECUTE FUNCTION history_record_immutable();
--> statement-breakpoint
CREATE TRIGGER assistant_queries_no_truncate BEFORE TRUNCATE ON assistant_queries
  FOR EACH STATEMENT EXECUTE FUNCTION history_record_immutable();
