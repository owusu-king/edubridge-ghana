-- Web push (R3-2): a parent's phone opts in during a parent sign-in; the dispatcher reads subscriptions to
-- send, records when it last sent, and removes those the push service reports gone.
GRANT SELECT, INSERT, DELETE ON push_subscriptions TO edubridge_app;
--> statement-breakpoint
GRANT UPDATE (last_sent_at) ON push_subscriptions TO edubridge_app;
--> statement-breakpoint
-- The outbox now also carries push messages (recipient: a push subscription id).
ALTER TABLE notification_outbox ADD CONSTRAINT notification_outbox_channel
  CHECK (channel in ('email', 'sms', 'push'));
