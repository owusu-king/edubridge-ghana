-- The platform switch for the assistant moved to ai_feature_flags (task "assistant") in 0120; the founder approved
-- dropping the old column on 2026-11-18.
ALTER TABLE "platform_settings" DROP COLUMN "assistant_enabled";
