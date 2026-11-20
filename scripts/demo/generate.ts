/**
 * Builds a demonstration school with a term's worth of made-up activity: students and families, fees,
 * payments (cash, Mobile Money, bank), reminders, daily registers, marks and one class's published report
 * cards. Everything after the school and its staff accounts goes through the same service functions
 * the app uses, so the data obeys every rule the app enforces (ledger, receipts, versions, audit).
 *
 * The school is marked as a demo: labelled on every page, it sends no SMS or email, and families cannot
 * sign in to it (its phone numbers are random and could belong to real people).
 */
import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { createAcademicYear, listAcademicYears, setCurrentTerm } from "../../src/server/academics/calendar";
import { addHolidays } from "../../src/server/academics/holidays";
import {
  createClass,
  DEFAULT_LEVELS,
  listLevelsWithClasses,
  setupDefaultLevels,
  STAGES,
  type Stage,
} from "../../src/server/academics/classes";
import { publishReportCards, saveReportRemarks } from "../../src/server/assessment/report-cards";
import { getScoreSheet, saveScores } from "../../src/server/assessment/scores";
import { setupDefaultSubjects } from "../../src/server/assessment/setup";
import { syncRegister } from "../../src/server/attendance/registers";
import { hashPassword } from "../../src/server/auth/password";
import { generateDemoFinance } from "./finance";
import { addDemoVisitor } from "./visitor";
import type { Role } from "../../src/server/authz/permissions";
import { createCampus } from "../../src/server/campuses/service";
import type { Database } from "../../src/server/db/client";
import {
  catalogPrices,
  enrolments,
  feeReminders,
  guardians,
  ledgerEntries,
  levels,
  levelSubjects,
  memberships,
  planPresets,
  platformAdmins,
  schoolModules,
  studentGuardians,
  students,
  tenantEntitlements,
  tenants,
  users,
} from "../../src/server/db/schema";
import { presetValues } from "../../src/server/billing/preset-values";
import { addConcession } from "../../src/server/fees/concessions";
import { billTerm } from "../../src/server/fees/ledger";
import { setOpeningBalance } from "../../src/server/fees/opening-balances";
import { createPaymentPlan } from "../../src/server/fees/payment-plans";
import { recordPayment, type PaymentMethod } from "../../src/server/fees/payments";
import { listFeeItems, saveLevelFees, setupFeeItems } from "../../src/server/fees/structure";
import {
  autoMapColumns,
  IMPORT_FIELDS,
  importStudents,
  type FieldKey,
} from "../../src/server/imports/students";
import { resolveTenantContext } from "../../src/server/tenancy/service";
import { addDays, isWeekend, type AttendanceStatus } from "../../src/lib/attendance";
import { todayIn } from "../../src/lib/format";
import { ghanaPublicHolidays } from "../../src/lib/holidays";
import { pesewasToInput } from "../../src/lib/money";
import {
  ABSENCE_REASONS,
  ATTITUDES,
  BOYS,
  classTeacherRemark,
  CONDUCT,
  GIRLS,
  headTeacherRemark,
  INTERESTS,
  random,
  STAFF,
  SURNAMES,
} from "./data";
import { generateModuleData } from "./modules";

export const DEFAULT_DEMO_LEVELS = [
  "KG 1",
  "KG 2",
  "Basic 1",
  "Basic 2",
  "Basic 3",
  "Basic 4",
  "Basic 5",
  "Basic 6",
  "JHS 1",
  "JHS 2",
  "JHS 3",
];

export interface DemoOptions {
  slug: string;
  name: string;
  /** Password for every demo staff account. */
  password: string;
  /** Levels to run, one class each (default KG 1 to JHS 3). */
  levels?: string[];
  studentsPerClass?: number;
  /** Same seed, same school. */
  seed?: number;
  /** Progress messages. */
  log?: (message: string) => void;
}

export interface DemoSummary {
  tenantId: string;
  slug: string;
  accounts: { role: string; email: string }[];
  students: number;
  payments: number;
  registers: number;
  reminders: number;
  publishedClass: string;
}

const TIME_ZONE = "Africa/Accra";
/** Public holidays that fall in term (month-day): no registers or payments on these days. */
/** Ghana's public holidays from 2020 to 2040: no registers or payments on these days. */
const HOLIDAYS = new Set(ghanaPublicHolidays("2020-01-01", "2040-12-31").map((h) => h.date));
const isSchoolDay = (date: string) => !isWeekend(date) && !HOLIDAYS.has(date);

/** A Ghanaian three-term school year starting in September of `y`. */
export function demoYear(y: number) {
  return {
    name: `${y}/${y + 1}`,
    terms: [
      { name: "Term 1", startsOn: `${y}-09-08`, endsOn: `${y}-12-18` },
      { name: "Term 2", startsOn: `${y + 1}-01-12`, endsOn: `${y + 1}-04-09` },
      { name: "Term 3", startsOn: `${y + 1}-05-04`, endsOn: `${y + 1}-07-24` },
    ],
  };
}

/** Ghanaian three-term year containing today; the current term is the latest one that has started. */
export function demoCalendar(today: string) {
  const make = demoYear;
  const year = Number(today.slice(0, 4));
  let calendar = make(Number(today.slice(5, 7)) >= 9 ? year : year - 1);
  if (calendar.terms[0]!.startsOn > today) calendar = make(year - 1);
  return { ...calendar, current: calendar.terms.filter((t) => t.startsOn <= today).length - 1 };
}

function schoolDays(from: string, to: string): string[] {
  const days: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) if (isSchoolDay(d)) days.push(d);
  return days;
}

const stageOf = (level: string): Stage => STAGES.find((s) => DEFAULT_LEVELS[s].includes(level))!;

/** Fees per term in cedis, by stage; an item left out is not charged. */
const FEES: Record<Stage, Partial<Record<string, number>>> = {
  creche: { Tuition: 700, "PTA dues": 50, "Books and stationery": 80 },
  nursery: { Tuition: 750, "PTA dues": 50, "Books and stationery": 100 },
  kindergarten: { Tuition: 850, "PTA dues": 50, "Books and stationery": 120, "Examination fees": 40 },
  primary: { Tuition: 1100, "PTA dues": 50, "Books and stationery": 180, "Examination fees": 60, ICT: 80 },
  jhs: { Tuition: 1350, "PTA dues": 50, "Books and stationery": 220, "Examination fees": 80, ICT: 100 },
  shs: { Tuition: 1800, "PTA dues": 60, "Books and stationery": 260, "Examination fees": 120, ICT: 120 },
};

/** Age in years at the start of the school year, by level. */
function ageFor(level: string): number {
  if (level.startsWith("KG")) return 3 + Number(level.slice(-1));
  if (level.startsWith("Basic")) return 5 + Number(level.slice(-1));
  if (level.startsWith("JHS")) return 11 + Number(level.slice(-1));
  return 3;
}

const PHONE_PREFIXES = ["024", "054", "055", "059", "020", "050", "027", "026"];

/** Runs fn as the owner role inside the school's tenant context (row-level security still applies). */
async function asTenant<T>(
  owner: Database,
  tenantId: string,
  fn: (tx: Parameters<Parameters<Database["transaction"]>[0]>[0]) => Promise<T>,
) {
  return owner.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}

export async function generateDemoSchool(
  dbs: { owner: Database; app: Database },
  options: DemoOptions,
): Promise<DemoSummary> {
  const { owner, app } = dbs;
  const log = options.log ?? (() => {});
  const rng = random(options.seed ?? 1);
  const levelNames = options.levels ?? DEFAULT_DEMO_LEVELS;
  const perClass = options.studentsPerClass ?? 28;
  const today = todayIn(TIME_ZONE);
  const featuredLevel = levelNames.includes("Basic 4") ? "Basic 4" : levelNames[0]!;

  // 1. The school and its staff accounts (owner role: the app never creates schools or users this way).
  const [existing] = await owner
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, options.slug));
  if (existing)
    throw new Error(`A school with the address "${options.slug}" already exists. Choose another --slug.`);
  const [tenant] = await owner
    .insert(tenants)
    .values({ slug: options.slug, name: options.name, isDemo: true, mfaRequiredRoles: [] })
    .returning({ id: tenants.id });
  const tenantId = tenant!.id;
  log(`Created ${options.name} (/s/${options.slug}).`);

  const passwordHash = await hashPassword(options.password);
  const domain = `${options.slug}.demo.test`;
  const accounts: { role: string; email: string }[] = [];
  const addPerson = async (email: string, name: string, roles: Role[]) => {
    const [user] = await owner
      .insert(users)
      .values({ email, name, passwordHash })
      .onConflictDoUpdate({ target: users.email, set: { name, passwordHash } })
      .returning({ id: users.id });
    const membership = await asTenant(owner, tenantId, async (tx) => {
      const [row] = await tx.insert(memberships).values({ tenantId, userId: user!.id, roles }).returning();
      return row!;
    });
    return { userId: user!.id, membershipId: membership.id };
  };
  const ownerPerson = await addPerson(`proprietor@${domain}`, STAFF.owner, ["owner"]);
  const headPerson = await addPerson(`head@${domain}`, STAFF.head, ["headteacher"]);
  const adminPerson = await addPerson(`admin@${domain}`, STAFF.admin, ["admin"]);
  const bursarPerson = await addPerson(`accountant@${domain}`, STAFF.bursar, ["bursar"]);
  accounts.push(
    { role: "Proprietor", email: `proprietor@${domain}` },
    { role: "Head teacher", email: `head@${domain}` },
    { role: "Administrator", email: `admin@${domain}` },
    { role: "Accountant", email: `accountant@${domain}` },
  );
  // The shared, view-only account behind the landing page's "Try the demo school".
  await addDemoVisitor(owner, options.slug);
  const teacherFor = new Map<string, string>();
  const teacherPeople: { level: string; userId: string; membershipId: string; name: string }[] = [];
  let n = 0;
  for (const [i, level] of levelNames.entries()) {
    const featured = level === featuredLevel;
    const email = featured ? `teacher@${domain}` : `teacher.${++n}@${domain}`;
    const name = STAFF.teachers[i % STAFF.teachers.length]!;
    const person = await addPerson(email, name, ["teacher"]);
    teacherFor.set(level, person.membershipId);
    teacherPeople.push({ level, name, ...person });
    if (featured) accounts.push({ role: `Teacher (class teacher of ${level})`, email });
  }

  // The demo school is on Premium with the operations add-ons, when EduBridge's plans exist (Admin, Plans), so
  // it shows a real plan; otherwise it has no plan row, which gives it every module. Written as a platform
  // administrator, as the app would. Demo schools are never invoiced.
  const [platformAdmin] = await owner.select({ id: platformAdmins.userId }).from(platformAdmins).limit(1);
  const [premium] = await owner.select().from(planPresets).where(eq(planPresets.name, "Premium"));
  if (platformAdmin && premium) {
    const addOnPrices = await owner
      .select({ module: catalogPrices.module, price: catalogPrices.pricePesewas })
      .from(catalogPrices)
      .where(
        and(
          isNull(catalogPrices.archivedAt),
          isNull(catalogPrices.presetId),
          eq(catalogPrices.billingPeriod, "termly"),
          eq(catalogPrices.currencyCode, "GHS"),
        ),
      );
    await owner.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('app.tenant_id', ${tenantId}, true), set_config('app.user_id', ${platformAdmin.id}, true)`,
      );
      await tx.insert(tenantEntitlements).values({
        tenantId,
        ...presetValues(premium, "GHS"),
        subscriptionStatus: "active",
        billingPeriod: "termly",
      });
      for (const addOn of ["transport", "boarding", "library", "inventory_assets"] as const) {
        const price = addOnPrices.find((p) => p.module === addOn)?.price ?? null;
        await tx.insert(schoolModules).values({
          tenantId,
          module: addOn,
          source: "addon",
          startsOn: addDays(today, -120),
          billingPeriod: price === null ? null : "termly",
          pricePesewas: price,
          priceUnit: price === null ? null : "flat",
          currencyCode: price === null ? null : "GHS",
          note: "Demo school",
          grantedByUserId: platformAdmin.id,
        });
      }
    });
  }

  const ctxOf = async (userId: string) => {
    const ctx = await resolveTenantContext(app, options.slug, userId);
    if (!ctx) throw new Error("Could not open the demo school.");
    return ctx;
  };
  const proprietor = await ctxOf(ownerPerson.userId);
  const head = await ctxOf(headPerson.userId);
  const bursar = await ctxOf(bursarPerson.userId);

  // 2. Campus, calendar, levels and classes.
  const campus = await createCampus(app, proprietor, { name: "Main campus" });
  const calendar = demoCalendar(today);
  await createAcademicYear(app, proprietor, { name: calendar.name, terms: calendar.terms });
  const [year] = await listAcademicYears(app, proprietor);
  const term = year!.terms[calendar.current]!;
  await setCurrentTerm(app, proprietor, term.id);
  // The year's public holidays on weekdays, as a school would add them from the suggestions.
  await addHolidays(
    app,
    proprietor,
    ghanaPublicHolidays(year!.startsOn, year!.endsOn)
      .filter((h) => !isWeekend(h.date))
      .map((h) => ({ name: h.name, startsOn: h.date, endsOn: h.date })),
  );
  const stages = [...new Set(levelNames.map(stageOf))];
  await setupDefaultLevels(app, proprietor, { stages });
  const levelRows = await listLevelsWithClasses(app, proprietor);
  const classIds = new Map<string, string>();
  for (const level of levelNames) {
    const row = levelRows.find((l) => l.name === level);
    if (!row) throw new Error(`Unknown level "${level}". Use names like ${DEFAULT_DEMO_LEVELS.join(", ")}.`);
    classIds.set(
      level,
      await createClass(app, proprietor, {
        levelId: row.id,
        campusId: campus.id,
        name: level,
        classTeacherMembershipId: teacherFor.get(level)!,
      }),
    );
  }
  log(`Calendar ${calendar.name} (current: ${term.name}) and ${levelNames.length} classes.`);

  // The term before this one, complete, so the forecast, insights and early warning have history. In Term 1
  // it is the last term of the year before (students were a class lower then).
  const yearStart = Number(calendar.name.slice(0, 4));
  let previous: { id: string; startsOn: string; endsOn: string; sameYear: boolean };
  if (calendar.current > 0) previous = { ...year!.terms[calendar.current - 1]!, sameYear: true };
  else {
    const before = demoYear(yearStart - 1);
    await createAcademicYear(app, proprietor, { name: before.name, terms: before.terms });
    const lastYear = (await listAcademicYears(app, proprietor)).find((y) => y.name === before.name)!;
    await addHolidays(
      app,
      proprietor,
      ghanaPublicHolidays(lastYear.startsOn, lastYear.endsOn)
        .filter((h) => !isWeekend(h.date))
        .map((h) => ({ name: h.name, startsOn: h.date, endsOn: h.date })),
    );
    previous = { ...lastYear.terms[2]!, sameYear: false };
  }

  // 3. Students and families, through the spreadsheet import (as a school would).
  const families: { surname: string; guardian: string; phone: string; relationship: string }[] = [];
  const rows: string[][] = [];
  for (const level of levelNames) {
    for (let i = 0; i < perClass; i++) {
      const female = rng.chance(0.5);
      const family =
        families.length > 0 && rng.chance(0.12)
          ? rng.pick(families)
          : (() => {
              const surname = rng.pick(SURNAMES);
              const relationship = rng.chance(0.6) ? "Mother" : rng.chance(0.9) ? "Father" : "Grandmother";
              const first = relationship === "Father" ? rng.pick(BOYS) : rng.pick(GIRLS);
              const f = {
                surname,
                guardian: `${first} ${surname}`,
                phone: `${rng.pick(PHONE_PREFIXES)}${rng.digits(7)}`,
                relationship,
              };
              families.push(f);
              return f;
            })();
      const born = addDays(`${yearStart - ageFor(level)}-09-01`, -rng.int(0, 364));
      const value: Partial<Record<FieldKey, string>> = {
        firstName: rng.pick(female ? GIRLS : BOYS),
        otherNames: rng.chance(0.3) ? rng.pick(female ? GIRLS : BOYS) : "",
        lastName: family.surname,
        sex: female ? "Female" : "Male",
        dateOfBirth: born,
        className: level,
        guardianName: family.guardian,
        guardianPhone: family.phone,
        guardianRelationship: family.relationship,
      };
      rows.push(IMPORT_FIELDS.map((f) => value[f.key] ?? ""));
    }
  }
  const headers = IMPORT_FIELDS.map((f) => f.label);
  const imported = await importStudents(app, proprietor, { headers, rows }, autoMapColumns(headers));
  if (imported.problems.length)
    throw new Error(`Import problems: ${JSON.stringify(imported.problems.slice(0, 3))}`);
  // The tables just grew by thousands of rows in one transaction. Autovacuum would analyze them within a
  // minute; the next query is now, and without statistics it took minutes for 2,000 students (5 ms with).
  await owner.execute(sql`analyze students, enrolments, student_guardians, guardians`);

  const roster = await asTenant(owner, tenantId, (tx) =>
    tx
      .select({
        id: students.id,
        firstName: students.firstName,
        sex: students.sex,
        lastName: students.lastName,
        classId: enrolments.classId,
        guardianId: guardians.id,
        guardianName: guardians.fullName,
        phone: guardians.phone,
      })
      .from(students)
      .innerJoin(enrolments, eq(enrolments.studentId, students.id))
      .innerJoin(
        studentGuardians,
        and(eq(studentGuardians.studentId, students.id), eq(studentGuardians.isPrimary, true)),
      )
      .innerJoin(guardians, eq(guardians.id, studentGuardians.guardianId))
      .where(and(eq(students.tenantId, tenantId), eq(enrolments.termId, term.id))),
  );
  const levelOfClass = new Map([...classIds].map(([level, id]) => [id, level]));
  // Most students joined in earlier years; a few joined this term.
  const newcomers = new Set<string>();
  await asTenant(owner, tenantId, async (tx) => {
    for (const s of roster) {
      const level = levelOfClass.get(s.classId)!;
      const joinsNow = rng.chance(0.06);
      if (joinsNow) newcomers.add(s.id);
      const admittedOn = joinsNow
        ? term.startsOn
        : addDays(`${yearStart - rng.int(1, Math.max(1, ageFor(level) - 3))}-09-08`, rng.int(0, 20));
      await tx.update(students).set({ admittedOn }).where(eq(students.id, s.id));
    }
  });
  // Where each student was last term: the same class, or a class lower in the year before (the youngest
  // class's children had not started).
  const previousClassOf = new Map<string, string>();
  for (const s of roster) {
    if (newcomers.has(s.id)) continue;
    const i = levelNames.indexOf(levelOfClass.get(s.classId)!);
    const cls = previous.sameYear ? s.classId : i > 0 ? classIds.get(levelNames[i - 1]!) : undefined;
    if (cls) previousClassOf.set(s.id, cls);
  }
  await asTenant(owner, tenantId, (tx) =>
    tx.insert(enrolments).values(
      [...previousClassOf].map(([studentId, classId]) => ({
        tenantId,
        studentId,
        termId: previous.id,
        classId,
      })),
    ),
  );
  log(`${roster.length} students in ${families.length} families (${previousClassOf.size} here last term).`);

  // 4. Fees: items, amounts per level, scholarships, balances from before, then billing.
  await setupFeeItems(app, bursar, {
    names: ["Tuition", "PTA dues", "Books and stationery", "Examination fees", "ICT"],
  });
  const items = await listFeeItems(app, bursar);
  for (const level of levelNames) {
    const amounts = Object.fromEntries(
      items.map((item) => [item.id, String(FEES[stageOf(level)][item.name] ?? "")]),
    );
    const levelId = levelRows.find((l) => l.name === level)!.id;
    await saveLevelFees(app, bursar, term.id, levelId, { amounts, classAmounts: {} });
    // Last term's fees were about 5% lower (rounded to whole cedis).
    const lastTerm = Object.fromEntries(
      items.map((item) => {
        const fee = FEES[stageOf(level)][item.name];
        return [item.id, fee === undefined ? "" : String(Math.round(fee * 0.95))];
      }),
    );
    await saveLevelFees(app, bursar, previous.id, levelId, { amounts: lastTerm, classAmounts: {} });
  }
  const tuition = items.find((i) => i.name === "Tuition")!;
  for (const s of roster.filter(() => rng.chance(0.04)))
    await addConcession(app, bursar, s.id, {
      label: "Academic scholarship",
      feeItemId: tuition.id,
      kind: "percent",
      value: "50",
    });
  // Balances brought forward from before EduBridge, dated the day before last term began.
  const openingDay = addDays(previous.startsOn, -1);
  for (const s of roster) {
    if (rng.chance(0.15))
      await setOpeningBalance(app, bursar, s.id, { amount: String(rng.int(15, 120) * 10), asOf: openingDay });
    else if (rng.chance(0.03))
      await setOpeningBalance(app, bursar, s.id, { amount: String(-rng.int(5, 20) * 10), asOf: openingDay });
  }

  // References are unique, as real ones are: the duplicate-reference check (FIN) stops a repeat.
  const usedReferences = new Set<string>();
  const uniqueReference = (make: () => string) => {
    let reference = make();
    while (usedReferences.has(reference)) reference = make();
    usedReferences.add(reference);
    return reference;
  };
  const pickMethod = (): PaymentMethod =>
    rng.chance(0.45) ? "mobile_money" : rng.chance(0.73) ? "cash" : "bank_deposit";
  const takePayment = (studentId: string, pesewas: number, paidOn: string, payer: string) => {
    const method = pickMethod();
    return recordPayment(app, bursar, {
      studentId,
      amount: pesewasToInput(pesewas),
      method,
      reference:
        method === "mobile_money"
          ? uniqueReference(() => `MP${rng.digits(10)}`)
          : method === "bank_deposit"
            ? uniqueReference(() => `SLIP-${rng.digits(6)}`)
            : "",
      payerName: payer,
      paidOn,
      idempotencyKey: randomUUID(),
    });
  };
  const balances = async () =>
    asTenant(
      owner,
      tenantId,
      async (tx) =>
        new Map(
          (
            await tx
              .select({
                studentId: ledgerEntries.studentId,
                balance: sql<string>`sum(${ledgerEntries.amountPesewas})`,
              })
              .from(ledgerEntries)
              .where(eq(ledgerEntries.tenantId, tenantId))
              .groupBy(ledgerEntries.studentId)
          ).map((r) => [r.studentId, Number(r.balance)]),
        ),
    );

  // Last term: billed, and mostly paid over the term (most families early), the rest carried forward.
  await billTerm(app, bursar, previous.id);
  const lastTermOwed = await balances();
  const lastTermDays = schoolDays(previous.startsOn, previous.endsOn);
  let lastTermPayments = 0;
  const lastTermPlan: { studentId: string; amount: number; paidOn: string; payer: string }[] = [];
  for (const s of roster) {
    const due = lastTermOwed.get(s.id) ?? 0;
    if (due <= 0 || !previousClassOf.has(s.id)) continue;
    const roll = rng.next();
    const early = () => lastTermDays[rng.int(0, Math.min(lastTermDays.length - 1, 14))]!;
    if (roll < 0.62)
      lastTermPlan.push({ studentId: s.id, amount: due, paidOn: early(), payer: s.guardianName });
    else if (roll < 0.88) {
      const first = Math.max(2000, Math.floor((due * rng.int(40, 60)) / 100 / 1000) * 1000);
      lastTermPlan.push({ studentId: s.id, amount: first, paidOn: early(), payer: s.guardianName });
      const rest = rng.chance(0.6) ? due - first : Math.floor((due - first) / 2 / 1000) * 1000;
      if (rest > 0)
        lastTermPlan.push({
          studentId: s.id,
          amount: rest,
          paidOn: rng.pick(lastTermDays),
          payer: s.guardianName,
        });
    } else if (roll < 0.95)
      lastTermPlan.push({
        studentId: s.id,
        amount: Math.max(2000, Math.floor((due * rng.int(20, 50)) / 100 / 1000) * 1000),
        paidOn: rng.pick(lastTermDays),
        payer: s.guardianName,
      });
  }
  lastTermPlan.sort((a, b) => a.paidOn.localeCompare(b.paidOn));
  for (const p of lastTermPlan) {
    await takePayment(p.studentId, p.amount, p.paidOn, p.payer);
    lastTermPayments++;
  }
  await owner.execute(sql`analyze ledger_entries, payments`);
  log(`Last term billed and ${lastTermPayments} payments taken.`);

  await billTerm(app, bursar, term.id);
  const owed = await balances();
  await owner.execute(sql`analyze ledger_entries`);
  log("Fees set and the term billed.");

  // 5. Payments and reminders over the term so far, in date order.
  const periodEnd = term.endsOn < today ? term.endsOn : today;
  const payDays = schoolDays(term.startsOn, periodEnd);
  const at = (share: number) => payDays[Math.min(payDays.length - 1, Math.floor(payDays.length * share))]!;
  const reminderDays = payDays.length >= 15 ? [at(0.4), at(0.75)] : payDays.length >= 6 ? [at(0.5)] : [];
  type Planned = { studentId: string; amount: number; paidOn: string; payer: string };
  const planned: Planned[] = [];
  const roundDown = (pesewas: number) => Math.max(2000, Math.floor(pesewas / 1000) * 1000);
  const afterReminder = new Set<string>();
  for (const s of roster) {
    const due = owed.get(s.id) ?? 0;
    if (due <= 0 || payDays.length === 0) continue;
    const pay = (amount: number, paidOn: string) =>
      planned.push({ studentId: s.id, amount, paidOn, payer: s.guardianName });
    const early = () => payDays[rng.int(0, Math.min(payDays.length - 1, 9))]!;
    const any = () => rng.pick(payDays);
    const roll = rng.next() + (due > 200_000 ? 0.12 : 0);
    if (roll < 0.3) pay(due, early());
    else if (roll < 0.6) {
      const parts = rng.int(2, 3);
      const share = rng.int(50, 100) / 100;
      let left = Math.round(due * share);
      const dates = Array.from({ length: parts }, any).sort();
      dates.forEach((date, i) => {
        const amount = i === parts - 1 ? left : Math.min(left, roundDown(left / (parts - i)));
        if (amount > 0) pay(amount, date);
        left -= amount;
      });
    } else if (roll < 0.75 && reminderDays.length > 0) {
      afterReminder.add(s.id);
      const after = payDays.filter((d) => d > reminderDays[0]! && d <= addDays(reminderDays[0]!, 6));
      if (after.length > 0)
        pay(rng.chance(0.5) ? due : roundDown((due * rng.int(40, 80)) / 100), rng.pick(after));
    } else if (roll < 0.85) pay(roundDown((due * rng.int(20, 40)) / 100), any());
  }
  planned.sort((a, b) => a.paidOn.localeCompare(b.paidOn));

  const phoneOf = new Map(roster.map((s) => [s.id, s]));
  const reminders: { studentId: string; sentOn: string; balance: number }[] = [];
  for (const day of reminderDays) {
    for (const s of roster) {
      const paid = planned
        .filter((p) => p.studentId === s.id && p.paidOn < day)
        .reduce((a, p) => a + p.amount, 0);
      const balance = (owed.get(s.id) ?? 0) - paid;
      if (balance > 0 && s.phone) reminders.push({ studentId: s.id, sentOn: day, balance });
    }
  }
  if (reminders.length)
    await asTenant(owner, tenantId, (tx) =>
      tx.insert(feeReminders).values(
        reminders.map((r) => ({
          tenantId,
          studentId: r.studentId,
          guardianId: phoneOf.get(r.studentId)!.guardianId,
          channel: "sms" as const,
          recipient: phoneOf.get(r.studentId)!.phone!,
          sentOn: r.sentOn,
          balancePesewas: r.balance,
          sentByUserId: bursarPerson.userId,
        })),
      ),
    );

  for (const p of planned) await takePayment(p.studentId, p.amount, p.paidOn, p.payer);
  // A few families who still owe the most agree instalment plans, starting next week.
  const paidBy = new Map<string, number>();
  for (const p of planned) paidBy.set(p.studentId, (paidBy.get(p.studentId) ?? 0) + p.amount);
  const biggest = roster
    .map((s) => ({ id: s.id, left: (owed.get(s.id) ?? 0) - (paidBy.get(s.id) ?? 0) }))
    .filter((s) => s.left >= 50_000)
    .sort((a, b) => b.left - a.left)
    .slice(0, 4);
  for (const s of biggest)
    await createPaymentPlan(app, bursar, s.id, {
      total: pesewasToInput(s.left),
      count: "3",
      firstDueOn: addDays(today, 7),
      frequency: "monthly",
    });
  await owner.execute(sql`analyze ledger_entries, payments`);
  log(`${planned.length} payments, ${reminders.length} reminders, ${biggest.length} payment plans.`);

  // 6. Daily registers up to yesterday (today's is left for trying it out).
  const registerDays = schoolDays(
    term.startsOn,
    term.endsOn < addDays(today, -1) ? term.endsOn : addDays(today, -1),
  );
  const attendance = new Map(
    roster.map((s) => [
      s.id,
      rng.chance(0.03)
        ? rng.int(65, 80) / 100
        : rng.chance(0.07)
          ? rng.int(85, 93) / 100
          : rng.int(94, 100) / 100,
    ]),
  );
  let registers = 0;
  const takeRegisters = async (
    days: string[],
    classOf: (s: (typeof roster)[number]) => string | undefined,
    rate: (s: (typeof roster)[number]) => number,
  ) => {
    for (const [level, classId] of classIds) {
      const pupils = roster.filter((s) => classOf(s) === classId);
      if (pupils.length === 0) continue;
      for (const date of days) {
        await syncRegister(app, head, {
          classId,
          date,
          source: "online",
          marks: pupils.map((s) => {
            const status: AttendanceStatus =
              rng.next() < rate(s)
                ? rng.chance(0.04)
                  ? "late"
                  : "present"
                : rng.chance(0.25)
                  ? "excused"
                  : "absent";
            const away = status === "absent" || status === "excused";
            return {
              studentId: s.id,
              status,
              reason: away && rng.chance(0.6) ? rng.pick(ABSENCE_REASONS) : null,
              baseVersion: 0,
            };
          }),
        });
        registers++;
      }
      log(`Registers for ${level}: ${days.length} days.`);
    }
  };
  // Last term first (attendance a little better then), then this term.
  await takeRegisters(
    schoolDays(previous.startsOn, previous.endsOn),
    (s) => previousClassOf.get(s.id),
    (s) => Math.min(1, attendance.get(s.id)! + 0.03),
  );
  const lastTermRegisters = registers;
  await takeRegisters(
    registerDays,
    (s) => s.classId,
    (s) => attendance.get(s.id)!,
  );

  // 7. Subjects and marks: class scores everywhere, exams in a few classes, one class published.
  await setupDefaultSubjects(app, proprietor);
  const examLevels = new Set([featuredLevel, ...levelNames.filter((l) => ["Basic 6", "JHS 2"].includes(l))]);
  const ability = new Map(roster.map((s) => [s.id, Math.min(97, Math.max(28, rng.normal(63, 13)))]));
  const totals = new Map<string, number[]>();
  // A few students did clearly better last term, so the early-warning "average down" rule has real cases.
  const slipped = new Set(roster.filter(() => rng.chance(0.05)).map((s) => s.id));
  const enterMarks = async (termId: string, lastTerm: boolean) => {
    for (const [level, classId] of classIds) {
      const levelId = levelRows.find((l) => l.name === level)!.id;
      const subjectIds = await asTenant(owner, tenantId, async (tx) =>
        (
          await tx
            .select({ id: levelSubjects.subjectId })
            .from(levelSubjects)
            .innerJoin(levels, eq(levels.id, levelSubjects.levelId))
            .where(and(eq(levelSubjects.tenantId, tenantId), eq(levelSubjects.levelId, levelId)))
        ).map((r) => r.id),
      );
      for (const subjectId of subjectIds) {
        const sheet = (await getScoreSheet(app, proprietor, termId, classId, subjectId))!;
        if (sheet.students.length === 0) continue;
        const cells = sheet.students.flatMap((s) => {
          const base = ability.get(s.id)! + (lastTerm && slipped.has(s.id) ? 15 : 0);
          const mark = Math.min(99, Math.max(10, base + rng.normal(0, 9)));
          if (!lastTerm) totals.set(s.id, (totals.get(s.id) ?? []).concat(mark));
          return sheet.components
            .filter((c) => lastTerm || c.key !== "exam" || examLevels.has(level))
            .map((c) => ({
              studentId: s.id,
              key: c.key,
              original: "",
              value: String(
                Math.min(c.outOf, Math.max(0, Math.round(((mark + rng.normal(0, 5)) * c.outOf) / 100))),
              ),
            }));
        });
        await saveScores(app, proprietor, termId, classId, subjectId, { cells });
      }
    }
  };
  // Last term is complete: every class sat its exams.
  await enterMarks(previous.id, true);
  await enterMarks(term.id, false);
  const featuredClass = classIds.get(featuredLevel)!;
  for (const s of roster.filter((r) => r.classId === featuredClass)) {
    const marks = totals.get(s.id) ?? [];
    const average = marks.reduce((a, b) => a + b, 0) / Math.max(1, marks.length);
    await saveReportRemarks(app, head, term.id, featuredClass, s.id, {
      attitude: rng.pick(ATTITUDES),
      conduct: rng.pick(CONDUCT),
      interest: rng.pick(INTERESTS),
      classTeacherRemark: classTeacherRemark(average),
      headTeacherRemark: headTeacherRemark(average),
      daysPresent: "",
      daysOpen: "",
    });
  }
  await publishReportCards(app, head, term.id, featuredClass);
  log(`Marks entered; ${featuredLevel} report cards published.`);

  // 8. Every other module: staff, payroll, safeguarding, visitors, transport, inventory, library, boarding,
  // timetable, announcements, events, admissions, early-warning reviews and the finance checks.
  const extra = await generateModuleData({
    owner,
    app,
    tenantId,
    rng,
    today,
    isSchoolDay,
    term,
    campusId: campus.id,
    roster: roster.map((s) => ({ ...s, sex: s.sex === "male" ? "male" : "female" })),
    classIds,
    levelIdOf: (level) => levelRows.find((l) => l.name === level)!.id,
    featuredClass,
    people: {
      proprietor: ownerPerson,
      head: headPerson,
      admin: adminPerson,
      bursar: bursarPerson,
      teachers: teacherPeople,
    },
    ctxOf,
    saveLevelFeesWith: async (level, extra) => {
      const amounts = Object.fromEntries(
        items.map((item) => [item.id, String(FEES[stageOf(level)][item.name] ?? "")]),
      );
      await saveLevelFees(app, bursar, term.id, levelRows.find((l) => l.name === level)!.id, {
        amounts: { ...amounts, ...extra },
        classAmounts: {},
      });
    },
    asTenant: (fn) => asTenant(owner, tenantId, fn),
    log,
  });

  // The school's own money: accounts, expenses, cash taken to the bank and the bank's statement.
  await generateDemoFinance({
    app,
    proprietor: await ctxOf(ownerPerson.userId),
    bursar: await ctxOf(bursarPerson.userId),
    rng,
    today,
    termStart: term.startsOn,
    log,
  });

  return {
    tenantId,
    slug: options.slug,
    accounts,
    students: roster.length,
    // This term: the receipts that count (not voided), and this term's registers.
    payments: planned.length + extra.paymentsAdded - extra.paymentsVoided,
    registers: registers - lastTermRegisters,
    reminders: reminders.length,
    publishedClass: featuredLevel,
  };
}
