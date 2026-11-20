import "server-only";
import { and, eq, isNull, sql } from "drizzle-orm";
import { EMPLOYMENT_TYPES, type EmploymentType } from "@/lib/staff";
import { todayIn } from "@/lib/format";
import { recordAudit } from "../audit/record";
import { assertAllowed } from "../authz/permissions";
import type { Database, Transaction } from "../db/client";
import { withTenant } from "../db/context";
import { staff, staffDepartments, staffPositions } from "../db/schema";
import { DomainError } from "../errors";
import { insertStaffInTx, scopeOf } from "../staff/records";
import type { TenantContext } from "../tenancy/service";
import {
  assertMappingComplete,
  getter,
  mapColumns,
  MAX_ROWS,
  parseDate,
  parseImportPhone,
  parseSex,
  type ColumnMapping,
  type ImportField,
  type ParsedFile,
  type RowProblem,
} from "./files";

/**
 * Importing staff from a spreadsheet, for a school moving from another system (2026-11-19). Creates staff records
 * (HR-01), not EduBridge accounts: staff who need to sign in are invited from Members, and their record linked.
 * Steps, as for students: parse the file, match columns, check every row, import the rows that passed. Positions and
 * departments not yet on the school's lists are added, and the check says which.
 */

export const STAFF_FIELDS = [
  {
    key: "staffNumber",
    label: "Staff number",
    required: false,
    aliases: [
      "staff number",
      "staff no",
      "staff no.",
      "staff id",
      "employee number",
      "employee no",
      "employee id",
      "id",
    ],
  },
  {
    key: "firstName",
    label: "First name",
    required: true,
    aliases: ["first name", "firstname", "given name", "forename"],
  },
  {
    key: "otherNames",
    label: "Other names",
    required: false,
    aliases: ["other names", "other name", "middle name"],
  },
  {
    key: "lastName",
    label: "Surname",
    required: true,
    aliases: ["surname", "last name", "lastname", "family name"],
  },
  { key: "sex", label: "Sex", required: false, aliases: ["sex", "gender"] },
  {
    key: "dateOfBirth",
    label: "Date of birth",
    required: false,
    aliases: ["date of birth", "dob", "birth date"],
  },
  {
    key: "phone",
    label: "Phone",
    required: false,
    aliases: ["phone", "phone number", "mobile", "mobile number", "telephone", "contact", "contact number"],
  },
  { key: "email", label: "Email", required: false, aliases: ["email", "email address", "e-mail"] },
  {
    key: "position",
    label: "Position",
    required: false,
    aliases: ["position", "job title", "role", "designation", "post", "title"],
  },
  {
    key: "department",
    label: "Department",
    required: false,
    aliases: ["department", "dept", "section", "unit"],
  },
  {
    key: "employmentType",
    label: "Employment type",
    required: false,
    aliases: ["employment type", "employment", "type", "contract type", "status"],
  },
  {
    key: "startedOn",
    label: "Start date",
    required: false,
    aliases: [
      "start date",
      "date started",
      "started",
      "date joined",
      "joined",
      "date employed",
      "employment date",
    ],
  },
  {
    key: "qualifications",
    label: "Qualifications",
    required: false,
    aliases: ["qualifications", "qualification"],
  },
  {
    key: "emergencyName",
    label: "Emergency contact",
    required: false,
    aliases: ["emergency contact", "next of kin", "emergency name", "emergency contact name"],
  },
  {
    key: "emergencyPhone",
    label: "Emergency phone",
    required: false,
    aliases: ["emergency phone", "next of kin phone", "emergency contact phone", "emergency number"],
  },
] as const satisfies readonly ImportField[];

export type StaffFieldKey = (typeof STAFF_FIELDS)[number]["key"];
export type StaffMapping = ColumnMapping<StaffFieldKey>;

export interface StaffImportCheck {
  total: number;
  valid: number;
  problems: RowProblem[];
  /** Positions and departments the import will add to the school's lists. */
  newPositions: string[];
  newDepartments: string[];
}

export function autoMapStaffColumns(headers: string[]): StaffMapping {
  return mapColumns(headers, STAFF_FIELDS);
}

const EMPLOYMENT_ALIASES: Record<string, EmploymentType> = {
  permanent: "permanent",
  "full time": "permanent",
  "full-time": "permanent",
  fulltime: "permanent",
  staff: "permanent",
  contract: "contract",
  contractor: "contract",
  "part time": "part_time",
  "part-time": "part_time",
  parttime: "part_time",
  "national service": "national_service",
  nss: "national_service",
  "service personnel": "national_service",
  volunteer: "volunteer",
  casual: "casual",
  temporary: "casual",
};

/** "Class teacher" and "class  teacher" are one position; the first spelling in the file is kept. */
const listKey = (v: string) => v.trim().replace(/\s+/g, " ").toLowerCase();

interface ValidRow {
  row: number;
  staffNumber: string | null;
  firstName: string;
  otherNames: string | null;
  lastName: string;
  sex: "female" | "male" | null;
  dateOfBirth: string | null;
  phone: string | null;
  email: string | null;
  position: string | null;
  department: string | null;
  employmentType: EmploymentType;
  startedOn: string;
  qualifications: string | null;
  emergencyName: string | null;
  emergencyPhone: string | null;
}

async function readList(
  tx: Transaction,
  table: typeof staffPositions | typeof staffDepartments,
  tenantId: string,
) {
  const rows = await tx
    .select({ id: table.id, name: table.name })
    .from(table)
    .where(and(eq(table.tenantId, tenantId), isNull(table.archivedAt)));
  return new Map(rows.map((r) => [listKey(r.name), r.id]));
}

async function checkRows(tx: Transaction, ctx: TenantContext, parsed: ParsedFile, mapping: StaffMapping) {
  assertMappingComplete(STAFF_FIELDS, mapping);
  const today = todayIn(ctx.tenant.timezone);
  const existingNumbers = new Set(
    (await tx.select({ n: staff.staffNumber }).from(staff).where(eq(staff.tenantId, ctx.tenant.id))).map(
      (r) => r.n.toLowerCase(),
    ),
  );
  // People already on the staff list, so importing the same file twice adds no one twice: by name with phone or
  // email, and by name alone for a row with nothing else to tell the person apart.
  const current = await tx
    .select({ first: staff.firstName, last: staff.lastName, phone: staff.phone, email: staff.email })
    .from(staff)
    .where(eq(staff.tenantId, ctx.tenant.id));
  const nameOf = (first: string, last: string) => `${listKey(first)}|${listKey(last)}`;
  const existingNames = new Set(current.map((p) => nameOf(p.first, p.last)));
  const existingPeople = new Set(
    current.flatMap((p) =>
      [
        p.phone ? `${nameOf(p.first, p.last)}|${p.phone}` : null,
        p.email ? `${nameOf(p.first, p.last)}|${p.email.toLowerCase()}` : null,
      ].filter((k): k is string => k !== null),
    ),
  );
  const positions = await readList(tx, staffPositions, ctx.tenant.id);
  const departments = await readList(tx, staffDepartments, ctx.tenant.id);
  const newPositions = new Map<string, string>();
  const newDepartments = new Map<string, string>();
  const seenNumbers = new Set<string>();

  const valid: ValidRow[] = [];
  const problems: RowProblem[] = [];
  parsed.rows.forEach((cells, i) => {
    const row = i + 2;
    const get = getter(cells, mapping);
    const rowProblems: RowProblem[] = [];
    const problem = (field: string, message: string) => rowProblems.push({ row, field, message });

    const firstName = get("firstName");
    const lastName = get("lastName");
    if (!firstName) problem("First name", "First name is empty.");
    else if (firstName.length > 80) problem("First name", "First name is longer than 80 characters.");
    if (!lastName) problem("Surname", "Surname is empty.");
    else if (lastName.length > 80) problem("Surname", "Surname is longer than 80 characters.");
    const otherNames = get("otherNames") || null;
    if (otherNames && otherNames.length > 80)
      problem("Other names", "Other names are longer than 80 characters.");

    const sexText = get("sex");
    const sex = sexText ? parseSex(sexText) : null;
    if (sexText && !sex)
      problem("Sex", `“${sexText}” is not a sex we recognise. Use F or M, or leave it empty.`);

    const dobText = get("dateOfBirth");
    const dateOfBirth = dobText ? parseDate(dobText) : null;
    if (dobText && !dateOfBirth)
      problem("Date of birth", `“${dobText}” is not a date. Use day/month/year, e.g. 14/03/1985.`);
    else if (dateOfBirth && dateOfBirth >= today)
      problem("Date of birth", "The date of birth is in the future.");

    const phoneText = get("phone");
    const phone = phoneText ? parseImportPhone(phoneText, ctx.tenant.countryCode) : null;
    if (phoneText && !phone)
      problem("Phone", `“${phoneText}” is not a phone number we recognise, e.g. 024 123 4567.`);
    const emergencyPhoneText = get("emergencyPhone");
    const emergencyPhone = emergencyPhoneText
      ? parseImportPhone(emergencyPhoneText, ctx.tenant.countryCode)
      : null;
    if (emergencyPhoneText && !emergencyPhone)
      problem("Emergency phone", `“${emergencyPhoneText}” is not a phone number we recognise.`);

    const email = get("email").toLowerCase() || null;
    if (email && (email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))
      problem("Email", `“${get("email")}” is not an email address.`);

    const staffNumber = get("staffNumber") || null;
    if (staffNumber) {
      const key = staffNumber.toLowerCase();
      if (staffNumber.length > 30) problem("Staff number", "Staff number is longer than 30 characters.");
      else if (existingNumbers.has(key))
        problem("Staff number", `Staff number ${staffNumber} is already in use.`);
      else if (seenNumbers.has(key))
        problem("Staff number", `Staff number ${staffNumber} appears more than once in the file.`);
      seenNumbers.add(key);
    }

    const person = nameOf(firstName, lastName);
    if (
      firstName &&
      lastName &&
      ((phone && existingPeople.has(`${person}|${phone}`)) ||
        (email && existingPeople.has(`${person}|${email}`)))
    )
      problem("Name", `${firstName} ${lastName} is already on your staff list.`);
    else if (firstName && lastName && !phone && !email && !staffNumber && existingNames.has(person))
      problem(
        "Name",
        `Someone called ${firstName} ${lastName} is already on your staff list. If this is a different person, add their phone number or staff number to the row.`,
      );

    const typeText = get("employmentType");
    const employmentType = typeText
      ? (EMPLOYMENT_ALIASES[listKey(typeText)] ??
        (EMPLOYMENT_TYPES as readonly string[]).find((t) => t === listKey(typeText).replace(/\s+/g, "_")))
      : "permanent";
    if (!employmentType)
      problem(
        "Employment type",
        `“${typeText}” is not a type we recognise. Use permanent, contract, part-time, national service, volunteer or casual.`,
      );

    const startText = get("startedOn");
    const startedOn = startText ? parseDate(startText) : today;
    if (startText && !startedOn) problem("Start date", `“${startText}” is not a date. Use day/month/year.`);
    else if (startedOn && startedOn > today) problem("Start date", "The start date is in the future.");

    const position = get("position").replace(/\s+/g, " ") || null;
    const department = get("department").replace(/\s+/g, " ") || null;
    if (position && (position.length < 2 || position.length > 80))
      problem("Position", "Use 2 to 80 characters.");
    if (department && (department.length < 2 || department.length > 80))
      problem("Department", "Use 2 to 80 characters.");

    const qualifications = get("qualifications") || null;
    if (qualifications && qualifications.length > 500)
      problem("Qualifications", "Qualifications are longer than 500 characters.");
    const emergencyName = get("emergencyName") || null;
    if (emergencyName && emergencyName.length > 120)
      problem("Emergency contact", "The emergency contact is longer than 120 characters.");

    if (rowProblems.length) {
      problems.push(...rowProblems);
      return;
    }
    if (position && !positions.has(listKey(position)) && !newPositions.has(listKey(position)))
      newPositions.set(listKey(position), position);
    if (department && !departments.has(listKey(department)) && !newDepartments.has(listKey(department)))
      newDepartments.set(listKey(department), department);
    valid.push({
      row,
      staffNumber,
      firstName,
      otherNames,
      lastName,
      sex,
      dateOfBirth,
      phone,
      email,
      position,
      department,
      employmentType: employmentType as EmploymentType,
      startedOn: startedOn!,
      qualifications,
      emergencyName,
      emergencyPhone,
    });
  });
  return { valid, problems, positions, departments, newPositions, newDepartments };
}

/** Imports need the whole school in view: staff are not limited to one campus here. */
function assertSchoolWide(ctx: TenantContext) {
  if (ctx.campusIds !== null)
    throw new DomainError(
      "campus_scope",
      "Importing staff needs access to every campus. Ask the Proprietor.",
    );
}

/** Checks every row without saving anything. */
export async function checkStaffImport(
  database: Database,
  ctx: TenantContext,
  parsed: ParsedFile,
  mapping: StaffMapping,
): Promise<StaffImportCheck> {
  assertAllowed(ctx, "staff.manage");
  assertSchoolWide(ctx);
  if (parsed.rows.length > MAX_ROWS)
    throw new DomainError("file_too_many_rows", `Import up to ${MAX_ROWS} rows at a time.`);
  return withTenant(database, scopeOf(ctx), async (tx) => {
    const { valid, problems, newPositions, newDepartments } = await checkRows(tx, ctx, parsed, mapping);
    return {
      total: parsed.rows.length,
      valid: valid.length,
      problems,
      newPositions: [...newPositions.values()],
      newDepartments: [...newDepartments.values()],
    };
  });
}

/**
 * Imports the rows that pass the checks, all in one transaction; rows with problems are left out and reported.
 * Staff numbers from the file are kept; the rest get the next number.
 */
export async function importStaff(
  database: Database,
  ctx: TenantContext,
  parsed: ParsedFile,
  mapping: StaffMapping,
): Promise<{ imported: number; skipped: number; problems: RowProblem[] }> {
  assertAllowed(ctx, "staff.manage");
  assertSchoolWide(ctx);
  if (parsed.rows.length > MAX_ROWS)
    throw new DomainError("file_too_many_rows", `Import up to ${MAX_ROWS} rows at a time.`);
  return withTenant(database, scopeOf(ctx), async (tx) => {
    // One import at a time per school, so staff numbers and new list items cannot race.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${"staff-import:" + ctx.tenant.id}, 0))`,
    );
    const { valid, problems, positions, departments, newPositions, newDepartments } = await checkRows(
      tx,
      ctx,
      parsed,
      mapping,
    );
    for (const [key, name] of newPositions) {
      const [row] = await tx
        .insert(staffPositions)
        .values({ tenantId: ctx.tenant.id, name })
        .returning({ id: staffPositions.id });
      positions.set(key, row!.id);
    }
    for (const [key, name] of newDepartments) {
      const [row] = await tx
        .insert(staffDepartments)
        .values({ tenantId: ctx.tenant.id, name })
        .returning({ id: staffDepartments.id });
      departments.set(key, row!.id);
    }
    for (const r of valid) {
      await insertStaffInTx(tx, ctx, {
        staffNumber: r.staffNumber,
        firstName: r.firstName,
        lastName: r.lastName,
        otherNames: r.otherNames,
        sex: r.sex,
        dateOfBirth: r.dateOfBirth,
        phone: r.phone,
        email: r.email,
        qualifications: r.qualifications,
        emergencyName: r.emergencyName,
        emergencyPhone: r.emergencyPhone,
        employmentType: r.employmentType,
        positionId: r.position ? (positions.get(listKey(r.position)) ?? null) : null,
        departmentId: r.department ? (departments.get(listKey(r.department)) ?? null) : null,
        campusId: null,
        startedOn: r.startedOn,
      });
    }
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "staff.imported",
      entityType: "staff",
      metadata: {
        imported: valid.length,
        skipped: parsed.rows.length - valid.length,
        positionsAdded: newPositions.size,
        departmentsAdded: newDepartments.size,
      },
    });
    return { imported: valid.length, skipped: parsed.rows.length - valid.length, problems };
  });
}

/** The template's header row. */
export const STAFF_TEMPLATE_HEADERS = STAFF_FIELDS.map((f) => f.label);
