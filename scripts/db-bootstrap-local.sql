-- Local development only. Creates the two database roles and the dev/test databases.
-- Run once:  sudo -u postgres psql -f scripts/db-bootstrap-local.sql
-- Never use these passwords outside a local machine.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edubridge_owner') THEN
    CREATE ROLE edubridge_owner LOGIN PASSWORD 'edubridge_owner_local' CREATEDB;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edubridge_app') THEN
    CREATE ROLE edubridge_app LOGIN PASSWORD 'edubridge_app_local';
  END IF;
END
$$;
SELECT 'CREATE DATABASE edubridge_dev OWNER edubridge_owner'
  WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'edubridge_dev') \gexec
