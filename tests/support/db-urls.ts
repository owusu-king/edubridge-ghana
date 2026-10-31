/**
 * Integration tests run against a disposable `edubridge_test` database.
 * Defaults match scripts/db-bootstrap-local.sql; CI overrides them with environment variables.
 */
const host = process.env.TEST_DB_HOST ?? "localhost:5432";
const database = process.env.TEST_DB_NAME ?? "edubridge_test";

export const OWNER_URL =
  process.env.TEST_MIGRATION_DATABASE_URL ??
  `postgres://edubridge_owner:edubridge_owner_local@${host}/${database}`;
export const APP_URL =
  process.env.TEST_DATABASE_URL ?? `postgres://edubridge_app:edubridge_app_local@${host}/${database}`;
export const MAINTENANCE_URL = OWNER_URL.replace(/\/[^/]+$/, "/postgres");
export const TEST_DB_NAME = database;
