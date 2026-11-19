ALTER TABLE "notification_outbox" ADD COLUMN "segments" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "sms_usage" ADD COLUMN "segments" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_outbox_idempotency_unique" ON "notification_outbox" USING btree ("channel","recipient","idempotency_key") WHERE "notification_outbox"."idempotency_key" is not null;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_segments" CHECK ("notification_outbox"."segments" between 1 and 20);--> statement-breakpoint
ALTER TABLE "sms_usage" ADD CONSTRAINT "sms_usage_segments" CHECK ("sms_usage"."segments" between 1 and 20);