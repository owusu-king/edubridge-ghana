ALTER TABLE "push_subscriptions" DROP CONSTRAINT "push_subscriptions_phone";--> statement-breakpoint
ALTER TABLE "push_subscriptions" ALTER COLUMN "parent_session_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ALTER COLUMN "phone" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD COLUMN "staff_session_id" text;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_staff_session_id_sessions_id_fk" FOREIGN KEY ("staff_session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "push_subscriptions_user_idx" ON "push_subscriptions" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_owner" CHECK (("push_subscriptions"."parent_session_id" is not null and "push_subscriptions"."phone" is not null and "push_subscriptions"."staff_session_id" is null and "push_subscriptions"."user_id" is null) or ("push_subscriptions"."parent_session_id" is null and "push_subscriptions"."phone" is null and "push_subscriptions"."staff_session_id" is not null and "push_subscriptions"."user_id" is not null));--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_phone" CHECK ("push_subscriptions"."phone" is null or "push_subscriptions"."phone" ~ '^[+][1-9][0-9]{7,14}$');