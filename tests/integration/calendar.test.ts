import { afterAll, describe, expect, it } from "vitest";
import { ForbiddenError } from "@/server/authz/permissions";
import {
  createAcademicYear,
  getCurrentTerm,
  listAcademicYears,
  setCurrentTerm,
  suggestedYear,
  updateTerm,
} from "@/server/academics/calendar";
import { resolveTenantContext, type TenantContext } from "@/server/tenancy/service";
import { addMember, connect, createTenant, createUser } from "../support/fixtures";

const conn = connect();
afterAll(() => conn.close());

async function school() {
  const tenant = await createTenant(conn.owner);
  const head = await createUser(conn.owner);
  const teacher = await createUser(conn.owner);
  await addMember(conn.owner, tenant.id, head.id, ["headteacher"]);
  await addMember(conn.owner, tenant.id, teacher.id, ["teacher"]);
  return {
    head: (await resolveTenantContext(conn.app, tenant.slug, head.id)) as TenantContext,
    teacher: (await resolveTenantContext(conn.app, tenant.slug, teacher.id)) as TenantContext,
  };
}

const year2026 = {
  name: "2026/2027",
  terms: [
    { name: "Term 1", startsOn: "2026-09-08", endsOn: "2026-12-18" },
    { name: "Term 2", startsOn: "2027-01-11", endsOn: "2027-04-09" },
    { name: "Term 3", startsOn: "2027-05-03", endsOn: "2027-07-30" },
  ],
};

describe("academic calendar", () => {
  it("creates a year with three terms and derives the year's span", async () => {
    const { head } = await school();
    await createAcademicYear(conn.app, head, year2026);
    const [year] = await listAcademicYears(conn.app, head);
    expect(year).toMatchObject({ name: "2026/2027", startsOn: "2026-09-08", endsOn: "2027-07-30" });
    expect(year!.terms.map((t) => [t.sequence, t.name])).toEqual([
      [1, "Term 1"],
      [2, "Term 2"],
      [3, "Term 3"],
    ]);
  });

  it("validates names, dates and order", async () => {
    const { head } = await school();
    await expect(createAcademicYear(conn.app, head, { ...year2026, name: "2026-27" })).rejects.toThrow();
    await expect(createAcademicYear(conn.app, head, { ...year2026, name: "2026/2028" })).rejects.toThrow();
    const reversed = { ...year2026, terms: [year2026.terms[1]!, year2026.terms[0]!] };
    await expect(createAcademicYear(conn.app, head, reversed)).rejects.toThrow();
    const backwards = {
      ...year2026,
      terms: [{ name: "Term 1", startsOn: "2026-12-18", endsOn: "2026-09-08" }],
    };
    await expect(createAcademicYear(conn.app, head, backwards)).rejects.toThrow();
  });

  it("refuses overlapping years and duplicate names (database constraints)", async () => {
    const { head } = await school();
    await createAcademicYear(conn.app, head, year2026);
    await expect(
      createAcademicYear(conn.app, head, {
        name: "2027/2028",
        terms: [{ name: "Term 1", startsOn: "2027-07-01", endsOn: "2027-12-01" }],
      }),
    ).rejects.toMatchObject({ code: "calendar_overlap" });
    await expect(
      createAcademicYear(conn.app, head, {
        name: "2026/2027",
        terms: [{ name: "Term 1", startsOn: "2030-01-01", endsOn: "2030-03-01" }],
      }),
    ).rejects.toMatchObject({ code: "calendar_duplicate" });
  });

  it("lets other schools use the same dates", async () => {
    const a = await school();
    const b = await school();
    await createAcademicYear(conn.app, a.head, year2026);
    await expect(createAcademicYear(conn.app, b.head, year2026)).resolves.toBeTruthy();
    expect(await listAcademicYears(conn.app, b.head)).toHaveLength(1);
  });

  it("keeps exactly one current term", async () => {
    const { head } = await school();
    await createAcademicYear(conn.app, head, year2026);
    const [year] = await listAcademicYears(conn.app, head);
    expect(await getCurrentTerm(conn.app, head)).toBeNull();
    await setCurrentTerm(conn.app, head, year!.terms[0]!.id);
    await setCurrentTerm(conn.app, head, year!.terms[1]!.id);
    const current = await getCurrentTerm(conn.app, head);
    expect(current).toMatchObject({ name: "Term 2", yearName: "2026/2027" });
    const after = (await listAcademicYears(conn.app, head))[0]!.terms.filter((t) => t.isCurrent);
    expect(after).toHaveLength(1);
  });

  it("updates term dates, keeps terms in order and refreshes the year span", async () => {
    const { head } = await school();
    await createAcademicYear(conn.app, head, year2026);
    const [year] = await listAcademicYears(conn.app, head);
    const [t1, , t3] = year!.terms;
    await updateTerm(conn.app, head, t3!.id, {
      name: "Term 3",
      startsOn: "2027-05-03",
      endsOn: "2027-08-06",
    });
    expect((await listAcademicYears(conn.app, head))[0]!.endsOn).toBe("2027-08-06");
    await expect(
      updateTerm(conn.app, head, t1!.id, { name: "Term 1", startsOn: "2026-09-08", endsOn: "2027-02-01" }),
    ).rejects.toMatchObject({
      code: "calendar_overlap",
    });
  });

  it("only lets proprietors, head teachers and administrators manage the calendar", async () => {
    const { teacher } = await school();
    await expect(createAcademicYear(conn.app, teacher, year2026)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("suggests the school year that contains a date", () => {
    expect(suggestedYear(new Date("2026-10-31")).name).toBe("2026/2027");
    expect(suggestedYear(new Date("2027-03-01")).name).toBe("2026/2027");
  });
});
