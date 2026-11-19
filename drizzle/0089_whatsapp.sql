CREATE TABLE "whatsapp_contacts" (
	"phone" text PRIMARY KEY NOT NULL,
	"opted_in_at" timestamp with time zone,
	"opted_out_at" timestamp with time zone,
	"source" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "whatsapp_contacts_phone" CHECK ("whatsapp_contacts"."phone" ~ '^[+][1-9][0-9]{7,14}$')
);
--> statement-breakpoint
ALTER TABLE "tenant_entitlements" DROP CONSTRAINT "tenant_entitlements_features_valid";--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD COLUMN "whatsapp_allowed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD COLUMN "sent_via" text;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD COLUMN "delivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD COLUMN "read_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "whatsapp_price_pesewas" bigint;--> statement-breakpoint
CREATE INDEX "notification_outbox_provider_message_idx" ON "notification_outbox" USING btree ("provider_message_id");--> statement-breakpoint
ALTER TABLE "tenant_entitlements" ADD CONSTRAINT "tenant_entitlements_features_valid" CHECK ("tenant_entitlements"."features" <@ ARRAY['attendance','assessment','parent_view','fee_reminders','mobile_money','assistant','admissions','whatsapp']::text[]);