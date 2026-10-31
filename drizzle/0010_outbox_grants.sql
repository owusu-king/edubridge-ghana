-- Global tables used by the notification dispatcher and the password reset flow.
GRANT SELECT, INSERT, UPDATE ON notification_outbox TO edubridge_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON password_resets TO edubridge_app;
