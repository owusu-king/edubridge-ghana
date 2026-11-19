/** Safeguarding (R4-3): values shared by the server, the pages and the tests. */

export const CONCERN_CATEGORIES = [
  "physical_harm",
  "emotional_harm",
  "sexual_harm",
  "neglect",
  "bullying",
  "self_harm",
  "online_safety",
  "other",
] as const;
export type ConcernCategory = (typeof CONCERN_CATEGORIES)[number];

export const CONCERN_CATEGORY_LABELS: Record<ConcernCategory, string> = {
  physical_harm: "Physical harm",
  emotional_harm: "Emotional harm",
  sexual_harm: "Sexual harm",
  neglect: "Neglect",
  bullying: "Bullying",
  self_harm: "Self-harm",
  online_safety: "Online safety",
  other: "Other",
};

export const CASE_STATUSES = ["open", "monitoring", "closed"] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

export const CASE_STATUS_LABELS: Record<CaseStatus, string> = {
  open: "Open",
  monitoring: "Monitoring",
  closed: "Closed",
};

/** What a lead records on a case. Status changes and assignments are recorded by the system. */
export const ENTRY_KINDS = [
  "note",
  "action",
  "referral",
  "family_contact",
  "meeting",
  "status",
  "assignment",
] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

export const ENTRY_KIND_LABELS: Record<EntryKind, string> = {
  note: "Note",
  action: "Action",
  referral: "Referral",
  family_contact: "Contact with the family",
  meeting: "Meeting",
  status: "Status",
  assignment: "Lead",
};

/** Entry kinds a lead writes by hand. */
export const WRITTEN_ENTRY_KINDS = ["note", "action", "referral", "family_contact", "meeting"] as const;
export type WrittenEntryKind = (typeof WRITTEN_ENTRY_KINDS)[number];

export const formatCaseReference = (n: number) => `SG${String(n).padStart(4, "0")}`;
