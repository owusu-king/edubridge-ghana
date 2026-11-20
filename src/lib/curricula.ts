import type { AssessmentComponent, GradeBand } from "./assessment";
import { isCountryCode, type CountryCode } from "./countries";
import type { ReportCardStyle } from "./report-styles";

/**
 * Starter templates for a school's levels, subjects, grade bands and assessment parts (Africa-wide
 * readiness). The platform defines one per curriculum; each country has a default, and a school can pick
 * another (an international school in Accra, say) before it sets up. Everything a template creates can be
 * renamed, added to or removed by the school afterwards. Shared by server and client.
 *
 * Levels are grouped into five internal stages; each template names them its own way (Kenya's "Junior
 * School" is the stage Ghana calls "Junior High School"). Grade bands are per stage.
 *
 * Every template is an assumption to verify with schools in that country; none is an official standard.
 */

export const STAGES = ["creche", "nursery", "kindergarten", "primary", "jhs", "shs"] as const;
export type Stage = (typeof STAGES)[number];
/** The stages every template defines itself; senior secondary ("shs") is optional (2026-11-18). */
type BaseStage = Exclude<Stage, "shs">;

export interface CurriculumTemplate {
  id: string;
  name: string;
  /** One line shown when choosing a template. */
  description: string;
  stageLabels: Record<Stage, string>;
  levels: Record<Stage, string[]>;
  subjects: Record<Stage, string[]>;
  bands: Record<Stage, GradeBand[]>;
  components: AssessmentComponent[];
  /** The report-card layout schools on this curriculum usually print (a school can choose another). */
  reportStyle: ReportCardStyle;
  /**
   * Subjects of a stage that only some students take (SHS electives): set up as electives, so each student takes
   * the ones chosen for them (2026-11-18).
   */
  electives: Partial<Record<Stage, string[]>>;
}

/** A template as written: the five base stages, and senior secondary only where the curriculum has one here. */
type BaseTemplate = Omit<
  CurriculumTemplate,
  "stageLabels" | "levels" | "subjects" | "bands" | "electives"
> & {
  stageLabels: Record<BaseStage, string>;
  levels: Record<BaseStage, string[]>;
  subjects: Record<BaseStage, string[]>;
  bands: Record<BaseStage, GradeBand[]>;
  secondary?: {
    label: string;
    levels: string[];
    subjects: string[];
    electives: string[];
    bands: GradeBand[];
  };
};

/** Templates without a senior secondary stage offer none (no levels, no subjects); their bands are the JHS ones. */
function complete({ secondary, ...t }: BaseTemplate): CurriculumTemplate {
  return {
    ...t,
    stageLabels: { ...t.stageLabels, shs: secondary?.label ?? "Senior secondary" },
    levels: { ...t.levels, shs: secondary?.levels ?? [] },
    subjects: { ...t.subjects, shs: secondary ? [...secondary.subjects, ...secondary.electives] : [] },
    bands: { ...t.bands, shs: secondary?.bands ?? t.bands.jhs },
    electives: secondary ? { shs: secondary.electives } : {},
  };
}

const PROFICIENCY: GradeBand[] = [
  { min: 80, grade: "A", remark: "Advanced" },
  { min: 75, grade: "P", remark: "Proficient" },
  { min: 70, grade: "AP", remark: "Approaching proficiency" },
  { min: 65, grade: "D", remark: "Developing" },
  { min: 0, grade: "B", remark: "Beginning" },
];

const GH_JHS: GradeBand[] = [
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

const GH_EARLY = ["Language and Literacy", "Numeracy", "Creative Arts", "Our World Our People"];

/**
 * WASSCE grades as Ghanaian senior high schools use them for school assessment: A1 to F9 (assumption to verify with
 * pilot schools; WAEC grades the examination itself).
 */
const GH_WASSCE: GradeBand[] = [
  { min: 80, grade: "A1", remark: "Excellent" },
  { min: 70, grade: "B2", remark: "Very good" },
  { min: 65, grade: "B3", remark: "Good" },
  { min: 60, grade: "C4", remark: "Credit" },
  { min: 55, grade: "C5", remark: "Credit" },
  { min: 50, grade: "C6", remark: "Credit" },
  { min: 45, grade: "D7", remark: "Pass" },
  { min: 40, grade: "E8", remark: "Pass" },
  { min: 0, grade: "F9", remark: "Fail" },
];

/** Ghana: GES/NaCCA Standards-Based Curriculum (KG–Basic 6) and Common Core Programme (JHS). */
const GHANA: BaseTemplate = {
  id: "ghana_ges",
  name: "Ghana (GES)",
  description:
    "Creche to SHS 3: NaCCA subjects, proficiency levels, the JHS 1–9 scale and BECE aggregate, and WASSCE grades with electives at SHS.",
  stageLabels: {
    creche: "Creche",
    nursery: "Nursery",
    kindergarten: "Kindergarten",
    primary: "Primary",
    jhs: "Junior High School",
  },
  levels: {
    creche: ["Creche"],
    nursery: ["Nursery 1", "Nursery 2"],
    kindergarten: ["KG 1", "KG 2"],
    primary: ["Basic 1", "Basic 2", "Basic 3", "Basic 4", "Basic 5", "Basic 6"],
    jhs: ["JHS 1", "JHS 2", "JHS 3"],
  },
  subjects: {
    creche: GH_EARLY,
    nursery: GH_EARLY,
    kindergarten: GH_EARLY,
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
  },
  bands: {
    creche: PROFICIENCY,
    nursery: PROFICIENCY,
    kindergarten: PROFICIENCY,
    primary: PROFICIENCY,
    jhs: GH_JHS,
  },
  reportStyle: "ges",
  components: [
    { key: "class", name: "Class score", weight: 50, outOf: 50 },
    { key: "exam", name: "Exam", weight: 50, outOf: 100 },
  ],
  secondary: {
    label: "Senior High School",
    levels: ["SHS 1", "SHS 2", "SHS 3"],
    subjects: ["English Language", "Core Mathematics", "Integrated Science", "Social Studies"],
    electives: [
      "Elective Mathematics",
      "Physics",
      "Chemistry",
      "Biology",
      "Economics",
      "Geography",
      "Government",
      "History",
      "Literature-in-English",
      "Christian Religious Studies",
      "Business Management",
      "Financial Accounting",
      "Cost Accounting",
      "French",
      "Information and Communication Technology",
    ],
    bands: GH_WASSCE,
  },
};

/** Kenya's competency-based rubric (four levels), and the eight-level scale used in Junior School. */
const KE_FOUR: GradeBand[] = [
  { min: 75, grade: "EE", remark: "Exceeding expectations" },
  { min: 50, grade: "ME", remark: "Meeting expectations" },
  { min: 25, grade: "AE", remark: "Approaching expectations" },
  { min: 0, grade: "BE", remark: "Below expectations" },
];
const KE_EIGHT: GradeBand[] = [
  { min: 90, grade: "EE1", remark: "Exceptional" },
  { min: 75, grade: "EE2", remark: "Very good" },
  { min: 58, grade: "ME1", remark: "Good" },
  { min: 41, grade: "ME2", remark: "Fair" },
  { min: 31, grade: "AE1", remark: "Needs improvement" },
  { min: 21, grade: "AE2", remark: "Below average" },
  { min: 11, grade: "BE1", remark: "Well below average" },
  { min: 0, grade: "BE2", remark: "Minimal" },
];

/** Kenya: Competency-Based Education (pre-primary, primary and Junior School). */
const KENYA: BaseTemplate = {
  id: "kenya_cbe",
  name: "Kenya (Competency-Based Education)",
  description: "Playgroup to Grade 9, CBE learning areas and the EE/ME/AE/BE rubric.",
  stageLabels: {
    creche: "Playgroup",
    nursery: "Pre-primary",
    kindergarten: "Lower primary",
    primary: "Upper primary",
    jhs: "Junior School",
  },
  levels: {
    creche: ["Playgroup"],
    nursery: ["PP1", "PP2"],
    kindergarten: ["Grade 1", "Grade 2", "Grade 3"],
    primary: ["Grade 4", "Grade 5", "Grade 6"],
    jhs: ["Grade 7", "Grade 8", "Grade 9"],
  },
  subjects: {
    creche: ["Language Activities", "Mathematical Activities", "Creative Activities"],
    nursery: [
      "Language Activities",
      "Mathematical Activities",
      "Environmental Activities",
      "Creative Activities",
      "Religious Activities",
    ],
    kindergarten: [
      "English",
      "Kiswahili",
      "Mathematics",
      "Environmental Activities",
      "Creative Activities",
      "Religious Education",
      "Indigenous Language",
    ],
    primary: [
      "English",
      "Kiswahili",
      "Mathematics",
      "Science and Technology",
      "Agriculture and Nutrition",
      "Social Studies",
      "Creative Arts",
      "Religious Education",
    ],
    jhs: [
      "English",
      "Kiswahili",
      "Mathematics",
      "Integrated Science",
      "Pre-Technical Studies",
      "Social Studies",
      "Agriculture and Nutrition",
      "Creative Arts and Sports",
      "Religious Education",
    ],
  },
  bands: { creche: KE_FOUR, nursery: KE_FOUR, kindergarten: KE_FOUR, primary: KE_FOUR, jhs: KE_EIGHT },
  reportStyle: "ges",
  components: [
    { key: "class", name: "Classwork and CATs", weight: 40, outOf: 40 },
    { key: "exam", name: "End-term assessment", weight: 60, outOf: 100 },
  ],
};

const NG_BANDS: GradeBand[] = [
  { min: 70, grade: "A", remark: "Excellent" },
  { min: 60, grade: "B", remark: "Very good" },
  { min: 50, grade: "C", remark: "Good" },
  { min: 45, grade: "D", remark: "Fair" },
  { min: 40, grade: "E", remark: "Pass" },
  { min: 0, grade: "F", remark: "Fail" },
];

/** Nigeria: Universal Basic Education (nursery, primary and junior secondary). */
const NIGERIA: BaseTemplate = {
  id: "nigeria_ube",
  name: "Nigeria (Universal Basic Education)",
  description: "Pre-nursery to JSS 3, basic education subjects and the A–F scale.",
  stageLabels: {
    creche: "Pre-nursery",
    nursery: "Nursery",
    kindergarten: "Kindergarten",
    primary: "Primary",
    jhs: "Junior Secondary School",
  },
  levels: {
    creche: ["Pre-nursery"],
    nursery: ["Nursery 1", "Nursery 2"],
    kindergarten: ["Nursery 3"],
    primary: ["Primary 1", "Primary 2", "Primary 3", "Primary 4", "Primary 5", "Primary 6"],
    jhs: ["JSS 1", "JSS 2", "JSS 3"],
  },
  subjects: {
    creche: ["Literacy", "Numeracy", "Rhymes and Creative Arts"],
    nursery: ["Literacy", "Numeracy", "Social Habits", "Health Habits", "Rhymes and Creative Arts"],
    kindergarten: ["Literacy", "Numeracy", "Basic Science", "Social Habits", "Rhymes and Creative Arts"],
    primary: [
      "English Studies",
      "Mathematics",
      "Basic Science and Technology",
      "Religion and National Values",
      "Cultural and Creative Arts",
      "Nigerian Language",
      "Pre-vocational Studies",
      "French",
    ],
    jhs: [
      "English Studies",
      "Mathematics",
      "Basic Science and Technology",
      "Religion and National Values",
      "Business Studies",
      "Cultural and Creative Arts",
      "Nigerian Language",
      "Pre-vocational Studies",
      "French",
    ],
  },
  bands: { creche: NG_BANDS, nursery: NG_BANDS, kindergarten: NG_BANDS, primary: NG_BANDS, jhs: NG_BANDS },
  reportStyle: "ges",
  components: [
    { key: "class", name: "Continuous assessment", weight: 40, outOf: 40 },
    { key: "exam", name: "Examination", weight: 60, outOf: 60 },
  ],
};

/** Marks out of 20, as French-system schools give them, read as percentages (10/20 = 50). */
const FR_BANDS: GradeBand[] = [
  { min: 80, grade: "TB", remark: "Très bien" },
  { min: 70, grade: "B", remark: "Bien" },
  { min: 60, grade: "AB", remark: "Assez bien" },
  { min: 50, grade: "P", remark: "Passable" },
  { min: 0, grade: "I", remark: "Insuffisant" },
];

/** French-system schools (Côte d'Ivoire, Senegal, Cameroon's francophone sub-system). */
const FRANCOPHONE: BaseTemplate = {
  id: "francophone",
  name: "Système francophone",
  description: "Crèche à la 3e, matières en français, notes sur 20.",
  stageLabels: {
    creche: "Crèche",
    nursery: "Maternelle",
    kindergarten: "Grande section",
    primary: "Primaire",
    jhs: "Premier cycle du secondaire",
  },
  levels: {
    creche: ["Crèche"],
    nursery: ["Petite section", "Moyenne section"],
    kindergarten: ["Grande section"],
    primary: ["CP1", "CP2", "CE1", "CE2", "CM1", "CM2"],
    jhs: ["6e", "5e", "4e", "3e"],
  },
  subjects: {
    creche: ["Langage", "Éveil", "Activités créatives"],
    nursery: ["Langage", "Pré-mathématiques", "Éveil", "Activités créatives"],
    kindergarten: ["Langage", "Pré-lecture", "Pré-mathématiques", "Éveil", "Activités créatives"],
    primary: [
      "Français",
      "Mathématiques",
      "Éveil scientifique",
      "Histoire-Géographie",
      "Éducation civique et morale",
      "Anglais",
      "Arts plastiques",
      "Éducation physique et sportive",
    ],
    jhs: [
      "Français",
      "Mathématiques",
      "Anglais",
      "Histoire-Géographie",
      "Sciences de la vie et de la terre",
      "Physique-Chimie",
      "Éducation civique et morale",
      "Éducation physique et sportive",
    ],
  },
  bands: { creche: FR_BANDS, nursery: FR_BANDS, kindergarten: FR_BANDS, primary: FR_BANDS, jhs: FR_BANDS },
  reportStyle: "ges",
  components: [
    { key: "class", name: "Devoirs", weight: 40, outOf: 20 },
    { key: "exam", name: "Composition", weight: 60, outOf: 20 },
  ],
};

const INTL_BANDS: GradeBand[] = [
  { min: 90, grade: "A*", remark: "Outstanding" },
  { min: 80, grade: "A", remark: "Excellent" },
  { min: 70, grade: "B", remark: "Very good" },
  { min: 60, grade: "C", remark: "Good" },
  { min: 50, grade: "D", remark: "Satisfactory" },
  { min: 40, grade: "E", remark: "Weak" },
  { min: 0, grade: "U", remark: "Ungraded" },
];

/** English-medium international schools (British-style years), and countries without their own template. */
const INTERNATIONAL: BaseTemplate = {
  id: "international",
  name: "International (British-style years)",
  description: "Early years to Year 9, core subjects and an A*–U scale.",
  stageLabels: {
    creche: "Early years",
    nursery: "Nursery",
    kindergarten: "Reception",
    primary: "Primary",
    jhs: "Lower secondary",
  },
  levels: {
    creche: ["Pre-nursery"],
    nursery: ["Nursery"],
    kindergarten: ["Reception"],
    primary: ["Year 1", "Year 2", "Year 3", "Year 4", "Year 5", "Year 6"],
    jhs: ["Year 7", "Year 8", "Year 9"],
  },
  subjects: {
    creche: ["Communication and Language", "Mathematics", "Expressive Arts"],
    nursery: [
      "Communication and Language",
      "Literacy",
      "Mathematics",
      "Understanding the World",
      "Expressive Arts",
    ],
    kindergarten: [
      "Communication and Language",
      "Literacy",
      "Mathematics",
      "Understanding the World",
      "Expressive Arts",
    ],
    primary: [
      "English",
      "Mathematics",
      "Science",
      "Humanities",
      "Computing",
      "Art and Design",
      "Music",
      "Physical Education",
      "Additional Language",
    ],
    jhs: [
      "English",
      "Mathematics",
      "Science",
      "History",
      "Geography",
      "Computing",
      "Art and Design",
      "Physical Education",
      "Additional Language",
    ],
  },
  bands: {
    creche: INTL_BANDS,
    nursery: INTL_BANDS,
    kindergarten: INTL_BANDS,
    primary: INTL_BANDS,
    jhs: INTL_BANDS,
  },
  reportStyle: "cambridge",
  components: [
    { key: "class", name: "Coursework", weight: 40, outOf: 100 },
    { key: "exam", name: "End-of-term exam", weight: 60, outOf: 100 },
  ],
};

/** IB grade boundaries on four criteria marked out of 8 (32 in all), as whole percentages. */
const IB_MYP: GradeBand[] = [
  { min: 88, grade: "7", remark: "Excellent" },
  { min: 75, grade: "6", remark: "Very good" },
  { min: 59, grade: "5", remark: "Good" },
  { min: 47, grade: "4", remark: "Satisfactory" },
  { min: 31, grade: "3", remark: "Limited" },
  { min: 19, grade: "2", remark: "Very limited" },
  { min: 0, grade: "1", remark: "Minimal" },
];
const IB_PYP: GradeBand[] = [
  { min: 85, grade: "EX", remark: "Exceeding" },
  { min: 65, grade: "ME", remark: "Meeting" },
  { min: 40, grade: "AP", remark: "Approaching" },
  { min: 0, grade: "BE", remark: "Beginning" },
];

/** IB World Schools: Primary Years Programme (descriptors) and Middle Years Programme (criteria A–D, 1–7). */
const IB: BaseTemplate = {
  id: "ib",
  name: "International Baccalaureate (PYP and MYP)",
  description: "Early years to MYP 5, MYP subject groups, criteria A to D marked out of 8 and the 1–7 scale.",
  stageLabels: {
    creche: "Early years",
    nursery: "PYP early years",
    kindergarten: "PYP Kindergarten",
    primary: "Primary Years Programme",
    jhs: "Middle Years Programme",
  },
  levels: {
    creche: ["Early Years 1"],
    nursery: ["Early Years 2"],
    kindergarten: ["Kindergarten"],
    primary: ["PYP 1", "PYP 2", "PYP 3", "PYP 4", "PYP 5"],
    jhs: ["MYP 1", "MYP 2", "MYP 3", "MYP 4", "MYP 5"],
  },
  subjects: {
    creche: ["Language", "Mathematics", "Arts", "Personal, Social and Physical Education"],
    nursery: ["Language", "Mathematics", "Arts", "Personal, Social and Physical Education"],
    kindergarten: [
      "Language",
      "Mathematics",
      "Science",
      "Social Studies",
      "Arts",
      "Personal, Social and Physical Education",
    ],
    primary: [
      "Language",
      "Mathematics",
      "Science",
      "Social Studies",
      "Arts",
      "Personal, Social and Physical Education",
      "Additional Language",
    ],
    jhs: [
      "Language and Literature",
      "Language Acquisition",
      "Individuals and Societies",
      "Sciences",
      "Mathematics",
      "Arts",
      "Physical and Health Education",
      "Design",
    ],
  },
  bands: { creche: IB_PYP, nursery: IB_PYP, kindergarten: IB_PYP, primary: IB_PYP, jhs: IB_MYP },
  reportStyle: "ib",
  components: [
    { key: "crit_a", name: "Criterion A", weight: 25, outOf: 8 },
    { key: "crit_b", name: "Criterion B", weight: 25, outOf: 8 },
    { key: "crit_c", name: "Criterion C", weight: 25, outOf: 8 },
    { key: "crit_d", name: "Criterion D", weight: 25, outOf: 8 },
  ],
};

/** Letter grades with grade points (unweighted 4.0 scale). */
const US_LETTERS: GradeBand[] = [
  { min: 93, grade: "A", remark: "Excellent", points: 400 },
  { min: 90, grade: "A-", remark: "Excellent", points: 370 },
  { min: 87, grade: "B+", remark: "Good", points: 330 },
  { min: 83, grade: "B", remark: "Good", points: 300 },
  { min: 80, grade: "B-", remark: "Good", points: 270 },
  { min: 77, grade: "C+", remark: "Satisfactory", points: 230 },
  { min: 73, grade: "C", remark: "Satisfactory", points: 200 },
  { min: 70, grade: "C-", remark: "Satisfactory", points: 170 },
  { min: 67, grade: "D+", remark: "Passing", points: 130 },
  { min: 65, grade: "D", remark: "Passing", points: 100 },
  { min: 0, grade: "F", remark: "Failing", points: 0 },
];
/** Standards-based marks for the early grades. */
const US_STANDARDS: GradeBand[] = [
  { min: 85, grade: "4", remark: "Exceeds the standard" },
  { min: 70, grade: "3", remark: "Meets the standard" },
  { min: 50, grade: "2", remark: "Approaching the standard" },
  { min: 0, grade: "1", remark: "Beginning" },
];

/** American-curriculum schools: Pre-K to Grade 8, letter grades and a GPA from Grade 1. */
const AMERICAN: BaseTemplate = {
  id: "american",
  name: "American (Pre-K to Grade 8)",
  description:
    "Pre-K to Grade 8, core subjects, letter grades with a 4.0 GPA and standards-based early grades.",
  stageLabels: {
    creche: "Preschool",
    nursery: "Pre-kindergarten",
    kindergarten: "Kindergarten",
    primary: "Elementary school",
    jhs: "Middle school",
  },
  levels: {
    creche: ["Pre-K 3"],
    nursery: ["Pre-K 4"],
    kindergarten: ["Kindergarten"],
    primary: ["Grade 1", "Grade 2", "Grade 3", "Grade 4", "Grade 5"],
    jhs: ["Grade 6", "Grade 7", "Grade 8"],
  },
  subjects: {
    creche: ["Language and Literacy", "Mathematics", "Art", "Physical Development"],
    nursery: ["Language and Literacy", "Mathematics", "Science", "Art", "Physical Development"],
    kindergarten: [
      "English Language Arts",
      "Mathematics",
      "Science",
      "Social Studies",
      "Art",
      "Physical Education",
    ],
    primary: [
      "English Language Arts",
      "Mathematics",
      "Science",
      "Social Studies",
      "Art",
      "Music",
      "Physical Education",
      "World Language",
    ],
    jhs: [
      "English Language Arts",
      "Mathematics",
      "Science",
      "Social Studies",
      "World Language",
      "Art",
      "Music",
      "Physical Education",
      "Technology",
    ],
  },
  bands: {
    creche: US_STANDARDS,
    nursery: US_STANDARDS,
    kindergarten: US_STANDARDS,
    primary: US_LETTERS,
    jhs: US_LETTERS,
  },
  reportStyle: "american",
  components: [
    { key: "class", name: "Classwork and homework", weight: 40, outOf: 100 },
    { key: "exam", name: "Tests and exams", weight: 60, outOf: 100 },
  ],
};

export const CURRICULUM_TEMPLATES: readonly CurriculumTemplate[] = [
  GHANA,
  KENYA,
  NIGERIA,
  FRANCOPHONE,
  INTERNATIONAL,
  IB,
  AMERICAN,
].map(complete);
export type TemplateId = (typeof CURRICULUM_TEMPLATES)[number]["id"];
export const TEMPLATE_IDS = CURRICULUM_TEMPLATES.map((t) => t.id) as [TemplateId, ...TemplateId[]];

/** Each country's default template (platform level). Countries without their own use the international one. */
const COUNTRY_TEMPLATE: Record<CountryCode, TemplateId> = {
  GH: "ghana_ges",
  KE: "kenya_cbe",
  NG: "nigeria_ube",
  CI: "francophone",
  SN: "francophone",
  CM: "francophone",
  UG: "international",
  TZ: "international",
  RW: "international",
  ZM: "international",
  ZA: "international",
};

export function defaultTemplateId(country: string): TemplateId {
  return isCountryCode(country) ? COUNTRY_TEMPLATE[country] : "international";
}

/** The template a school uses: its own choice, else its country's. */
export function curriculumTemplate(chosen: string | null | undefined, country: string): CurriculumTemplate {
  return (
    CURRICULUM_TEMPLATES.find((t) => t.id === chosen) ??
    CURRICULUM_TEMPLATES.find((t) => t.id === defaultTemplateId(country))!
  );
}
