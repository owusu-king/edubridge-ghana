CREATE TABLE "demo_visitors" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_enquiries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"school_name" text NOT NULL,
	"town" text NOT NULL,
	"phone" text NOT NULL,
	"email" text,
	"students" text NOT NULL,
	"message" text,
	"ip_address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"handled_at" timestamp with time zone,
	"handled_by_user_id" uuid
);
--> statement-breakpoint
ALTER TABLE "demo_visitors" ADD CONSTRAINT "demo_visitors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_enquiries" ADD CONSTRAINT "sales_enquiries_handled_by_user_id_users_id_fk" FOREIGN KEY ("handled_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sales_enquiries_created_idx" ON "sales_enquiries" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "sales_enquiries_ip_idx" ON "sales_enquiries" USING btree ("ip_address","created_at");