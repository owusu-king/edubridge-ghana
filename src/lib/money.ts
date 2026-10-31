/**
 * Money is held as integer pesewas (1 GHS = 100 pesewas) everywhere: in the database (bigint), in
 * services and in tests. Floating-point amounts never enter calculations; decimal strings are parsed
 * digit by digit. Amounts stay well inside Number.MAX_SAFE_INTEGER.
 */

/** Largest single amount accepted from people: GH₵ 10,000,000.00. */
export const MAX_AMOUNT_PESEWAS = 1_000_000_000;

const CURRENCY_FORMAT = new Intl.NumberFormat("en-GH", { style: "currency", currency: "GHS" });

/** "GH₵1,200.50". Negative amounts (credits) are shown with a leading minus sign. */
export function formatCedis(pesewas: number): string {
  assertPesewas(pesewas);
  // Exact: integer division keeps the cedi part, the remainder is always two digits.
  const sign = pesewas < 0 ? "-" : "";
  const abs = Math.abs(pesewas);
  const cedis = Math.trunc(abs / 100);
  const rest = abs % 100;
  const whole = CURRENCY_FORMAT.format(cedis).replace(/\.00$/, "");
  return `${sign}${whole}.${String(rest).padStart(2, "0")}`;
}

/** "1200.50", for form inputs. Blank for null. */
export function pesewasToInput(pesewas: number | null | undefined): string {
  if (pesewas === null || pesewas === undefined) return "";
  assertPesewas(pesewas);
  const abs = Math.abs(pesewas);
  const text = `${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
  return `${pesewas < 0 ? "-" : ""}${text.replace(/\.00$/, "")}`;
}

/**
 * Parses an amount typed by a person: "1200", "1,200.5", "GH₵ 1 200.50", "GHS 50". Returns pesewas, or
 * null when the text is not a valid non-negative amount with at most two decimal places.
 */
export function parseCedis(input: string): number | null {
  const text = input
    .trim()
    .replace(/^(GH₵|GHS|GH¢|₵|¢)\s*/i, "")
    .replace(/[\s,]/g, "");
  const match = /^(\d+)(?:\.(\d{0,2}))?$/.exec(text);
  if (!match) return null;
  const cedis = match[1]!.replace(/^0+(?=\d)/, "");
  if (cedis.length > 8) return null;
  const pesewas = Number(cedis) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return pesewas <= MAX_AMOUNT_PESEWAS ? pesewas : null;
}

export function assertPesewas(value: number): void {
  if (!Number.isSafeInteger(value)) throw new RangeError(`Not a whole number of pesewas: ${value}`);
}

/** Sum of pesewa amounts, guarding against unsafe totals. */
export function sumPesewas(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    assertPesewas(value);
    total += value;
  }
  assertPesewas(total);
  return total;
}
