import { countryProfile } from "./countries";

/**
 * Mobile Money networks across the supported countries (each country's list is in its profile, see
 * src/lib/countries.ts). Shared by server and client. Numbers can be ported between networks, so the
 * prefix only suggests a network; the person sending the prompt confirms it.
 */
export const MOBILE_MONEY_NETWORKS = [
  "mtn",
  "telecel",
  "at",
  "mpesa",
  "airtel",
  "tigo",
  "zamtel",
  "orange",
  "moov",
  "wave",
  "free",
  "opay",
  "palmpay",
] as const;
export type MobileMoneyNetwork = (typeof MOBILE_MONEY_NETWORKS)[number];

export const NETWORK_LABELS: Record<MobileMoneyNetwork, string> = {
  mtn: "MTN MoMo",
  telecel: "Telecel Cash",
  at: "AT Money",
  mpesa: "M-Pesa",
  airtel: "Airtel Money",
  tigo: "Mixx by Yas",
  zamtel: "Zamtel Kwacha",
  orange: "Orange Money",
  moov: "Moov Money",
  wave: "Wave",
  free: "Mixx by Yas",
  opay: "OPay",
  palmpay: "PalmPay",
};

/** The networks payers in a country use, labelled as in that country. */
export function networksFor(country: string): { id: MobileMoneyNetwork; label: string }[] {
  return countryProfile(country).mobileMoney.filter((n): n is { id: MobileMoneyNetwork; label: string } =>
    (MOBILE_MONEY_NETWORKS as readonly string[]).includes(n.id),
  );
}

/** Original allocation of Ghanaian mobile prefixes (after +233 or the leading 0). */
const PREFIXES: Record<string, MobileMoneyNetwork> = {
  "24": "mtn",
  "25": "mtn",
  "53": "mtn",
  "54": "mtn",
  "55": "mtn",
  "59": "mtn",
  "20": "telecel",
  "50": "telecel",
  "26": "at",
  "27": "at",
  "56": "at",
  "57": "at",
};

/** The network a Ghanaian number was first issued on, or null when the prefix is unknown. */
export function suggestNetwork(phone: string): MobileMoneyNetwork | null {
  const compact = phone.replace(/[\s().-]/g, "");
  const match = /^(?:\+?233|0)(\d{2})\d{7}$/.exec(compact);
  return match ? (PREFIXES[match[1]!] ?? null) : null;
}
