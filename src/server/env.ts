import "server-only";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /** Runtime connection. Must use the restricted `edubridge_app` role so row-level security applies. */
  DATABASE_URL: z.string().url(),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

/** Parsed lazily so `next build` does not require runtime secrets. */
export function env(): Env {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      const fields = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
      throw new Error(`Invalid environment configuration: ${fields}`);
    }
    cached = parsed.data;
  }
  return cached;
}
