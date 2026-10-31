-- Two-step verification tables are global (per user, not per school); access is mediated by the auth service.
GRANT SELECT, INSERT, UPDATE, DELETE ON user_mfa TO edubridge_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON mfa_recovery_codes TO edubridge_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON mfa_challenges TO edubridge_app;
