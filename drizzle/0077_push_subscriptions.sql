CREATE TABLE "push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parent_session_id" text NOT NULL,
	"phone" text NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_sent_at" timestamp with time zone,
	CONSTRAINT "push_subscriptions_endpoint_unique" UNIQUE("endpoint"),
	CONSTRAINT "push_subscriptions_phone" CHECK ("push_subscriptions"."phone" ~ '^[+][1-9][0-9]{7,14}$'),
	CONSTRAINT "push_subscriptions_endpoint" CHECK ("push_subscriptions"."endpoint" ~ '^https://' and char_length("push_subscriptions"."endpoint") <= 1000),
	CONSTRAINT "push_subscriptions_keys" CHECK (char_length("push_subscriptions"."p256dh") <= 200 and char_length("push_subscriptions"."auth") <= 100)
);
--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_parent_session_id_parent_sessions_id_fk" FOREIGN KEY ("parent_session_id") REFERENCES "public"."parent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "push_subscriptions_phone_idx" ON "push_subscriptions" USING btree ("phone");