-- WhatsApp (R3-7): family choices and how each message went.

-- Global like the outbox (a family number, for every school that messages it through EduBridge). Written
-- only by the parent's own choice in the parent view or by a STOP reply received on the verified webhook.
GRANT SELECT, INSERT, UPDATE ON whatsapp_contacts TO edubridge_app;
--> statement-breakpoint
ALTER TABLE whatsapp_contacts ADD CONSTRAINT whatsapp_contacts_source
  CHECK (source in ('parent_view', 'whatsapp_reply'));
--> statement-breakpoint
ALTER TABLE notification_outbox ADD CONSTRAINT notification_outbox_sent_via
  CHECK (sent_via is null or sent_via in ('sms', 'whatsapp'));
--> statement-breakpoint
-- Only SMS-channel messages can go by WhatsApp instead.
ALTER TABLE notification_outbox ADD CONSTRAINT notification_outbox_whatsapp_sms_only
  CHECK (NOT whatsapp_allowed OR channel = 'sms');
--> statement-breakpoint
GRANT UPDATE (whatsapp_price_pesewas) ON platform_settings TO edubridge_app;
--> statement-breakpoint
ALTER TABLE platform_settings ADD CONSTRAINT platform_settings_whatsapp_price
  CHECK (whatsapp_price_pesewas is null or whatsapp_price_pesewas between 0 and 100000);
