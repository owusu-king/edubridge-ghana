/**
 * How many SMS a text takes (providers charge per segment). Browser-safe and framework-free.
 *
 * Text written only with the GSM 03.38 alphabet is sent 7-bit: 160 characters in one SMS, or 153 per
 * segment when it is split (each part carries a header). Characters from the extension table (such as
 * € [ ] { } ^ ~ | \) take two places. Any other character (the cedi sign ₵, most accented letters, emoji)
 * sends the whole text as UCS-2: 70 characters, or 67 per segment; characters outside the Basic
 * Multilingual Plane (most emoji) take two.
 */

const GSM_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXTENDED = "\f^{}\\[~]|€";

const basic = new Set(GSM_BASIC);
const extended = new Set(GSM_EXTENDED);

export interface SmsSize {
  encoding: "gsm7" | "ucs2";
  /** Units of the encoding used (septets for GSM 7-bit, 16-bit code units for UCS-2). */
  units: number;
  segments: number;
}

export function smsSize(text: string): SmsSize {
  let septets = 0;
  let gsm = true;
  for (const ch of text) {
    if (basic.has(ch)) septets += 1;
    else if (extended.has(ch)) septets += 2;
    else {
      gsm = false;
      break;
    }
  }
  if (gsm)
    return { encoding: "gsm7", units: septets, segments: septets <= 160 ? 1 : Math.ceil(septets / 153) };
  const units = text.length; // UTF-16 code units: characters beyond the BMP count twice, as on the network.
  return { encoding: "ucs2", units, segments: units <= 70 ? 1 : Math.ceil(units / 67) };
}

/** The number of SMS a text is charged as (at least 1). */
export function smsSegments(text: string): number {
  return Math.max(1, smsSize(text).segments);
}
