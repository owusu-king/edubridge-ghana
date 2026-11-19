import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * A form exposes each of its controls as a property named after the control, and those properties win over
 * the form's own. A control named "firstChild" made form.firstChild return that control, so React, which
 * walks the server's HTML with firstChild and nextSibling while hydrating, lost its place in the Families
 * page and threw a hydration error (2026-11-18). These names are DOM properties React or the browser rely on;
 * no form control may use them.
 */
const RESERVED = new Set([
  "action",
  "appendChild",
  "attributes",
  "childNodes",
  "children",
  "contains",
  "dispatchEvent",
  "elements",
  "firstChild",
  "getAttribute",
  "hasAttribute",
  "innerHTML",
  "insertBefore",
  "isConnected",
  "lastChild",
  "length",
  "localName",
  "namespaceURI",
  "nextSibling",
  "nodeName",
  "nodeType",
  "nodeValue",
  "ownerDocument",
  "parentElement",
  "parentNode",
  "previousSibling",
  "querySelector",
  "removeAttribute",
  "removeChild",
  "replaceChild",
  "requestSubmit",
  "reset",
  "setAttribute",
  "style",
  "submit",
  "tagName",
  "textContent",
]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".tsx"))
    .map((f) => join(dir, f));
}

describe("form control names", () => {
  it("never shadow the DOM properties of the form they are in", () => {
    const clashes: string[] = [];
    for (const file of sourceFiles(join(process.cwd(), "src"))) {
      for (const m of readFileSync(file, "utf8").matchAll(/\bname=\{?"([A-Za-z_$][\w$]*)"/g)) {
        if (RESERVED.has(m[1]!)) clashes.push(`${file.slice(process.cwd().length + 1)}: name="${m[1]}"`);
      }
    }
    expect(clashes).toEqual([]);
  });
});
