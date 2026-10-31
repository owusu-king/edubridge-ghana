GRANT SELECT, INSERT, UPDATE ON phone_verifications TO edubridge_app;
--> statement-breakpoint
-- Phone numbers must be stored in E.164.
ALTER TABLE users ADD CONSTRAINT users_phone_e164 CHECK (phone IS NULL OR phone ~ '^\+[1-9][0-9]{7,14}$');
