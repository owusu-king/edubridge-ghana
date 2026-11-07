import { formatCedis } from "./money";

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
  "attendance.register_saved": "Register taken",
  "subjects.set_up": "Subjects set up",
  "subject.created": "Subject added",
  "subject.updated": "Subject changed",
  "assessment_scheme.saved": "Term assessment changed",
  "grading_scale.saved": "Grades changed",
  "grading_scale.reset": "Default grades restored",
  "assessment.scores_saved": "Scores entered",
  "report_card.remarks_saved": "Report card remarks saved",
  "report_cards.published": "Report cards published",
  "report_card.withdrawn": "Report card withdrawn",
  "report_cards.print_requested": "Report cards printed",
  "student.created": "Student added",
  "students.imported": "Students imported",
  "student.updated": "Student details changed",
  "student.enrolled": "Student placed in a class",
  "student.class_changed": "Student moved to another class",
  "student.withdrawn": "Student withdrawn",
  "student.graduated": "Student graduated",
  "student.reactivated": "Student reactivated",
  "fee_item.created": "Fee item added",
  "fee_items.set_up": "Fee items set up",
  "fee_item.renamed": "Fee item renamed",
  "fee_item.archived": "Fee item archived",
  "fee_item.restored": "Fee item restored",
  "fees.structure_updated": "Fees changed for a level",
  "fees.structure_copied": "Fees copied from another term",
  "fees.term_billed": "Students billed for a term",
  "ledger.entry_reversed": "Fee account entry reversed",
  "payment.recorded": "Payment recorded",
  "payment.voided": "Receipt voided",
  "mobile_money.requested": "Mobile Money prompt sent",
  "mobile_money.confirmed": "Mobile Money payment confirmed",
  "mobile_money.failed": "Mobile Money prompt not paid",
  "mobile_money.expired": "Mobile Money prompt unanswered",
  "mobile_money.needs_review": "Mobile Money payment held for review",
  "mobile_money.reviewed": "Held Mobile Money payment reviewed",
  "fees.opening_balances_imported": "Opening balances imported",
  "fees.opening_balance_set": "Opening balance recorded",
  "fees.charge_added": "One-off charge added",
  "fees.credit_added": "One-off credit added",
  "fees.concession_added": "Scholarship or discount added",
  "fees.concession_ended": "Scholarship or discount ended",
  "fees.payment_plan_created": "Payment plan agreed",
  "fees.payment_plan_cancelled": "Payment plan cancelled",
  "fees.reminders_sent": "Fee reminders sent by SMS",
  "guardian.linked": "Guardian added",
  "guardian.updated": "Guardian details changed",
  "guardian.made_primary": "Primary contact changed",
  "guardian.unlinked": "Guardian removed",
  "guardian.parent_access_blocked": "Guardian blocked from the parent view",
  "guardian.parent_access_allowed": "Guardian allowed to use the parent view again",
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
  "announcement.posted": "Announcement posted",
  "attendance.absence_alerts_sent": "Absence SMS sent",
  "attendance.alert_settings_saved": "Absence SMS settings changed",
  "data.exported": "Records downloaded",
  "fees.sibling_discounts_applied": "Sibling discounts applied",
  "fees.sibling_rule_saved": "Sibling discount rule changed",
  "holidays.added": "Holidays added",
  "holiday.removed": "Holiday removed",
  "students.moved": "Students moved to another term",
  "students.move_undone": "Move to another term undone",
  "subscription.updated": "EduBridge subscription changed",
  "subscription_invoice.issued": "EduBridge invoice issued",
  "school.contacts_updated": "Contact details for families changed",
  "school.message_settings_updated": "Message settings changed",
  "school.overview_preferences_updated": "Overview figures changed",
  "school.void_policy_updated": "Who may void receipts changed",
  "support.granted": "Support access allowed",
  "support.ended": "Support access ended",
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
    } else if (Array.isArray(value) && value.some((v) => v !== null && typeof v === "object")) {
      // Detailed records (e.g. each mark changed) are kept in full but summarised as a count.
      parts.push(`${key}: ${value.length}`);
    } else if (key.endsWith("Pesewas") && typeof value === "number") {
      // Money is stored in pesewas; show it in cedis.
      parts.push(`${key.slice(0, -"Pesewas".length)}: ${formatCedis(value)}`);
    } else if (typeof value !== "object" || Array.isArray(value) || value === null) {
      parts.push(`${key}: ${scalar(value)}`);
    }
  }
  return parts.join(" · ");
}
