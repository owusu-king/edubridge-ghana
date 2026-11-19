import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { allowed, ForbiddenError } from "@/server/authz/permissions";
import { withTenant } from "@/server/db/context";
import {
  auditEvents,
  memberships,
  safeguardingAccess,
  safeguardingCases,
  safeguardingDocuments,
  safeguardingEntries,
} from "@/server/db/schema";
import {
  addCaseEntry,
  appointLead,
  assignCaseLead,
  downloadCaseDocument,
  endLead,
  getCase,
  listCases,
  listLeads,
  listMyReports,
  listReportableStudents,
  markActionDone,
  reportConcern,
  setCaseStatus,
  uploadCaseDocument,
} from "@/server/safeguarding/service";
import { resolveTenantContext, type TenantContext } from "@/server/tenancy/service";
import { conn, school as baseSchool, type School } from "../support/mobile-money";

afterAll(() => conn.close());

const PDF = Buffer.from("%PDF-1.4\n% synthetic safeguarding note\n");

const membershipOf = async (s: School, userId: string) => {
  const [m] = await withTenant(conn.owner, { tenantId: s.tenant.id, userId }, (tx) =>
    tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.tenantId, s.tenant.id), eq(memberships.userId, userId))),
  );
  return m!.id;
};

const fresh = async (s: School, ctx: TenantContext) =>
  (await resolveTenantContext(conn.app, s.tenant.slug, ctx.userId)) as TenantContext;

/** Rows a user can read directly from the database, bypassing every service check. */
const rawCases = (s: School, userId: string) =>
  withTenant(conn.app, { tenantId: s.tenant.id, userId }, (tx) =>
    tx
      .select({ id: safeguardingCases.id })
      .from(safeguardingCases)
      .where(eq(safeguardingCases.tenantId, s.tenant.id)),
  );

async function setup() {
  const s = await baseSchool();
  const kwame = (await s.add("Kwame", s.classA)).id;
  await appointLead(conn.app, s.owner, await membershipOf(s, s.head.userId));
  const head = await fresh(s, s.head);
  return { s, kwame, head };
}

describe("safeguarding (SFG-01)", () => {
  it("lets any staff member report, and only the school's leads read cases, enforced by the database", async () => {
    const { s, kwame, head } = await setup();
    expect(allowed(s.teacher, "safeguarding.report")).toBe(true);
    expect(allowed(s.teacher, "safeguarding.manage")).toBe(false);
    // The Proprietor appoints leads but is not one: no role reads cases.
    expect(allowed(s.owner, "safeguarding.manage")).toBe(false);
    expect(allowed(head, "safeguarding.manage")).toBe(true);
    expect((await listLeads(conn.app, s.teacher)).map((l) => l.name)).toEqual(["Head"]);

    // Any child can be reported, even one outside the teacher's classes.
    expect((await listReportableStudents(conn.app, s.teacher)).map((r) => r.name)).toContain("Kwame Mensah");
    const { reference } = await reportConcern(conn.app, s.teacher, {
      studentId: kwame,
      category: "neglect",
      description: "Came to school hungry three days this week and said there was no food at home.",
      occurredOn: "2026-11-16",
      location: "Basic 4A",
    });
    expect(reference).toBe("SG0001");
    await expect(
      reportConcern(conn.app, s.teacher, { studentId: kwame, category: "other", description: "short" }),
    ).rejects.toThrow("Say what you saw");

    // The reporter sees only that it was received.
    expect(await listMyReports(conn.app, s.teacher)).toEqual([
      expect.objectContaining({ reference: "SG0001", student: "Kwame Mensah" }),
    ]);
    await expect(listCases(conn.app, s.teacher)).rejects.toBeInstanceOf(ForbiddenError);

    // Directly in the database: the lead and the reporter see it; the Proprietor, the Accountant, a job without a
    // user, and another school see nothing.
    expect(await rawCases(s, s.head.userId)).toHaveLength(1);
    expect(await rawCases(s, s.teacher.userId)).toHaveLength(1);
    expect(await rawCases(s, s.owner.userId)).toEqual([]);
    expect(await rawCases(s, s.bursar.userId)).toEqual([]);
    expect(await rawCases(s, "")).toEqual([]);
    const other = await baseSchool();
    expect(await rawCases(other, other.owner.userId)).toEqual([]);

    // Case content stays out of the general audit log, which the Proprietor and Administrator can read.
    const audit = await withTenant(conn.app, { tenantId: s.tenant.id, userId: s.owner.userId }, (tx) =>
      tx
        .select({ action: auditEvents.action })
        .from(auditEvents)
        .where(eq(auditEvents.tenantId, s.tenant.id)),
    );
    expect(audit.map((a) => a.action).filter((a) => a.startsWith("safeguarding."))).toEqual([
      "safeguarding.lead_appointed",
    ]);
  });

  it("records follow-up, every opening and download, and keeps the history and account unchanged", async () => {
    const { s, kwame, head } = await setup();
    const { reference } = await reportConcern(conn.app, s.teacher, {
      studentId: kwame,
      category: "bullying",
      description: "Older pupils took his lunch money at break, twice this week.",
    });
    const [summary] = await listCases(conn.app, head);
    expect(summary).toMatchObject({ reference, status: "open", openActions: 0, lead: null });

    await assignCaseLead(conn.app, head, summary!.id, await membershipOf(s, s.head.userId));
    await addCaseEntry(conn.app, head, summary!.id, {
      kind: "action",
      body: "Speak with the class teacher and the pupils involved",
      dueOn: "2026-11-20",
    });
    await expect(
      addCaseEntry(conn.app, head, summary!.id, { kind: "note", body: "x", dueOn: "2026-11-20" }),
    ).rejects.toThrow("Only an action has a due date.");
    await addCaseEntry(conn.app, head, summary!.id, { kind: "family_contact", body: "Called his mother." });
    await uploadCaseDocument(conn.app, head, summary!.id, { filename: "statement.pdf", bytes: PDF });
    await expect(setCaseStatus(conn.app, head, summary!.id, { status: "closed" })).rejects.toThrow(
      "Say why the case is closed.",
    );

    let detail = await getCase(conn.app, head, summary!.id);
    expect(detail.lead?.name).toBe("Head");
    expect(detail.entries.map((e) => e.kind)).toEqual(["note", "family_contact", "action", "assignment"]);
    const action = detail.entries.find((e) => e.kind === "action")!;
    await markActionDone(conn.app, head, action.id);
    await expect(markActionDone(conn.app, head, action.id)).rejects.toMatchObject({ code: "action_closed" });
    const file = await downloadCaseDocument(conn.app, head, summary!.id, detail.documents[0]!.id);
    expect(file?.filename).toBe("statement.pdf");
    await setCaseStatus(conn.app, head, summary!.id, {
      status: "closed",
      note: "Resolved with both families.",
    });

    detail = await getCase(conn.app, head, summary!.id);
    expect(detail.status).toBe("closed");
    expect(detail.entries[0]?.body).toBe("Closed: Resolved with both families.");
    expect(detail.access.map((a) => a.action)).toEqual(["viewed", "downloaded", "viewed"]);

    // The account, the history and the access record never change, for any role; documents are lead-only.
    const asOwner = <T>(fn: Parameters<typeof withTenant<T>>[2]) =>
      withTenant(conn.owner, { tenantId: s.tenant.id, userId: s.head.userId }, fn);
    await expect(
      withTenant(conn.app, { tenantId: s.tenant.id, userId: s.head.userId }, (tx) =>
        tx
          .update(safeguardingCases)
          .set({ description: "rewritten" })
          .where(eq(safeguardingCases.id, summary!.id)),
      ),
    ).rejects.toThrow();
    await expect(
      asOwner((tx) => tx.delete(safeguardingEntries).where(eq(safeguardingEntries.caseId, summary!.id))),
    ).rejects.toThrow();
    await expect(
      asOwner((tx) => tx.delete(safeguardingAccess).where(eq(safeguardingAccess.caseId, summary!.id))),
    ).rejects.toThrow();
    const ownerDocs = await withTenant(conn.app, { tenantId: s.tenant.id, userId: s.owner.userId }, (tx) =>
      tx.select({ id: safeguardingDocuments.id }).from(safeguardingDocuments),
    );
    expect(ownerDocs).toEqual([]);
  });

  it("stops a lead reading cases the moment the Proprietor ends their appointment", async () => {
    const { s, kwame, head } = await setup();
    await reportConcern(conn.app, s.teacher, {
      studentId: kwame,
      category: "online_safety",
      description: "Shared a message from an adult stranger asking to meet.",
    });
    const [lead] = await listLeads(conn.app, s.owner);
    await endLead(conn.app, s.owner, lead!.id);
    expect(allowed(await fresh(s, head), "safeguarding.manage")).toBe(false);
    expect(await rawCases(s, s.head.userId)).toEqual([]);
    await expect(getCase(conn.app, head, (await rawCases(s, s.teacher.userId))[0]!.id)).rejects.toThrow();
  });
});
