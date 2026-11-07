/**
 * The sibling discount rule (founder decision, 2026-11-06): each school chooses which child counts as the
 * first (and pays in full), and the discount for the second child and for each later one. Families are
 * students who share a guardian, directly or through a brother or sister.
 */

export const FIRST_CHILD_RULES = ["eldest", "youngest", "highest_class", "lowest_class"] as const;
export type FirstChildRule = (typeof FIRST_CHILD_RULES)[number];

export const FIRST_CHILD_LABELS: Record<FirstChildRule, string> = {
  eldest: "The eldest child (by date of birth)",
  youngest: "The youngest child (by date of birth)",
  highest_class: "The child in the highest class",
  lowest_class: "The child in the lowest class",
};

export interface SiblingRule {
  firstChild: FirstChildRule;
  /** Basis points (1000 = 10%); null: no discount for that place. */
  secondPercentBasisPoints: number | null;
  /** For the third child and later; null: the second child's discount. */
  laterPercentBasisPoints: number | null;
}

export interface Sibling {
  id: string;
  admissionNumber: string;
  dateOfBirth: string | null;
  levelSequence: number | null;
}

/** Groups students who share a guardian into families (a child linked to two guardians joins them up). */
export function familiesOf(links: readonly { studentId: string; guardianId: string }[]): string[][] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(x, root);
    return root;
  };
  const union = (a: string, b: string) => {
    for (const x of [a, b]) if (!parent.has(x)) parent.set(x, x);
    const [ra, rb] = [find(a), find(b)];
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const l of links) union(`s:${l.studentId}`, `g:${l.guardianId}`);
  const groups = new Map<string, string[]>();
  for (const key of parent.keys())
    if (key.startsWith("s:")) {
      const root = find(key);
      groups.set(root, [...(groups.get(root) ?? []), key.slice(2)]);
    }
  return [...groups.values()].filter((g) => g.length >= 2);
}

/** A family's children in rule order: the first pays in full. Unknowns go last; ties by admission number. */
export function orderSiblings(children: readonly Sibling[], rule: FirstChildRule): Sibling[] {
  const byAdmission = (a: Sibling, b: Sibling) => a.admissionNumber.localeCompare(b.admissionNumber);
  const known = <T>(value: T | null, other: T | null, compare: (x: T, y: T) => number) =>
    value === null && other === null ? 0 : value === null ? 1 : other === null ? -1 : compare(value, other);
  return [...children].sort((a, b) => {
    const order =
      rule === "eldest"
        ? known(a.dateOfBirth, b.dateOfBirth, (x, y) => x.localeCompare(y))
        : rule === "youngest"
          ? known(a.dateOfBirth, b.dateOfBirth, (x, y) => y.localeCompare(x))
          : rule === "highest_class"
            ? known(a.levelSequence, b.levelSequence, (x, y) => y - x)
            : known(a.levelSequence, b.levelSequence, (x, y) => x - y);
    return order || byAdmission(a, b);
  });
}

export interface SiblingDiscount {
  studentId: string;
  /** 2 for the second child, 3 for the third, and so on. */
  place: number;
  percentBasisPoints: number;
}

/** The discount each child in each family gets under the rule. */
export function planSiblingDiscounts(families: readonly Sibling[][], rule: SiblingRule): SiblingDiscount[] {
  const plan: SiblingDiscount[] = [];
  for (const family of families) {
    orderSiblings(family, rule.firstChild).forEach((child, i) => {
      const place = i + 1;
      if (place === 1) return;
      const bp =
        place === 2
          ? rule.secondPercentBasisPoints
          : (rule.laterPercentBasisPoints ?? rule.secondPercentBasisPoints);
      if (bp) plan.push({ studentId: child.id, place, percentBasisPoints: bp });
    });
  }
  return plan;
}

/** "2nd", "3rd", "11th". */
export function ordinalPlace(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${suffix}`;
}
