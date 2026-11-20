/** The choices on the landing page's "Book a visit" form, shared by the form, the server and Admin (2026-11-19). */

export const ENQUIRY_ROLES = [
  ["proprietor", "Proprietor or director"],
  ["head", "Head teacher"],
  ["bursar", "Bursar or accountant"],
  ["administrator", "Administrator"],
  ["other", "Something else"],
] as const;

export const ENQUIRY_SIZES = [
  ["under_150", "Fewer than 150"],
  ["150_400", "150 to 400"],
  ["400_800", "400 to 800"],
  ["over_800", "More than 800"],
] as const;

export const enquiryRoleLabel = (v: string) => ENQUIRY_ROLES.find(([k]) => k === v)?.[1] ?? v;
export const enquirySizeLabel = (v: string) => ENQUIRY_SIZES.find(([k]) => k === v)?.[1] ?? v;
