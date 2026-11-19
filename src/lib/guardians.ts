/**
 * What a guardian does for a child (SIS-04), in display order. Shared by server and client: kept out of
 * client modules so server components can read it (a client module's constants are not plain values there).
 */
export const GUARDIAN_FLAG_LABELS = [
  ["isFeePayer", "Pays the fees"],
  ["isEmergencyContact", "Emergency contact"],
  ["canPickUp", "May collect the child"],
  ["receivesMessages", "Gets announcements by SMS"],
] as const;

export type GuardianFlag = (typeof GUARDIAN_FLAG_LABELS)[number][0];
