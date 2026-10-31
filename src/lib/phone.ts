/**
 * Phone numbers are stored in E.164 (+233241234567). Ghanaian numbers may be entered in local form
 * (024 123 4567); other countries must include their country code. Shared by server and client.
 */
const GH_MOBILE = /^[25]\d{8}$/;

export function normalizePhone(input: string, defaultCountry: "GH" = "GH"): string | null {
  const compact = input.replace(/[\s().-]/g, "");
  if (!/^\+?\d+$/.test(compact)) return null;
  if (defaultCountry === "GH") {
    if (/^0\d{9}$/.test(compact) && GH_MOBILE.test(compact.slice(1))) return `+233${compact.slice(1)}`;
    const national = compact.replace(/^\+?233/, "");
    if (/^\+?233/.test(compact) && GH_MOBILE.test(national)) return `+233${national}`;
  }
  // Other countries: international format with a country code (not Ghana, which is validated above).
  if (/^\+[1-9]\d{7,14}$/.test(compact) && !compact.startsWith("+233")) return compact;
  return null;
}

/** "+233 24 123 4567" for Ghanaian numbers; other numbers are shown as stored. */
export function formatPhone(e164: string): string {
  const m = e164.match(/^\+233(\d{2})(\d{3})(\d{4})$/);
  return m ? `+233 ${m[1]} ${m[2]} ${m[3]}` : e164;
}

/** Shows only the last digits, e.g. in messages about where a code was sent. */
export function maskPhone(e164: string): string {
  return `${e164.slice(0, 4)}${"•".repeat(Math.max(0, e164.length - 7))}${e164.slice(-3)}`;
}
