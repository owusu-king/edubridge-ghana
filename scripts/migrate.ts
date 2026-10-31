import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

/** Applies migrations with the owner role. Usage: npm run db:migrate */
export async function runMigrations(connectionString: string): Promise<void> {
  const pool = new Pool({ connectionString, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder: "drizzle" });
  } finally {
    await pool.end();
  }
}

const isEntrypoint = import.meta.url === `file://${process.argv[1]}`;
if (isEntrypoint) {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) {
    console.error("MIGRATION_DATABASE_URL is not set.");
    process.exit(1);
  }
  runMigrations(url)
    .then(() => console.log("Migrations applied."))
    .catch((error: unknown) => {
      console.error(error);
      process.exit(1);
    });
}
