import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { gzipSync } from "node:zlib";
import { runInNewContext } from "node:vm";

/**
 * Parent-view JavaScript budget (`01` §8, PSH-04): the JavaScript a phone downloads for each parent page,
 * gzip-compressed, must stay under 170 KB. Reads a production build (`npm run build` first): the shared
 * framework files every page loads, plus each parent route's own files from the build's client manifests.
 * Usage: npm run check:parent-bundle
 */

const BUDGET_KB = 170;
const NEXT = ".next";
const ROOT = join(NEXT, "server", "app", "p");

function manifests(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...manifests(path));
    else if (name === "page_client-reference-manifest.js") found.push(path);
  }
  return found;
}

const gzipped = new Map<string, number>();
function size(file: string): number {
  let n = gzipped.get(file);
  if (n === undefined) {
    n = gzipSync(readFileSync(join(NEXT, file))).length;
    gzipped.set(file, n);
  }
  return n;
}

function main(): number {
  let build: { rootMainFiles?: string[] };
  try {
    build = JSON.parse(readFileSync(join(NEXT, "build-manifest.json"), "utf8")) as typeof build;
  } catch {
    console.error("No production build found. Run `npm run build` first.");
    return 1;
  }
  const shared = build.rootMainFiles ?? [];
  const routes = manifests(ROOT);
  if (routes.length === 0) {
    console.error("No parent routes found in the build.");
    return 1;
  }
  let over = 0;
  const rows: [string, number][] = [];
  for (const path of routes) {
    const sandbox: { globalThis: Record<string, unknown> } = { globalThis: {} };
    sandbox.globalThis = sandbox as unknown as Record<string, unknown>;
    runInNewContext(readFileSync(path, "utf8"), sandbox);
    const all = (
      sandbox as unknown as { __RSC_MANIFEST: Record<string, { entryJSFiles?: Record<string, string[]> }> }
    ).__RSC_MANIFEST;
    for (const [route, manifest] of Object.entries(all)) {
      const files = new Set([...shared, ...Object.values(manifest.entryJSFiles ?? {}).flat()]);
      const kb = [...files].reduce((sum, f) => sum + size(f), 0) / 1024;
      rows.push([route.replace(/\/page$/, "") || relative(ROOT, path), kb]);
      if (kb > BUDGET_KB) over++;
    }
  }
  rows.sort((a, b) => b[1] - a[1]);
  for (const [route, kb] of rows)
    console.log(`${kb > BUDGET_KB ? "OVER" : "ok  "}  ${kb.toFixed(1).padStart(6)} KB  ${route}`);
  if (over) {
    console.error(`${over} parent ${over === 1 ? "page is" : "pages are"} over the ${BUDGET_KB} KB budget.`);
    return 1;
  }
  console.log(`Every parent page is within ${BUDGET_KB} KB of compressed JavaScript.`);
  return 0;
}

process.exit(main());
