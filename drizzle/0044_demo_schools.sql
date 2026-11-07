ALTER TABLE "tenants" ADD COLUMN "is_demo" boolean DEFAULT false NOT NULL;-- Demo schools are marked only by the demo script (owner role): the app role's UPDATE grant on tenants
-- (0001, 0008) does not include is_demo.
