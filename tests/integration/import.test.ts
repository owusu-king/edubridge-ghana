import writeXlsxFile from "write-excel-file/node";
import { afterAll, describe, expect, it } from "vitest";
import { createAcademicYear, listAcademicYears, setCurrentTerm } from "@/server/academics/calendar";
import { createClass, listLevelsWithClasses, setupDefaultLevels } from "@/server/academics/classes";
import { ForbiddenError } from "@/server/authz/permissions";
import { withTenant } from "@/server/db/context";
import { campuses } from "@/server/db/schema";
import {
  autoMapColumns,
  checkStudentImport,
  importStudents,
  MAX_ROWS,
  parseImportFile,
} from "@/server/imports/students";
import { listGuardians } from "@/server/students/guardians";
import { createStudent, listStudents } from "@/server/students/service";
import { resolveTenantContext, type TenantContext } from "@/server/tenancy/service";
import { addMember, connect, createTenant, createUser } from "../support/fixtures";

const conn = connect();
afterAll(() => conn.close());

async function school() {
  const tenant = await createTenant(conn.owner);
  const admin = await createUser(conn.owner);
  const teacher = await createUser(conn.owner);
  await addMember(conn.owner, tenant.id, admin.id, ["admin"]);
  await addMember(conn.owner, tenant.id, teacher.id, ["teacher"]);
  const [campus] = await withTenant(conn.owner, { tenantId: tenant.id, userId: admin.id }, (tx) =>
    tx.insert(campuses).values({ tenantId: tenant.id, name: "Main" }).returning(),
  );
  const ctx = async (id: string) => (await resolveTenantContext(conn.app, tenant.slug, id)) as TenantContext;
  const adminCtx = await ctx(admin.id);
  await setupDefaultLevels(conn.app, adminCtx, { stages: ["primary"] });
  const [b1, b2] = await listLevelsWithClasses(conn.app, adminCtx);
  await createClass(conn.app, adminCtx, { levelId: b1!.id, campusId: campus!.id, name: "Basic 1A" });
  await createClass(conn.app, adminCtx, { levelId: b2!.id, campusId: campus!.id, name: "Basic 2" });
  await createAcademicYear(conn.app, adminCtx, {
    name: "2026/2027",
    terms: [{ name: "Term 1", startsOn: "2026-09-08", endsOn: "2026-12-18" }],
  });
  await setCurrentTerm(conn.app, adminCtx, (await listAcademicYears(conn.app, adminCtx))[0]!.terms[0]!.id);
  return { admin: adminCtx, teacher: await ctx(teacher.id) };
}

const csv = (lines: string[]) => {
  const text = lines.join("\n");
  return { name: "students.csv", size: text.length, bytes: Buffer.from(text) };
};

const header =
  "Admission No,First Name,Surname,Sex,Date of Birth,Class,Parent Name,Parent Phone,Relationship";

describe("student import", () => {
  it("imports valid rows with classes and guardians, linking siblings, and reports problems", async () => {
    const s = await school();
    const file = await parseImportFile(
      csv([
        header,
        "A100,Ama,Owusu,F,14/03/2018,Basic 1A,Akosua Owusu,024 555 0101,Mother",
        "A101,Kofi,Owusu,M,02/07/2017,basic 2,Akosua Owusu,0245550101,mum",
        ",Esi,Quaye,girl,,,,,",
        "A102,Yaw,,M,,,,,",
        "A103,Kwame,Mensah,X,31/02/2017,Basic 9,Grace Mensah,12345,aunt",
        "A100,Abena,Asante,F,,,,,",
      ]),
    );
    const mapping = autoMapColumns(file.headers);
    const check = await checkStudentImport(conn.app, s.admin, file, mapping);
    expect([check.total, check.valid]).toEqual([6, 3]);
    expect(check.problems.map((p) => [p.row, p.field])).toEqual([
      [5, "Surname"],
      [6, "Sex"],
      [6, "Date of birth"],
      [6, "Class"],
      [6, "Guardian phone"],
      [6, "Relationship"],
      [7, "Admission number"],
    ]);

    const result = await importStudents(conn.app, s.admin, file, mapping);
    expect([result.imported, result.skipped]).toEqual([3, 3]);
    const list = await listStudents(conn.app, s.admin);
    expect(list.rows.map((r) => [r.fullName, r.admissionNumber, r.className])).toEqual([
      ["Ama Owusu", "A100", "Basic 1A"],
      ["Kofi Owusu", "A101", "Basic 2"],
      ["Esi Quaye", "0001", null],
    ]);
    const kofi = list.rows.find((r) => r.fullName === "Kofi Owusu")!;
    const guardians = await listGuardians(conn.app, s.admin, kofi.id);
    expect(guardians![0]).toMatchObject({
      fullName: "Akosua Owusu",
      phone: "+233245550101",
      isPrimary: true,
      otherStudents: [{ name: "Ama Owusu" }],
    });

    // Importing the same file again creates nothing new: the admission numbers now exist.
    const again = await checkStudentImport(conn.app, s.admin, file, mapping);
    expect(again.problems.filter((p) => p.field === "Admission number")).toHaveLength(3);
  });

  it("reads Excel files, including dates and phone numbers stored as numbers", async () => {
    const s = await school();
    const data = [
      ["First name", "Surname", "Sex", "DOB", "Phone", "Guardian"].map((value) => ({ value })),
      [
        { value: "Adwoa" },
        { value: "Boateng" },
        { value: "F" },
        { value: new Date("2017-07-19"), format: "dd/mm/yyyy" },
        { value: 205550111 },
        { value: "Kofi Boateng" },
      ],
    ];
    const written = (await writeXlsxFile(data as never)) as unknown as
      Buffer | { toBuffer(): Promise<Buffer> };
    const bytes = Buffer.isBuffer(written) ? written : await written.toBuffer();
    const file = await parseImportFile({ name: "register.xlsx", size: bytes.length, bytes });
    expect(file.rows[0]).toEqual(["Adwoa", "Boateng", "F", "2017-07-19", "205550111", "Kofi Boateng"]);
    const result = await importStudents(conn.app, s.admin, file, autoMapColumns(file.headers));
    expect(result.imported).toBe(1);
    const [student] = (await listStudents(conn.app, s.admin)).rows;
    expect(student!.primaryContact).toEqual({ name: "Kofi Boateng", phone: "+233205550111" });
  });

  it("refuses unsupported, empty, oversized and incompletely mapped files", async () => {
    const s = await school();
    await expect(parseImportFile({ name: "a.pdf", size: 10, bytes: Buffer.from("x") })).rejects.toMatchObject(
      { code: "file_type" },
    );
    await expect(parseImportFile(csv([header]))).rejects.toMatchObject({ code: "file_empty" });
    await expect(
      parseImportFile({ name: "a.xlsx", size: 10, bytes: Buffer.from("not excel") }),
    ).rejects.toMatchObject({ code: "file_unreadable" });
    const many = csv([header, ...Array.from({ length: MAX_ROWS + 1 }, (_, i) => `N${i},A,B,F,,,,,`)]);
    await expect(parseImportFile(many)).rejects.toMatchObject({ code: "file_too_many_rows" });
    const file = await parseImportFile(csv([header, "A1,Ama,Owusu,F,,,,,"]));
    await expect(
      checkStudentImport(conn.app, s.admin, file, { ...autoMapColumns(file.headers), sex: null }),
    ).rejects.toMatchObject({
      code: "mapping_incomplete",
    });
  });

  it("does not collide with existing admission numbers and requires permission", async () => {
    const s = await school();
    await createStudent(conn.app, s.admin, { firstName: "Existing", lastName: "Student", sex: "male" });
    const file = await parseImportFile(csv([header, ",New,Student,F,,,,,"]));
    await importStudents(conn.app, s.admin, file, autoMapColumns(file.headers));
    expect((await listStudents(conn.app, s.admin)).rows.map((r) => r.admissionNumber).sort()).toEqual([
      "0001",
      "0002",
    ]);
    await expect(
      importStudents(conn.app, s.teacher, file, autoMapColumns(file.headers)),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
