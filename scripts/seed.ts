/**
 * Seeds synthetic development data. Every person, school and email here is fictional.
 * Usage: npm run db:seed   (uses MIGRATION_DATABASE_URL; refuses to run in production)
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { hashPassword } from "../src/server/auth/password";
import { planBilling } from "../src/server/fees/billing-plan";
import { seal } from "../src/server/auth/secret-box";
import type { Role } from "../src/server/authz/permissions";
import {
  academicYears,
  campuses,
  classes,
  enrolments,
  feeItems,
  feeStructureLines,
  ledgerEntries,
  payments,
  tenantCounters,
  guardians,
  levels,
  loginAttempts,
  memberships,
  platformAdmins,
  studentGuardians,
  students,
  tenantEntitlements,
  tenants,
  terms,
  userMfa,
  users,
} from "../src/server/db/schema";

export const DEV_PASSWORD = "edubridge-dev-only";
/** Authenticator secret for platform@example.test in development only. */
export const DEV_PLATFORM_TOTP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
/** Kpone Ridge requires two-step verification for accountants. Dev-only, published secret (see README). */
export const DEV_ACCOUNTANT_TOTP_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

const SCHOOLS = [
  {
    slug: "kpone-ridge",
    name: "Kpone Ridge International School",
    maxCampuses: 3,
    campuses: ["Main campus", "Sakumono"],
  },
  // Adenta Hall shows the configurable policy: no roles must use two-step verification.
  {
    slug: "adenta-hall",
    name: "Adenta Hall Academy",
    maxCampuses: 1,
    campuses: ["Main campus"],
    mfaRequiredRoles: [] as string[],
  },
];

const PLATFORM_ADMIN = { email: "platform@example.test", name: "Selorm Agbeko" };

const PEOPLE: { email: string; name: string; access: Record<string, Role[]> }[] = [
  {
    email: "owner@example.test",
    name: "Efua Mensah-Larbi",
    access: { "kpone-ridge": ["owner"], "adenta-hall": ["owner"] },
  },
  { email: "head@example.test", name: "Comfort Adjei", access: { "kpone-ridge": ["headteacher"] } },
  { email: "admin@example.test", name: "Kwabena Ofori", access: { "kpone-ridge": ["admin"] } },
  { email: "bursar@example.test", name: "Akosua Darko", access: { "kpone-ridge": ["bursar"] } },
  {
    email: "teacher@example.test",
    name: "Yaw Boateng",
    access: { "kpone-ridge": ["teacher"], "adenta-hall": ["teacher"] },
  },
  { email: "parent@example.test", name: "Abena Owusu", access: { "kpone-ridge": ["parent"] } },
  { email: "student@example.test", name: "Kojo Asante", access: { "kpone-ridge": ["student"] } },
];

async function main() {
  if (process.env.NODE_ENV === "production") throw new Error("Refusing to seed a production environment.");
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error("MIGRATION_DATABASE_URL is not set.");
  const pool = new Pool({ connectionString: url, max: 1 });
  const db = drizzle(pool);
  const passwordHash = await hashPassword(DEV_PASSWORD);

  try {
    const [platformAdmin] = await db
      .insert(users)
      .values({ ...PLATFORM_ADMIN, passwordHash })
      .onConflictDoUpdate({ target: users.email, set: { name: PLATFORM_ADMIN.name, passwordHash } })
      .returning({ id: users.id });
    await db.insert(platformAdmins).values({ userId: platformAdmin!.id }).onConflictDoNothing();
    // Platform administrators must use two-step verification. Dev-only, published secret (see README).
    const sealed = seal(DEV_PLATFORM_TOTP_SECRET);
    await db
      .insert(userMfa)
      .values({ userId: platformAdmin!.id, secretSealed: sealed, enabledAt: new Date() })
      .onConflictDoUpdate({
        target: userMfa.userId,
        set: { secretSealed: sealed, enabledAt: new Date(), lastUsedStep: null },
      });

    const tenantIds = new Map<string, string>();
    for (const school of SCHOOLS) {
      const [row] = await db
        .insert(tenants)
        .values({ slug: school.slug, name: school.name, mfaRequiredRoles: school.mfaRequiredRoles })
        .onConflictDoUpdate({
          target: tenants.slug,
          set: { name: school.name, mfaRequiredRoles: school.mfaRequiredRoles ?? ["owner", "bursar"] },
        })
        .returning({ id: tenants.id });
      const tenantId = row!.id;
      tenantIds.set(school.slug, tenantId);
      // Plan limits may only be written as a platform administrator (enforced by row-level security).
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('app.tenant_id', ${tenantId}, true), set_config('app.user_id', ${platformAdmin!.id}, true)`,
        );
        await tx
          .insert(tenantEntitlements)
          .values({ tenantId, planName: "Pilot", maxCampuses: school.maxCampuses })
          .onConflictDoUpdate({
            target: tenantEntitlements.tenantId,
            set: { maxCampuses: school.maxCampuses },
          });
        for (const name of school.campuses) {
          await tx.insert(campuses).values({ tenantId, name }).onConflictDoNothing();
        }
      });
    }

    for (const person of PEOPLE) {
      const [user] = await db
        .insert(users)
        .values({ email: person.email, name: person.name, passwordHash })
        .onConflictDoUpdate({ target: users.email, set: { name: person.name, passwordHash } })
        .returning({ id: users.id });
      if (person.email === "bursar@example.test") {
        const sealedSecret = seal(DEV_ACCOUNTANT_TOTP_SECRET);
        await db
          .insert(userMfa)
          .values({ userId: user!.id, secretSealed: sealedSecret, enabledAt: new Date() })
          .onConflictDoUpdate({
            target: userMfa.userId,
            set: { secretSealed: sealedSecret, enabledAt: new Date(), lastUsedStep: null },
          });
      }
      for (const [slug, roles] of Object.entries(person.access)) {
        const tenantId = tenantIds.get(slug)!;
        await db.transaction(async (tx) => {
          await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
          await tx
            .insert(memberships)
            .values({ tenantId, userId: user!.id, roles })
            .onConflictDoUpdate({
              target: [memberships.tenantId, memberships.userId],
              set: { roles, status: "active" },
            });
        });
      }
    }
    // Kpone Ridge has a calendar with a current term; Adenta Hall starts empty (shows the setup state).
    const kpone = tenantIds.get("kpone-ridge")!;
    await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', ${kpone}, true)`);
      const [year] = await tx
        .insert(academicYears)
        .values({ tenantId: kpone, name: "2026/2027", startsOn: "2026-09-08", endsOn: "2027-07-30" })
        .onConflictDoNothing()
        .returning({ id: academicYears.id });
      if (year) {
        await tx.insert(terms).values([
          {
            tenantId: kpone,
            academicYearId: year.id,
            name: "Term 1",
            sequence: 1,
            startsOn: "2026-09-08",
            endsOn: "2026-12-18",
            isCurrent: true,
          },
          {
            tenantId: kpone,
            academicYearId: year.id,
            name: "Term 2",
            sequence: 2,
            startsOn: "2027-01-11",
            endsOn: "2027-04-09",
          },
          {
            tenantId: kpone,
            academicYearId: year.id,
            name: "Term 3",
            sequence: 3,
            startsOn: "2027-05-03",
            endsOn: "2027-07-30",
          },
        ]);
      }
    });

    // Kpone Ridge: Ghanaian default levels and a few classes. Adenta Hall has none (shows the setup state).
    await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', ${kpone}, true)`);
      const [existingLevel] = await tx
        .select({ id: levels.id })
        .from(levels)
        .where(eq(levels.tenantId, kpone))
        .limit(1);
      if (existingLevel) return;
      const names: [string, "creche" | "nursery" | "kindergarten" | "primary" | "jhs"][] = [
        ["Creche", "creche"],
        ["Nursery 1", "nursery"],
        ["Nursery 2", "nursery"],
        ["KG 1", "kindergarten"],
        ["KG 2", "kindergarten"],
        ["Basic 1", "primary"],
        ["Basic 2", "primary"],
        ["Basic 3", "primary"],
        ["Basic 4", "primary"],
        ["Basic 5", "primary"],
        ["Basic 6", "primary"],
        ["JHS 1", "jhs"],
        ["JHS 2", "jhs"],
        ["JHS 3", "jhs"],
      ];
      const created = await tx
        .insert(levels)
        .values(names.map(([name, stage], i) => ({ tenantId: kpone, name, stage, sequence: (i + 1) * 10 })))
        .returning({ id: levels.id, name: levels.name });
      const levelId = (name: string) => created.find((l) => l.name === name)!.id;
      const campusRows = await tx
        .select({ id: campuses.id, name: campuses.name })
        .from(campuses)
        .where(eq(campuses.tenantId, kpone));
      const main = campusRows.find((c) => c.name === "Main campus")!.id;
      const sakumono = campusRows.find((c) => c.name === "Sakumono")!.id;
      const [teacher] = await tx
        .select({ id: memberships.id })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(and(eq(memberships.tenantId, kpone), eq(users.email, "teacher@example.test")));
      await tx.insert(classes).values([
        { tenantId: kpone, levelId: levelId("KG 1"), campusId: main, name: "KG 1" },
        {
          tenantId: kpone,
          levelId: levelId("Basic 4"),
          campusId: main,
          name: "Basic 4A",
          classTeacherMembershipId: teacher?.id ?? null,
        },
        { tenantId: kpone, levelId: levelId("Basic 4"), campusId: main, name: "Basic 4B" },
        { tenantId: kpone, levelId: levelId("JHS 1"), campusId: main, name: "JHS 1" },
        { tenantId: kpone, levelId: levelId("Basic 1"), campusId: sakumono, name: "Basic 1 Sakumono" },
      ]);
    });

    // Synthetic students (fictional names) in Kpone Ridge classes for the current term.
    await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', ${kpone}, true)`);
      const [term] = await tx
        .select({ id: terms.id })
        .from(terms)
        .where(and(eq(terms.tenantId, kpone), eq(terms.isCurrent, true)));
      const classRows = await tx
        .select({ id: classes.id, name: classes.name })
        .from(classes)
        .where(eq(classes.tenantId, kpone));
      const classId = (name: string) => classRows.find((c) => c.name === name)!.id;
      const roster: [string, string, string, "female" | "male", string, string][] = [
        ["S0001", "Akua", "Owusu", "female", "2017-02-11", "Basic 4A"],
        ["S0002", "Kwame", "Mensah", "male", "2016-11-03", "Basic 4A"],
        ["S0003", "Esi", "Quaye", "female", "2017-05-21", "Basic 4A"],
        ["S0004", "Yaw", "Darko", "male", "2017-01-30", "Basic 4A"],
        ["S0005", "Abena", "Asante", "female", "2016-09-14", "Basic 4A"],
        ["S0006", "Kojo", "Addo", "male", "2017-03-08", "Basic 4B"],
        ["S0007", "Adwoa", "Boateng", "female", "2017-07-19", "Basic 4B"],
        ["S0008", "Fiifi", "Annan", "male", "2014-04-02", "JHS 1"],
        ["S0009", "Efua", "Ofori", "female", "2014-08-25", "JHS 1"],
        ["S0010", "Nana", "Agyeman", "male", "2021-06-12", "KG 1"],
        ["S0011", "Afia", "Sarpong", "female", "2020-12-01", "Basic 1 Sakumono"],
        ["S0012", "Kweku", "Amponsah", "male", "2020-10-17", "Basic 1 Sakumono"],
      ];
      // Seeded students use an "S" prefix so they never collide with numbers assigned during testing.
      for (const [admissionNumber, firstName, lastName, sex, dateOfBirth, className] of roster) {
        const [student] = await tx
          .insert(students)
          .values({
            tenantId: kpone,
            admissionNumber,
            firstName,
            lastName,
            sex,
            dateOfBirth,
            admittedOn: "2026-09-08",
          })
          .onConflictDoNothing()
          .returning({ id: students.id });
        if (student && term) {
          await tx
            .insert(enrolments)
            .values({ tenantId: kpone, studentId: student.id, termId: term.id, classId: classId(className) });
        }
      }
    });

    // Guardians (fictional). Kwame Mensah and Efua Ofori share a guardian, so they show as siblings.
    await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', ${kpone}, true)`);
      const people: [string, string, string, "mother" | "father" | "guardian"][] = [
        ["S0001", "Akosua Owusu", "+233245550101", "mother"],
        ["S0002", "Grace Mensah", "+233545550122", "mother"],
        ["S0009", "Grace Mensah", "+233545550122", "guardian"],
        ["S0010", "Kofi Agyeman", "+233205550111", "father"],
        ["S0006", "Adjoa Addo", "+233275550133", "mother"],
      ];
      for (const [admissionNumber, fullName, phone, relationship] of people) {
        const [student] = await tx
          .select({ id: students.id })
          .from(students)
          .where(and(eq(students.tenantId, kpone), eq(students.admissionNumber, admissionNumber)));
        if (!student) continue;
        await tx.insert(guardians).values({ tenantId: kpone, fullName, phone }).onConflictDoNothing();
        const [guardian] = await tx
          .select({ id: guardians.id })
          .from(guardians)
          .where(and(eq(guardians.tenantId, kpone), eq(guardians.phone, phone)));
        await tx
          .insert(studentGuardians)
          .values({
            tenantId: kpone,
            studentId: student.id,
            guardianId: guardian!.id,
            relationship,
            isPrimary: true,
          })
          .onConflictDoNothing();
      }
    });

    // Kpone Ridge fees for the current term (synthetic amounts). Later terms are left empty to show copying.
    await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', ${kpone}, true)`);
      const [existingItem] = await tx
        .select({ id: feeItems.id })
        .from(feeItems)
        .where(eq(feeItems.tenantId, kpone));
      const [term] = await tx
        .select({ id: terms.id })
        .from(terms)
        .where(and(eq(terms.tenantId, kpone), eq(terms.isCurrent, true)));
      if (existingItem || !term) return;
      const items = await tx
        .insert(feeItems)
        .values(
          ["Tuition", "PTA dues", "Books and stationery", "ICT"].map((name, i) => ({
            tenantId: kpone,
            name,
            sequence: (i + 1) * 10,
          })),
        )
        .returning({ id: feeItems.id, name: feeItems.name });
      const item = (name: string) => items.find((i) => i.name === name)!.id;
      // Pesewas per stage: tuition, PTA dues, books, ICT (0 = not charged).
      const amounts: Record<string, [number, number, number, number]> = {
        creche: [65000, 5000, 12000, 0],
        nursery: [65000, 5000, 12000, 0],
        kindergarten: [65000, 5000, 12000, 0],
        primary: [85000, 5000, 18000, 6000],
        jhs: [110000, 5000, 24000, 8000],
      };
      const levelRows = await tx
        .select({ id: levels.id, stage: levels.stage })
        .from(levels)
        .where(eq(levels.tenantId, kpone));
      const names = ["Tuition", "PTA dues", "Books and stationery", "ICT"];
      await tx.insert(feeStructureLines).values(
        levelRows.flatMap((level) =>
          amounts[level.stage]!.flatMap((amountPesewas, i) =>
            amountPesewas > 0
              ? [
                  {
                    tenantId: kpone,
                    termId: term.id,
                    levelId: level.id,
                    feeItemId: item(names[i]!),
                    amountPesewas,
                  },
                ]
              : [],
          ),
        ),
      );
    });

    // Bill Kpone Ridge students for the current term.
    await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', ${kpone}, true)`);
      const [term] = await tx
        .select({ id: terms.id, name: terms.name, startsOn: terms.startsOn })
        .from(terms)
        .where(and(eq(terms.tenantId, kpone), eq(terms.isCurrent, true)));
      if (!term) return;
      const [billed] = await tx
        .select({ id: ledgerEntries.id })
        .from(ledgerEntries)
        .where(and(eq(ledgerEntries.tenantId, kpone), eq(ledgerEntries.termId, term.id)))
        .limit(1);
      if (billed) return;
      const enrolled = await tx
        .select({ studentId: enrolments.studentId, classId: enrolments.classId, levelId: classes.levelId })
        .from(enrolments)
        .innerJoin(classes, eq(classes.id, enrolments.classId))
        .innerJoin(students, eq(students.id, enrolments.studentId))
        .where(eq(enrolments.termId, term.id));
      const lines = await tx.select().from(feeStructureLines).where(eq(feeStructureLines.termId, term.id));
      const items = await tx.select().from(feeItems).where(eq(feeItems.tenantId, kpone));
      const plan = planBilling(
        term.id,
        enrolled,
        lines,
        items.map((i) => i.id),
        [],
      );
      if (plan.toCreate.length === 0) return;
      await tx.insert(ledgerEntries).values(
        plan.toCreate.map((c) => ({
          tenantId: kpone,
          studentId: c.studentId,
          termId: term.id,
          kind: "charge" as const,
          feeItemId: c.feeItemId,
          description: `${items.find((i) => i.id === c.feeItemId)!.name}, ${term.name} 2026/2027`,
          amountPesewas: c.amountPesewas,
          billingKey: c.billingKey,
          effectiveOn: term.startsOn,
        })),
      );
    });

    // A few synthetic payments, so accounts show part payments, paid-up and owing students.
    await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', ${kpone}, true)`);
      const [existing] = await tx
        .select({ id: payments.id })
        .from(payments)
        .where(eq(payments.tenantId, kpone))
        .limit(1);
      const [term] = await tx
        .select({ id: terms.id })
        .from(terms)
        .where(and(eq(terms.tenantId, kpone), eq(terms.isCurrent, true)));
      if (existing || !term) return;
      const received: [
        string,
        number,
        "cash" | "mobile_money" | "bank_deposit",
        string | null,
        string,
        string,
      ][] = [
        ["S0001", 60000, "cash", null, "2026-09-09", "Akosua Owusu"],
        ["S0002", 114000, "mobile_money", "MM260910.0931.C11427", "2026-09-10", "Grace Mensah"],
        ["S0005", 30000, "bank_deposit", "GCB-448120", "2026-09-14", "Kwasi Asante"],
        ["S0008", 147000, "cash", null, "2026-09-15", "Ato Annan"],
      ];
      const labels = { cash: "Cash", mobile_money: "Mobile Money", bank_deposit: "Bank deposit" };
      const [accountant] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, "bursar@example.test"));
      let n = 0;
      for (const [admissionNumber, amountPesewas, method, reference, paidOn, payerName] of received) {
        const [student] = await tx
          .select({ id: students.id })
          .from(students)
          .where(and(eq(students.tenantId, kpone), eq(students.admissionNumber, admissionNumber)));
        if (!student) continue;
        const receiptNumber = `R${String(++n).padStart(6, "0")}`;
        const [payment] = await tx
          .insert(payments)
          .values({
            tenantId: kpone,
            studentId: student.id,
            receiptNumber,
            amountPesewas,
            method,
            reference,
            payerName,
            paidOn,
            idempotencyKey: `seed-${receiptNumber}`,
            recordedByUserId: accountant?.id ?? null,
          })
          .returning({ id: payments.id });
        await tx.insert(ledgerEntries).values({
          tenantId: kpone,
          studentId: student.id,
          termId: term.id,
          kind: "payment",
          description: `Payment, receipt ${receiptNumber} (${labels[method]})`,
          amountPesewas: -amountPesewas,
          paymentId: payment!.id,
          effectiveOn: paidOn,
          recordedByUserId: accountant?.id ?? null,
        });
      }
      await tx
        .insert(tenantCounters)
        .values({ tenantId: kpone, key: "receipt_number", value: n })
        .onConflictDoUpdate({ target: [tenantCounters.tenantId, tenantCounters.key], set: { value: n } });
    });

    // Clear sign-in throttling for the synthetic accounts so local runs start clean.
    await db
      .delete(loginAttempts)
      .where(inArray(loginAttempts.email, [PLATFORM_ADMIN.email, ...PEOPLE.map((p) => p.email)]));
    console.log(
      `Seeded ${SCHOOLS.length} schools, ${PEOPLE.length} school users and ${PLATFORM_ADMIN.email}. Password for all: ${DEV_PASSWORD}`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
