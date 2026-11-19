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

/** Minor units as a plain decimal ("1234.50", "-50.00"; "50000" for UGX), for exports and spreadsheets. */
export function pesewasToDecimal(pesewas: number, currency = "GHS"): string {
  assertPesewas(pesewas);
  const abs = Math.abs(pesewas);
  const digits = currency === "GHS" ? 2 : minorDigits(currency);
  const factor = 10 ** digits;
  const fraction = digits ? `.${String(abs % factor).padStart(digits, "0")}` : "";
  return `${pesewas < 0 ? "-" : ""}${Math.trunc(abs / factor)}${fraction}`;
}

/*
 * Other currencies (Africa-wide readiness). Amounts are stored in each currency's minor unit (pesewas for
 * GHS, kobo for NGN, cents for KES; whole francs for XOF, which has none), always as integers. The
 * "pesewas" names above are kept for the Ghana-first code; the functions below take the currency.
 */

/** How each currency is written; unknown currencies fall back to English with the ISO code. */
const MONEY_LOCALES: Record<string, string> = {
  GHS: "en-GH",
  NGN: "en-NG",
  KES: "en-KE",
  UGX: "en-UG",
  TZS: "en-TZ",
  RWF: "en-RW",
  ZMW: "en-ZM",
  ZAR: "en-ZA",
  XOF: "fr-SN",
  XAF: "fr-CM",
  USD: "en-US",
  GBP: "en-GB",
  EUR: "en-IE",
};

const formatters = new Map<string, Intl.NumberFormat>();
function formatterFor(currency: string): Intl.NumberFormat {
  let f = formatters.get(currency);
  if (!f) {
    f = new Intl.NumberFormat(MONEY_LOCALES[currency] ?? "en", { style: "currency", currency });
    formatters.set(currency, f);
  }
  return f;
}

/** Digits after the decimal point in a currency's minor unit (2 for GHS, 0 for UGX and XOF). */
export function minorDigits(currency: string): number {
  return formatterFor(currency).resolvedOptions().maximumFractionDigits ?? 2;
}

/** An amount in minor units, written the way the currency is written: "GH₵1,200.50", "₦1,200.50". */
export function formatMoney(minor: number, currency = "GHS"): string {
  assertPesewas(minor);
  const digits = minorDigits(currency);
  const factor = 10 ** digits;
  const abs = Math.abs(minor);
  const major = Math.trunc(abs / factor);
  const fraction = String(abs % factor).padStart(digits, "0");
  // Exact: Intl formats the whole units only; the minor part is added as digits, never via floats.
  const text = formatterFor(currency)
    .formatToParts(major)
    .map((p) => (p.type === "fraction" ? fraction : p.value))
    .join("");
  return `${minor < 0 ? "-" : ""}${text}`;
}

/** For SMS: the ISO code instead of a symbol outside the GSM alphabet ("GHS 1,120.00", "UGX 50,000"). */
export function formatMoneySms(minor: number, currency = "GHS"): string {
  assertPesewas(minor);
  const digits = minorDigits(currency);
  const factor = 10 ** digits;
  const abs = Math.abs(minor);
  const whole = new Intl.NumberFormat("en", { maximumFractionDigits: 0 }).format(Math.trunc(abs / factor));
  const fraction = digits ? `.${String(abs % factor).padStart(digits, "0")}` : "";
  return `${minor < 0 ? "-" : ""}${currency} ${whole}${fraction}`;
}

/** Largest amount accepted from people, in whole units of any currency (as for GHS). */
const MAX_WHOLE_UNITS = 10_000_000_000;

/**
 * Parses an amount typed by a person in the school's currency: "1200", "1,200.5", "KES 1 200.50", "₦50".
 * Returns minor units, or null when the text is not a valid non-negative amount for the currency (too
 * many decimal places, or any for a currency without a minor unit).
 */
export function parseMoney(input: string, currency = "GHS"): number | null {
  if (currency === "GHS") return parseCedis(input);
  const digits = minorDigits(currency);
  const symbol = formatterFor(currency)
    .formatToParts(1)
    .find((p) => p.type === "currency")?.value;
  // Any kind of space counts as one ordinary space ("F CFA" is written with a narrow no-break space).
  const spaces = (value: string) =>
    value
      .replace(/[\s  ]+/g, " ")
      .trim()
      .toUpperCase();
  const marks = [currency, symbol].filter((m): m is string => Boolean(m)).map(spaces);
  let text = spaces(input);
  for (const mark of marks) if (text.startsWith(mark)) text = text.slice(mark.length);
  for (const mark of marks) if (text.endsWith(mark)) text = text.slice(0, -mark.length);
  text = text.replace(/[\s,\u00a0\u202f]/g, "");
  const match = /^(\d+)(?:\.(\d*))?$/.exec(text);
  if (
    !match ||
    (match[2] !== undefined && match[2].length > digits) ||
    (digits === 0 && match[2] !== undefined)
  )
    return null;
  const whole = match[1]!.replace(/^0+(?=\d)/, "");
  if (Number(whole) > MAX_WHOLE_UNITS) return null;
  const minor = Number(whole) * 10 ** digits + Number((match[2] ?? "").padEnd(digits, "0") || "0");
  return Number.isSafeInteger(minor) ? minor : null;
}

/** A formatter bound to one currency: `const money = moneyFormatter(ctx.tenant.currencyCode)`. */
export function moneyFormatter(currency: string): (minor: number) => string {
  return (minor) => formatMoney(minor, currency);
}

/** Minor units as typed in a form ("1200.5" for GHS, "50000" for UGX). Blank for null. */
export function minorToInput(minor: number | null | undefined, currency = "GHS"): string {
  if (minor === null || minor === undefined) return "";
  assertPesewas(minor);
  const digits = minorDigits(currency);
  const factor = 10 ** digits;
  const abs = Math.abs(minor);
  // As pesewasToInput: whole amounts without decimals, otherwise every decimal digit ("1200.50").
  const rest = abs % factor;
  const fraction = digits && rest ? `.${String(rest).padStart(digits, "0")}` : "";
  return `${minor < 0 ? "-" : ""}${Math.trunc(abs / factor)}${fraction}`;
}

/** The symbol a currency is written with ("GH₵", "₦", "Ksh"), for form labels. */
export function currencySymbol(currency: string): string {
  return (
    formatterFor(currency)
      .formatToParts(0)
      .find((p) => p.type === "currency")?.value ?? currency
  );
}
