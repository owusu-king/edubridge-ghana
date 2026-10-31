import { Client } from "pg";
import { runMigrations } from "../../scripts/migrate";
import { MAINTENANCE_URL, OWNER_URL, TEST_DB_NAME } from "./db-urls";

/** Recreates the test database and applies all migrations once per test run. */
export default async function setup(): Promise<void> {
  if (!/^[a-z_]+_test$/.test(TEST_DB_NAME))
    throw new Error(`Refusing to reset non-test database "${TEST_DB_NAME}".`);
  const admin = new Client({ connectionString: MAINTENANCE_URL });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB_NAME} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEST_DB_NAME}`);
  } finally {
    await admin.end();
  }
  await runMigrations(OWNER_URL);
}
