import { COUNTRY_CODES, countryForNumber, countryProfile } from "./countries";

/**
 * Phone numbers are stored in E.164 (+233241234567). A number may be typed in the national form of the
 * school's country (024 123 4567 in Ghana, 0712 345 678 in Kenya) or in international form with its
 * country code. Numbers of countries EduBridge knows are checked against that country's mobile numbering;
 * other countries' numbers are accepted in international form. Shared by server and client.
 */

const compactOf = (input: string) => input.replace(/[\s().-]/g, "");

function inCountry(compact: string, country: string, pattern: "mobile" | "landline"): string | null {
  const home = countryProfile(country);
  const rule = pattern === "mobile" ? home.mobile : home.landline;
  if (!rule) return null;
  if (home.trunkZero && /^0\d+$/.test(compact) && rule.test(compact.slice(1)))
    return `+${home.dialCode}${compact.slice(1)}`;
  if (!home.trunkZero && /^\d+$/.test(compact) && !compact.startsWith(home.dialCode) && rule.test(compact))
    return `+${home.dialCode}${compact}`;
  return null;
}

function international(compact: string, country: string, pattern: "mobile" | "landline"): string | null {
  const home = countryProfile(country);
  // "+254...", or the home country's code without the plus ("233241234567").
  const digits = compact.startsWith("+")
    ? compact.slice(1)
    : compact.startsWith(home.dialCode)
      ? compact
      : null;
  if (!digits || !/^[1-9]\d+$/.test(digits)) return null;
  const known = countryForNumber(`+${digits}`);
  if (known) {
    const rule = pattern === "mobile" ? known.mobile : known.landline;
    return rule?.test(digits.slice(known.dialCode.length)) ? `+${digits}` : null;
  }
  return compact.startsWith("+") && /^[1-9]\d{7,14}$/.test(digits) ? `+${digits}` : null;
}

/** A mobile number in E.164, or null. `country` is the school's country, for numbers typed without a code. */
export function normalizePhone(input: string, country: string = "GH"): string | null {
  const compact = compactOf(input);
  if (!/^\+?\d+$/.test(compact)) return null;
  return inCountry(compact, country, "mobile") ?? international(compact, country, "mobile");
}

/**
 * A number families can call, such as the school office: a mobile number as above, or a landline where
 * the country's landline numbering is known (030 123 4567 in Accra). Not for SMS, which need a mobile.
 */
export function normalizeCallablePhone(input: string, country: string = "GH"): string | null {
  const mobile = normalizePhone(input, country);
  if (mobile) return mobile;
  const compact = compactOf(input);
  if (!/^\+?\d+$/.test(compact)) return null;
  return inCountry(compact, country, "landline") ?? international(compact, country, "landline");
}

/**
 * For forms with no school behind them (the parent sign-in): a Ghanaian number as before, an
 * international number, or a national number that belongs to exactly one supported country. A national
 * number two countries could own (0712 345 678: Kenya or Uganda) is refused, so the person adds the code.
 */
export function normalizePhoneAnywhere(input: string): string | null {
  const ghana = normalizePhone(input, "GH");
  if (ghana) return ghana;
  const compact = compactOf(input);
  if (compact.startsWith("+")) return null;
  const found = new Set(
    COUNTRY_CODES.filter((c) => c !== "GH")
      .map((c) => inCountry(compact, c, "mobile"))
      .filter((n): n is string => n !== null),
  );
  return found.size === 1 ? [...found][0]! : null;
}

/**
 * Before validating a form, puts a phone typed in the school's national form into E.164, so schemas that
 * know no country accept it. Anything else is left as typed for the schema to judge.
 */
export function localizePhoneField<T>(input: T, country: string, field = "phone"): T {
  if (!input || typeof input !== "object") return input;
  const value = (input as Record<string, unknown>)[field];
  if (typeof value !== "string" || !value.trim()) return input;
  const e164 = normalizePhone(value, country);
  return e164 ? { ...input, [field]: e164 } : input;
}

/** "+233 24 123 4567": grouped the way the number's country writes it; unknown countries as stored. */
export function formatPhone(e164: string): string {
  const country = countryForNumber(e164);
  if (!country) return e164;
  const national = e164.slice(country.dialCode.length + 1);
  const total = country.grouping.reduce((a, b) => a + b, 0);
  if (national.length !== total || !/^\d+$/.test(national)) return e164;
  const groups: string[] = [];
  let at = 0;
  for (const size of country.grouping) {
    groups.push(national.slice(at, at + size));
    at += size;
  }
  return `+${country.dialCode} ${groups.join(" ")}`;
}

/** Shows only the last digits, e.g. in messages about where a code was sent. */
export function maskPhone(e164: string): string {
  return `${e164.slice(0, 4)}${"•".repeat(Math.max(0, e164.length - 7))}${e164.slice(-3)}`;
}
