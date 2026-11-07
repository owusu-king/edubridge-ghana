import { buttonStyles } from "@/components/ui/button";
import { Select } from "@/components/ui/field";
import type { TermOption } from "@/web/terms";

/** Chooses the term shown (a plain GET form, so it works before scripts load). */
export function TermPicker({
  terms,
  termId,
  id = "term-picker",
}: {
  terms: TermOption[];
  termId: string;
  id?: string;
}) {
  return (
    <form method="get" className="flex items-end gap-2" aria-label="Choose term">
      <div className="space-y-1.5">
        <label htmlFor={id} className="block text-sm font-medium text-ink">
          Term
        </label>
        <Select id={id} name="term" defaultValue={termId} className="min-w-56">
          {terms.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
              {t.isCurrent ? " (current)" : ""}
            </option>
          ))}
        </Select>
      </div>
      <button type="submit" className={buttonStyles("secondary")}>
        Show
      </button>
    </form>
  );
}
