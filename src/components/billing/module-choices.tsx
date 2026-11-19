import { Badge } from "@/components/ui/badge";
import {
  MODULE_CATEGORIES,
  MODULE_STAGE_LABELS,
  MODULES,
  PLAN_CHOICES,
  type PlanModuleId,
} from "@/lib/modules";

/** Modules a new plan starts with: everything generally available (as before the registry). */
export const GENERAL_PLAN_CHOICES: readonly PlanModuleId[] = PLAN_CHOICES.filter(
  (id) => MODULES[id].stage === "general",
);

/**
 * The modules a plan can include, by category, for platform staff (plans and a school's own plan). Modules not
 * generally released show their stage: including one in a plan does not release it (ADR 0003).
 */
export function ModuleChoices({
  chosen,
  name = "features",
  describe = false,
}: {
  chosen: readonly string[];
  name?: string;
  describe?: boolean;
}) {
  const categories = [...new Set(PLAN_CHOICES.map((id) => MODULES[id].category))];
  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-medium text-ink">Included</legend>
      <p className="text-sm text-ink-3">
        School administration, students, classes, fees, payments, receipts, announcements, timetable and
        insights are in every plan. A module that is not released yet stays unavailable until it is.
      </p>
      {categories.map((category) => (
        <div key={category} className="space-y-2">
          <p className="text-xs font-medium tracking-wide text-ink-3 uppercase">
            {MODULE_CATEGORIES[category]}
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            {PLAN_CHOICES.filter((id) => MODULES[id].category === category).map((id) => (
              <label key={id} className="flex items-start gap-2 text-base text-ink">
                <input
                  type="checkbox"
                  name={name}
                  value={id}
                  defaultChecked={chosen.includes(id)}
                  className="mt-1 size-4 accent-accent"
                />
                <span>
                  {MODULES[id].name}
                  {MODULES[id].stage !== "general" && (
                    <Badge tone="neutral" className="ml-2">
                      {MODULE_STAGE_LABELS[MODULES[id].stage]}
                    </Badge>
                  )}
                  {describe && <span className="block text-sm text-ink-3">{MODULES[id].description}</span>}
                </span>
              </label>
            ))}
          </div>
        </div>
      ))}
    </fieldset>
  );
}
