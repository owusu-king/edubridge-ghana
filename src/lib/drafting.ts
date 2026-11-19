/**
 * AI drafting (R5-5): pure helpers, unit-tested. Models are asked for JSON; small models wrap it in prose or code
 * fences, so the first JSON value in the reply is read. Placeholders keep names and figures on our server: the model
 * writes {first name}, {school} or {{billed}}, and our code fills them in.
 */

/** The first JSON array or object in a model's reply, or null. */
export function extractJson(text: string): unknown {
  const start = text.search(/[[{]/);
  if (start < 0) return null;
  const open = text[start]!;
  const close = open === "[" ? "]" : "}";
  for (let end = text.lastIndexOf(close); end > start; end = text.lastIndexOf(close, end - 1)) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      // Try a shorter slice: the reply may continue after the JSON.
    }
  }
  return null;
}

/** Replaces {name} placeholders (single braces) with values; unknown ones are left out. */
export function fillNames(text: string, values: Record<string, string>): string {
  return text
    .replace(/\{\s*([a-z ]+?)\s*\}/gi, (_, key: string) => values[key.toLowerCase()] ?? "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/**
 * Replaces {{figure}} placeholders with the figures our code worked out. Unknown placeholders become "[not
 * available]", so a figure the records do not have is never invented.
 */
export function fillFigures(text: string, figures: Record<string, string>): string {
  return text.replace(
    /\{\{\s*([a-z_]+)\s*\}\}/gi,
    (_, key: string) => figures[key.toLowerCase()] ?? "[not available]",
  );
}

/** Whether a final text is the draft as written (ignoring spacing), or one of several suggestions. */
export function sameText(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  return norm(a) === norm(b);
}
