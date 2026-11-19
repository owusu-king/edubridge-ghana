/**
 * Checked answers (R5-4, AST-01a): every figure in an assistant's answer must appear in what that question's tools
 * returned, or it is flagged. Pure, so the rule is unit-tested. A figure "appears" when a number in the results
 * equals it, allowing for the answer rounding it (93% for 92.7), and counts of the lists the tools returned are
 * figures too. Dates, times and the like are not figures.
 */

const MONTHS = "Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec";
const NOT_FIGURES = [
  // 18 Nov 2026, 8 September, Nov 18
  new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTHS})[a-z]*\\.?(?:,?\\s+\\d{4})?`, "gi"),
  new RegExp(`\\b(?:${MONTHS})[a-z]*\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?`, "gi"),
  // 2026-11-18, 18/11/2026, 10:30
  /\b\d{4}-\d{2}-\d{2}\b/g,
  /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g,
  /\b\d{1,2}:\d{2}\b/g,
  // References that stand for people ([P1]).
  /\[P\d+\]/g,
];

/** Numbers written in a text: 1,250.50 and 92.7 and 85 (signs and currency symbols dropped). */
const NUMBER = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;

export interface Figure {
  /** As written in the answer, e.g. "1,250.50". */
  text: string;
  value: number;
  /** Decimal places written (for rounding). */
  places: number;
}

function figuresIn(text: string): Figure[] {
  return [...text.matchAll(NUMBER)].map((m) => {
    const raw = m[0];
    const plain = raw.replace(/,/g, "");
    return { text: raw, value: Number(plain), places: plain.includes(".") ? plain.split(".")[1]!.length : 0 };
  });
}

/** The figures an answer states (dates, times and people's references left out). */
export function answerFigures(answer: string): Figure[] {
  let text = answer;
  for (const pattern of NOT_FIGURES) text = text.replace(pattern, " ");
  return figuresIn(text);
}

/** Every number the tools returned: numbers, numbers written in strings, and the length of every list. */
export function resultFigures(results: readonly unknown[]): number[] {
  const out: number[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "number" && Number.isFinite(v)) out.push(v);
    else if (typeof v === "string") for (const f of figuresIn(v)) out.push(f.value);
    else if (Array.isArray(v)) {
      out.push(v.length);
      v.forEach(walk);
    } else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  results.forEach(walk);
  return out;
}

const roundTo = (v: number, places: number) => {
  const f = 10 ** places;
  return Math.round(v * f) / f;
};

/** Figures in the answer that do not appear in the results (deduplicated, in order). */
export function uncheckedFigures(answer: string, results: readonly unknown[]): string[] {
  const known = resultFigures(results);
  const unchecked: string[] = [];
  for (const f of answerFigures(answer)) {
    const found = known.some((k) => k === f.value || roundTo(k, f.places) === f.value);
    if (!found && !unchecked.includes(f.text)) unchecked.push(f.text);
  }
  return unchecked;
}

/** Whether every expected figure (as our code formats it) is in the answer, for the evaluation set. */
export function containsFigure(answer: string, expected: string): boolean {
  const want = figuresIn(expected);
  if (!want.length) return answer.toLowerCase().includes(expected.toLowerCase());
  const have = answerFigures(answer);
  return want.every((w) => have.some((h) => h.value === w.value || roundTo(w.value, h.places) === h.value));
}
