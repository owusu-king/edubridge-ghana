/**
 * Ghana's Mobile Money networks, shared by server and client. Numbers can be ported between networks,
 * so the prefix only suggests a network; the person sending the prompt confirms it.
 */
export const MOBILE_MONEY_NETWORKS = ["mtn", "telecel", "at"] as const;
export type MobileMoneyNetwork = (typeof MOBILE_MONEY_NETWORKS)[number];

export const NETWORK_LABELS: Record<MobileMoneyNetwork, string> = {
  mtn: "MTN MoMo",
  telecel: "Telecel Cash",
  at: "AT Money",
};

/** Original allocation of mobile prefixes (after +233 or the leading 0). */
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
