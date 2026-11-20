import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { withTenant } from "@/server/db/context";
import { auditEvents, staff, staffEmploymentEvents, staffPositions } from "@/server/db/schema";
import type { ParsedFile } from "@/server/imports/files";
import { autoMapStaffColumns, checkStaffImport, importStaff } from "@/server/imports/staff";
import { connect } from "../support/fixtures";
import { billedSchool } from "../support/school";

const conn = connect();
afterAll(() => conn.close());

const HEADERS = [
  "Staff No",
  "First Name",
  "Surname",
  "Gender",
  "Mobile",
  "Email",
  "Designation",
  "Department",
  "Type",
  "Date Joined",
];
const file = (rows: string[][]): ParsedFile => ({ headers: HEADERS, rows });

const GOOD = [
  [
    "T014",
    "Akosua",
    "Frimpong",
    "F",
    "024 123 4567",
    "akosua@example.test",
    "Class teacher",
    "Primary",
    "Permanent",
    "04/09/2017",
  ],
  ["", "Yaw", "Darko", "M", "241234568", "", "Driver", "Transport", "contract", "15/01/2024"],
  ["", "Abena", "Owusu", "", "", "", "class  teacher", "", "", ""],
];

describe("importing staff", () => {
  it("matches an old system's headings, checks every row and names the positions it will add", async () => {
    const s = await billedSchool(conn);
    const mapping = autoMapStaffColumns(HEADERS);
    expect(mapping).toMatchObject({
      staffNumber: 0,
      firstName: 1,
      lastName: 2,
      sex: 3,
      phone: 4,
      position: 6,
      startedOn: 9,
    });
    const checked = await checkStaffImport(
      conn.app,
      s.owner,
      file([
        ...GOOD,
        ["T014", "Kofi", "Mensah", "M", "", "", "", "", "", ""],
        ["", "", "Boateng", "X", "12", "not-an-email", "", "", "Forever", "31/02/2020"],
      ]),
      mapping,
    );
    expect(checked).toMatchObject({ total: 5, valid: 3, newPositions: ["Class teacher", "Driver"] });
    expect(checked.newDepartments.sort()).toEqual(["Primary", "Transport"]);
    const fields = (row: number) => checked.problems.filter((p) => p.row === row).map((p) => p.field);
    expect(fields(5)).toEqual(["Staff number"]);
    expect(fields(6)).toEqual(
      expect.arrayContaining(["First name", "Sex", "Phone", "Email", "Employment type", "Start date"]),
    );
  });

  it("adds the rows that pass, keeps staff numbers, and finds them again on a second import", async () => {
    const s = await billedSchool(conn);
    const mapping = autoMapStaffColumns(HEADERS);
    const result = await importStaff(conn.app, s.owner, file(GOOD), mapping);
    expect(result).toMatchObject({ imported: 3, skipped: 0 });

    const rows = await withTenant(conn.owner, { tenantId: s.tenant.id, userId: s.userId() }, async (tx) => ({
      people: await tx.select().from(staff).where(eq(staff.tenantId, s.tenant.id)),
      positions: await tx
        .select({ name: staffPositions.name })
        .from(staffPositions)
        .where(eq(staffPositions.tenantId, s.tenant.id)),
      events: await tx
        .select()
        .from(staffEmploymentEvents)
        .where(eq(staffEmploymentEvents.tenantId, s.tenant.id)),
      audit: await tx
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.tenantId, s.tenant.id), eq(auditEvents.action, "staff.imported"))),
    }));
    const akosua = rows.people.find((p) => p.firstName === "Akosua")!;
    expect(akosua).toMatchObject({
      staffNumber: "T014",
      phone: "+233241234567",
      employmentType: "permanent",
      startedOn: "2017-09-04",
    });
    // Excel's lost leading 0 is restored; other people get the next staff number.
    const yaw = rows.people.find((p) => p.firstName === "Yaw")!;
    expect(yaw).toMatchObject({ phone: "+233241234568", employmentType: "contract" });
    expect(yaw.staffNumber).toMatch(/^S\d{4}$/);
    // "class  teacher" is the same position as "Class teacher": one position, two people.
    expect(rows.positions.map((p) => p.name).sort()).toEqual(["Class teacher", "Driver"]);
    expect(rows.people.filter((p) => p.positionId === akosua.positionId)).toHaveLength(2);
    expect(rows.events.filter((e) => e.kind === "started")).toHaveLength(3);
    expect(rows.audit[0]?.metadata).toMatchObject({ imported: 3, positionsAdded: 2, departmentsAdded: 2 });

    const again = await checkStaffImport(conn.app, s.owner, file(GOOD), mapping);
    expect(again.valid).toBe(0);
    expect(again.problems.map((p) => p.message)).toEqual(
      expect.arrayContaining([
        "Staff number T014 is already in use.",
        "Akosua Frimpong is already on your staff list.",
        "Yaw Darko is already on your staff list.",
        "Someone called Abena Owusu is already on your staff list. If this is a different person, add their phone number or staff number to the row.",
      ]),
    );
  });

  it("is for those who manage staff, with the whole school in view", async () => {
    const s = await billedSchool(conn, { roles: ["teacher"] });
    const mapping = autoMapStaffColumns(HEADERS);
    await expect(importStaff(conn.app, await s.ctx("teacher"), file(GOOD), mapping)).rejects.toThrow();
    const limited = { ...s.owner, campusIds: [s.campusId] };
    await expect(checkStaffImport(conn.app, limited, file(GOOD), mapping)).rejects.toMatchObject({
      code: "campus_scope",
    });
  });
});
