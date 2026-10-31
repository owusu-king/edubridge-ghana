/** Human-readable descriptions of audit actions. Unknown actions fall back to the raw key. */
const LABELS: Record<string, string> = {
  "school.created": "School created",
  "school.profile.updated": "School profile updated",
  "school.mfa_policy.updated": "Two-step verification policy changed",
  "school.suspended": "School suspended",
  "school.reactivated": "School reactivated",
  "entitlements.updated": "Plan changed",
  "academic_year.created": "Academic year added",
  "term.updated": "Term changed",
  "term.made_current": "Current term changed",
  "levels.set_up": "Levels set up",
  "level.created": "Level added",
  "level.renamed": "Level renamed",
  "class.created": "Class added",
  "class.updated": "Class changed",
  "class.archived": "Class archived",
  "class.restored": "Class restored",
  "student.created": "Student added",
  "student.updated": "Student details changed",
  "student.enrolled": "Student placed in a class",
  "student.class_changed": "Student moved to another class",
  "student.withdrawn": "Student withdrawn",
  "student.graduated": "Student graduated",
  "student.reactivated": "Student reactivated",
  "guardian.linked": "Guardian added",
  "guardian.updated": "Guardian details changed",
  "guardian.made_primary": "Primary contact changed",
  "guardian.unlinked": "Guardian removed",
  "campus.created": "Campus added",
  "campus.renamed": "Campus renamed",
  "campus.archived": "Campus archived",
  "campus.restored": "Campus restored",
  "invitation.issued": "Invitation created",
  "invitation.revoked": "Invitation revoked",
  "invitation.accepted": "Invitation accepted",
  "member.updated": "Member access changed",
  "member.suspended": "Member suspended",
  "member.reactivated": "Member reactivated",
};

export function auditLabel(action: string): string {
  return LABELS[action] ?? action;
}

const scalar = (v: unknown): string =>
  Array.isArray(v) ? v.join(", ") || "none" : v === null || v === undefined ? "none" : String(v);

/** One-line summary of an event's metadata, e.g. "name: Old → New". */
export function auditSummary(metadata: Record<string, unknown>): string {
  const parts: string[] = [];
  const changes = (metadata.changes ?? null) as Record<string, { from: unknown; to: unknown }> | null;
  if (changes) {
    for (const [field, change] of Object.entries(changes))
      parts.push(`${field}: ${scalar(change.from)} → ${scalar(change.to)}`);
  }
  for (const [key, value] of Object.entries(metadata)) {
    if (key === "changes") continue;
    if (value && typeof value === "object" && !Array.isArray(value) && "from" in value && "to" in value) {
      const change = value as { from: unknown; to: unknown };
      if (JSON.stringify(change.from) !== JSON.stringify(change.to))
        parts.push(`${key}: ${scalar(change.from)} → ${scalar(change.to)}`);
    } else if (typeof value !== "object" || Array.isArray(value) || value === null) {
      parts.push(`${key}: ${scalar(value)}`);
    }
  }
  return parts.join(" · ");
}
