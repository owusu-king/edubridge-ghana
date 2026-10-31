ALTER TABLE "invitations" DROP CONSTRAINT "invitations_roles_valid";--> statement-breakpoint
ALTER TABLE "memberships" DROP CONSTRAINT "memberships_roles_valid";--> statement-breakpoint
ALTER TABLE "tenants" DROP CONSTRAINT "tenants_mfa_required_roles_valid";--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_roles_valid" CHECK ("invitations"."roles" <@ ARRAY['owner','headteacher','admin','bursar','teacher','parent','student']::text[]);--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_roles_valid" CHECK ("memberships"."roles" <@ ARRAY['owner','headteacher','admin','bursar','teacher','parent','student']::text[]);--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_mfa_required_roles_valid" CHECK ("tenants"."mfa_required_roles" <@ ARRAY['owner','headteacher','admin','bursar','teacher','parent','student']::text[]);