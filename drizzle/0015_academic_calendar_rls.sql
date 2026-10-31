-- No overlapping years or terms within a school; one current term per school.
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
ALTER TABLE academic_years ADD CONSTRAINT academic_years_no_overlap
  EXCLUDE USING gist (tenant_id WITH =, daterange(starts_on, ends_on, '[]') WITH &&);
--> statement-breakpoint
ALTER TABLE terms ADD CONSTRAINT terms_no_overlap
  EXCLUDE USING gist (tenant_id WITH =, daterange(starts_on, ends_on, '[]') WITH &&);
--> statement-breakpoint
CREATE UNIQUE INDEX terms_one_current_per_school ON terms (tenant_id) WHERE is_current;
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON academic_years, terms TO edubridge_app;
--> statement-breakpoint
ALTER TABLE academic_years ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE academic_years FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY academic_years_tenant ON academic_years
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
--> statement-breakpoint
ALTER TABLE terms ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE terms FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY terms_tenant ON terms
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
