import { buttonStyles } from "@/components/ui/button";
import { Select } from "@/components/ui/field";
import type { TermOption } from "@/web/terms";

/**
 * Chooses the term and campus the overview shows (OVR-01). A plain GET form, so it works before scripts
 * load. Either list is left out when there is only one choice.
 */
export function ScopePicker({
  terms,
  termId,
  campuses,
  campusId,
}: {
  terms: TermOption[];
  termId: string | null;
  campuses: { id: string; name: string }[];
  campusId: string | null;
}) {
  return (
    <form method="get" className="flex flex-wrap items-end gap-2" aria-label="Choose what to show">
      {terms.length > 1 && termId && (
        <div className="space-y-1.5">
          <label htmlFor="overview-term" className="block text-sm font-medium text-ink">
            Term
          </label>
          <Select id="overview-term" name="term" defaultValue={termId} className="min-w-56">
            {terms.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
                {t.isCurrent ? " (current)" : ""}
              </option>
            ))}
          </Select>
        </div>
      )}
      {campuses.length > 1 && (
        <div className="space-y-1.5">
          <label htmlFor="overview-campus" className="block text-sm font-medium text-ink">
            Campus
          </label>
          <Select id="overview-campus" name="campus" defaultValue={campusId ?? ""} className="min-w-44">
            <option value="">All campuses</option>
            {campuses.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </div>
      )}
      <button type="submit" className={buttonStyles("secondary")}>
        Show
      </button>
    </form>
  );
}
