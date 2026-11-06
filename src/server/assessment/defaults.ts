import type { AssessmentComponent, GradeBand } from "../../lib/assessment";
import type { Stage } from "../academics/classes";

/**
 * Ghanaian defaults. Every one is an assumption to verify with pilot schools (listed in the roadmap), and
 * every one can be changed by the school.
 *
 * Subjects follow the GES/NaCCA Standards-Based Curriculum (KG–Basic 6, 2019) and the Common Core Programme
 * (Basic 7–9 / JHS, 2021). Primary lists the Basic 4–6 subjects; lower primary schools remove the ones they do
 * not teach (e.g. French, History) per level.
 */
export const DEFAULT_SUBJECTS: Record<Stage, string[]> = {
  creche: ["Language and Literacy", "Numeracy", "Creative Arts", "Our World Our People"],
  nursery: ["Language and Literacy", "Numeracy", "Creative Arts", "Our World Our People"],
  kindergarten: ["Language and Literacy", "Numeracy", "Creative Arts", "Our World Our People"],
  primary: [
    "English Language",
    "Mathematics",
    "Science",
    "Our World Our People",
    "History",
    "Religious and Moral Education",
    "Creative Arts",
    "Ghanaian Language",
    "French",
    "Computing",
    "Physical Education",
  ],
  jhs: [
    "English Language",
    "Mathematics",
    "Science",
    "Social Studies",
    "Religious and Moral Education",
    "Career Technology",
    "Creative Arts and Design",
    "Computing",
    "Ghanaian Language",
    "French",
    "Physical and Health Education",
  ],
};

/**
 * Class score (exercises, tests and projects, entered out of 50) and the end-of-term exam (marked out of 100),
 * each 50% of the subject total. Many schools use 30/70 or 40/60 instead; it is set per term.
 */
export const DEFAULT_COMPONENTS: AssessmentComponent[] = [
  { key: "class", name: "Class score", weight: 50, outOf: 50 },
  { key: "exam", name: "Exam", weight: 50, outOf: 100 },
];

/** NaCCA proficiency levels used with the Standards-Based Curriculum (KG and primary). */
const PROFICIENCY: GradeBand[] = [
  { min: 80, grade: "A", remark: "Advanced" },
  { min: 75, grade: "P", remark: "Proficient" },
  { min: 70, grade: "AP", remark: "Approaching proficiency" },
  { min: 65, grade: "D", remark: "Developing" },
  { min: 0, grade: "B", remark: "Beginning" },
];

/** The 1–9 scale JHS schools commonly use, mirroring BECE grade descriptors. Boundaries vary by school. */
const JHS_GRADES: GradeBand[] = [
  { min: 90, grade: "1", remark: "Highest" },
  { min: 80, grade: "2", remark: "Higher" },
  { min: 70, grade: "3", remark: "High" },
  { min: 60, grade: "4", remark: "High average" },
  { min: 55, grade: "5", remark: "Average" },
  { min: 50, grade: "6", remark: "Low average" },
  { min: 40, grade: "7", remark: "Low" },
  { min: 35, grade: "8", remark: "Lower" },
  { min: 0, grade: "9", remark: "Lowest" },
];

export const DEFAULT_BANDS: Record<Stage, GradeBand[]> = {
  creche: PROFICIENCY,
  nursery: PROFICIENCY,
  kindergarten: PROFICIENCY,
  primary: PROFICIENCY,
  jhs: JHS_GRADES,
};
