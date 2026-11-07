-- The school assistant becomes a plan module (EduBridge staff add it to a school's plan).
ALTER TABLE "tenant_entitlements" DROP CONSTRAINT "tenant_entitlements_features_valid";
--> statement-breakpoint
ALTER TABLE "tenant_entitlements" ADD CONSTRAINT "tenant_entitlements_features_valid" CHECK ("tenant_entitlements"."features" <@ ARRAY['attendance','assessment','parent_view','fee_reminders','mobile_money','assistant']::text[]);
