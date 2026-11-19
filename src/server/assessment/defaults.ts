import type { AssessmentComponent, GradeBand } from "../../lib/assessment";
import { curriculumTemplate, type Stage } from "../../lib/curricula";

/**
 * Ghana's defaults (the GES template in src/lib/curricula.ts). A school's own defaults come from its
 * template (`readTemplate`); these remain for code and tests that mean Ghana specifically.
 */
const GHANA = curriculumTemplate("ghana_ges", "GH");

export const DEFAULT_SUBJECTS: Record<Stage, string[]> = GHANA.subjects;
export const DEFAULT_COMPONENTS: AssessmentComponent[] = GHANA.components;
export const DEFAULT_BANDS: Record<Stage, GradeBand[]> = GHANA.bands;
