/**
 * Country profiles: the platform-level defaults for each country EduBridge supports (Africa-wide
 * readiness). A school takes its country's defaults when it is created and can change its own settings
 * (time zone, holidays, grading, fee and attendance policies) afterwards; nothing in the product should
 * assume one country. Shared by server and client.
 *
 * Holiday lists are suggestions for schools to review, not legal calendars: movable religious holidays
 * (Eid, Diwali...) are announced each year and added by the school. Mobile Money networks are listed for
 * choosing the payer's network; whether payments can be taken depends on a provider supporting the
 * country and currency (see src/server/mobile-money).
 */

export interface MobileMoneyNetworkInfo {
  id: string;
  label: string;
}

export interface CountryProfile {
  code: string;
  name: string;
  /** ISO 4217. */
  currency: string;
  /** International dialling code without "+". */
  dialCode: string;
  /** Digits after the country code for a mobile number. */
  mobile: RegExp;
  /** Digits after the country code for a landline (office numbers), when known. */
  landline?: RegExp;
  /** Numbers may be typed with a leading 0 instead of the country code. */
  trunkZero: boolean;
  timezone: string;
  /** How a national number is grouped for display, e.g. [2, 3, 4] for "24 123 4567". */
  grouping: number[];
  mobileMoney: MobileMoneyNetworkInfo[];
  /** Fixed-date public holidays as MM-DD, name. */
  fixedHolidays: [string, string][];
  /** Christian holidays relative to Easter observed nationally. */
  easter: { goodFriday: boolean; easterMonday: boolean };
}

export const COUNTRY_PROFILES = {
  GH: {
    code: "GH",
    name: "Ghana",
    currency: "GHS",
    dialCode: "233",
    mobile: /^[25]\d{8}$/,
    landline: /^3\d{8}$/,
    trunkZero: true,
    timezone: "Africa/Accra",
    grouping: [2, 3, 4],
    mobileMoney: [
      { id: "mtn", label: "MTN MoMo" },
      { id: "telecel", label: "Telecel Cash" },
      { id: "at", label: "AT Money" },
    ],
    fixedHolidays: [
      ["01-01", "New Year's Day"],
      ["01-07", "Constitution Day"],
      ["03-06", "Independence Day"],
      ["05-01", "May Day"],
      ["07-01", "Republic Day"],
      ["09-21", "Founders' Day"],
      ["12-25", "Christmas Day"],
      ["12-26", "Boxing Day"],
    ],
    easter: { goodFriday: true, easterMonday: true },
  },
  NG: {
    code: "NG",
    name: "Nigeria",
    currency: "NGN",
    dialCode: "234",
    mobile: /^[789][01]\d{8}$/,
    trunkZero: true,
    timezone: "Africa/Lagos",
    grouping: [3, 3, 4],
    mobileMoney: [
      { id: "opay", label: "OPay" },
      { id: "palmpay", label: "PalmPay" },
      { id: "mtn", label: "MTN MoMo PSB" },
    ],
    fixedHolidays: [
      ["01-01", "New Year's Day"],
      ["05-01", "Workers' Day"],
      ["06-12", "Democracy Day"],
      ["10-01", "Independence Day"],
      ["12-25", "Christmas Day"],
      ["12-26", "Boxing Day"],
    ],
    easter: { goodFriday: true, easterMonday: true },
  },
  KE: {
    code: "KE",
    name: "Kenya",
    currency: "KES",
    dialCode: "254",
    mobile: /^[17]\d{8}$/,
    trunkZero: true,
    timezone: "Africa/Nairobi",
    grouping: [3, 3, 3],
    mobileMoney: [
      { id: "mpesa", label: "M-Pesa" },
      { id: "airtel", label: "Airtel Money" },
    ],
    fixedHolidays: [
      ["01-01", "New Year's Day"],
      ["05-01", "Labour Day"],
      ["06-01", "Madaraka Day"],
      ["10-10", "Mazingira Day"],
      ["10-20", "Mashujaa Day"],
      ["12-12", "Jamhuri Day"],
      ["12-25", "Christmas Day"],
      ["12-26", "Boxing Day"],
    ],
    easter: { goodFriday: true, easterMonday: true },
  },
  UG: {
    code: "UG",
    name: "Uganda",
    currency: "UGX",
    dialCode: "256",
    mobile: /^7\d{8}$/,
    trunkZero: true,
    timezone: "Africa/Kampala",
    grouping: [3, 3, 3],
    mobileMoney: [
      { id: "mtn", label: "MTN MoMo" },
      { id: "airtel", label: "Airtel Money" },
    ],
    fixedHolidays: [
      ["01-01", "New Year's Day"],
      ["01-26", "Liberation Day"],
      ["02-16", "Archbishop Janani Luwum Day"],
      ["03-08", "Women's Day"],
      ["05-01", "Labour Day"],
      ["06-03", "Martyrs' Day"],
      ["06-09", "Heroes' Day"],
      ["10-09", "Independence Day"],
      ["12-25", "Christmas Day"],
      ["12-26", "Boxing Day"],
    ],
    easter: { goodFriday: true, easterMonday: true },
  },
  TZ: {
    code: "TZ",
    name: "Tanzania",
    currency: "TZS",
    dialCode: "255",
    mobile: /^[67]\d{8}$/,
    trunkZero: true,
    timezone: "Africa/Dar_es_Salaam",
    grouping: [3, 3, 3],
    mobileMoney: [
      { id: "mpesa", label: "M-Pesa" },
      { id: "tigo", label: "Mixx by Yas" },
      { id: "airtel", label: "Airtel Money" },
    ],
    fixedHolidays: [
      ["01-01", "New Year's Day"],
      ["01-12", "Zanzibar Revolution Day"],
      ["04-07", "Karume Day"],
      ["04-26", "Union Day"],
      ["05-01", "Workers' Day"],
      ["07-07", "Saba Saba"],
      ["08-08", "Nane Nane"],
      ["10-14", "Nyerere Day"],
      ["12-09", "Independence Day"],
      ["12-25", "Christmas Day"],
      ["12-26", "Boxing Day"],
    ],
    easter: { goodFriday: true, easterMonday: true },
  },
  RW: {
    code: "RW",
    name: "Rwanda",
    currency: "RWF",
    dialCode: "250",
    mobile: /^7[2389]\d{7}$/,
    trunkZero: true,
    timezone: "Africa/Kigali",
    grouping: [3, 3, 3],
    mobileMoney: [
      { id: "mtn", label: "MTN MoMo" },
      { id: "airtel", label: "Airtel Money" },
    ],
    fixedHolidays: [
      ["01-01", "New Year's Day"],
      ["02-01", "Heroes' Day"],
      ["04-07", "Genocide against the Tutsi Memorial Day"],
      ["05-01", "Labour Day"],
      ["07-01", "Independence Day"],
      ["07-04", "Liberation Day"],
      ["08-15", "Assumption Day"],
      ["12-25", "Christmas Day"],
      ["12-26", "Boxing Day"],
    ],
    easter: { goodFriday: true, easterMonday: false },
  },
  ZM: {
    code: "ZM",
    name: "Zambia",
    currency: "ZMW",
    dialCode: "260",
    mobile: /^[79]\d{8}$/,
    trunkZero: true,
    timezone: "Africa/Lusaka",
    grouping: [2, 3, 4],
    mobileMoney: [
      { id: "mtn", label: "MTN MoMo" },
      { id: "airtel", label: "Airtel Money" },
      { id: "zamtel", label: "Zamtel Kwacha" },
    ],
    fixedHolidays: [
      ["01-01", "New Year's Day"],
      ["03-08", "Women's Day"],
      ["03-12", "Youth Day"],
      ["05-01", "Labour Day"],
      ["05-25", "Africa Day"],
      ["10-18", "National Prayer Day"],
      ["10-24", "Independence Day"],
      ["12-25", "Christmas Day"],
    ],
    easter: { goodFriday: true, easterMonday: true },
  },
  ZA: {
    code: "ZA",
    name: "South Africa",
    currency: "ZAR",
    dialCode: "27",
    mobile: /^[678]\d{8}$/,
    landline: /^[1-5]\d{8}$/,
    trunkZero: true,
    timezone: "Africa/Johannesburg",
    grouping: [2, 3, 4],
    mobileMoney: [],
    fixedHolidays: [
      ["01-01", "New Year's Day"],
      ["03-21", "Human Rights Day"],
      ["04-27", "Freedom Day"],
      ["05-01", "Workers' Day"],
      ["06-16", "Youth Day"],
      ["08-09", "National Women's Day"],
      ["09-24", "Heritage Day"],
      ["12-16", "Day of Reconciliation"],
      ["12-25", "Christmas Day"],
      ["12-26", "Day of Goodwill"],
    ],
    easter: { goodFriday: true, easterMonday: true },
  },
  CI: {
    code: "CI",
    name: "Côte d'Ivoire",
    currency: "XOF",
    dialCode: "225",
    mobile: /^0[157]\d{8}$/,
    trunkZero: false,
    timezone: "Africa/Abidjan",
    grouping: [2, 2, 2, 2, 2],
    mobileMoney: [
      { id: "orange", label: "Orange Money" },
      { id: "mtn", label: "MTN MoMo" },
      { id: "moov", label: "Moov Money" },
      { id: "wave", label: "Wave" },
    ],
    fixedHolidays: [
      ["01-01", "Jour de l'An"],
      ["05-01", "Fête du Travail"],
      ["08-07", "Fête de l'Indépendance"],
      ["08-15", "Assomption"],
      ["11-01", "Toussaint"],
      ["11-15", "Journée nationale de la Paix"],
      ["12-25", "Noël"],
    ],
    easter: { goodFriday: false, easterMonday: true },
  },
  SN: {
    code: "SN",
    name: "Senegal",
    currency: "XOF",
    dialCode: "221",
    mobile: /^7[05678]\d{7}$/,
    trunkZero: false,
    timezone: "Africa/Dakar",
    grouping: [2, 3, 2, 2],
    mobileMoney: [
      { id: "orange", label: "Orange Money" },
      { id: "wave", label: "Wave" },
      { id: "free", label: "Mixx by Yas" },
    ],
    fixedHolidays: [
      ["01-01", "Jour de l'An"],
      ["04-04", "Fête de l'Indépendance"],
      ["05-01", "Fête du Travail"],
      ["08-15", "Assomption"],
      ["11-01", "Toussaint"],
      ["12-25", "Noël"],
    ],
    easter: { goodFriday: false, easterMonday: true },
  },
  CM: {
    code: "CM",
    name: "Cameroon",
    currency: "XAF",
    dialCode: "237",
    mobile: /^6\d{8}$/,
    trunkZero: false,
    timezone: "Africa/Douala",
    grouping: [1, 2, 2, 2, 2],
    mobileMoney: [
      { id: "mtn", label: "MTN MoMo" },
      { id: "orange", label: "Orange Money" },
    ],
    fixedHolidays: [
      ["01-01", "New Year's Day"],
      ["02-11", "Youth Day"],
      ["05-01", "Labour Day"],
      ["05-20", "National Day"],
      ["08-15", "Assumption Day"],
      ["12-25", "Christmas Day"],
    ],
    easter: { goodFriday: true, easterMonday: false },
  },
} satisfies Record<string, CountryProfile>;

export type CountryCode = keyof typeof COUNTRY_PROFILES;
export const COUNTRY_CODES = Object.keys(COUNTRY_PROFILES) as CountryCode[];

export function isCountryCode(code: string): code is CountryCode {
  return Object.hasOwn(COUNTRY_PROFILES, code);
}

/** A country's profile; Ghana's for an unknown code (the first market), so callers never crash. */
export function countryProfile(code: string | null | undefined): CountryProfile {
  return code && isCountryCode(code) ? COUNTRY_PROFILES[code] : COUNTRY_PROFILES.GH;
}

/** The country a dialling code belongs to (for formatting stored numbers). */
export function countryForNumber(e164: string): CountryProfile | null {
  const digits = e164.replace(/^\+/, "");
  // Longest codes first, so +27 (South Africa) does not catch +270... numbers of another code.
  const profiles = Object.values(COUNTRY_PROFILES).sort((a, b) => b.dialCode.length - a.dialCode.length);
  return profiles.find((p) => digits.startsWith(p.dialCode)) ?? null;
}
