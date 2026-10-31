import type { Route } from "next";

/** Staff experience lives under /s/{school} (docs/02-SOFTWARE-ARCHITECTURE.md §12). */
export function schoolPath(slug: string, segment = ""): Route {
  return (segment ? `/s/${slug}/${segment}` : `/s/${slug}`) as Route;
}
