import "server-only";
import type { ReminderResult } from "@/server/fees/reminders";

/** "Sent 3 reminders. 2 skipped: 1 has no guardian phone number, 1 was already reminded today." */
export function describeReminders(result: ReminderResult): string {
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const sent = result.sent ? `Sent ${plural(result.sent, "reminder", "reminders")}.` : "No reminders sent.";
  if (result.skipped.length === 0) return sent;
  const counts = { no_phone: 0, already_today: 0, not_owing: 0, not_found: 0 };
  for (const s of result.skipped) counts[s.reason]++;
  const reasons = [
    counts.no_phone && `${plural(counts.no_phone, "has", "have")} no guardian phone number`,
    counts.already_today && `${plural(counts.already_today, "was", "were")} already reminded today`,
    counts.not_owing && `${plural(counts.not_owing, "owes", "owe")} nothing`,
    counts.not_found && `${plural(counts.not_found, "is", "are")} not available to you`,
  ].filter(Boolean);
  return `${sent} ${result.skipped.length} skipped: ${reasons.join(", ")}.`;
}
