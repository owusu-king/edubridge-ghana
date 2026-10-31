import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * Loads `.env.local` for command-line scripts, on Windows, macOS and Linux alike (Next.js loads it
 * for the web app itself). Variables already set in the environment win, so CI and shells can override.
 */
export function loadLocalEnv(): void {
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
}

/** True when the module at `url` is the script being run (works with Windows paths too). */
export function isEntrypoint(url: string): boolean {
  return Boolean(process.argv[1]) && url === pathToFileURL(process.argv[1]!).href;
}
