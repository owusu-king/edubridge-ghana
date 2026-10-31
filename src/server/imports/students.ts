import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { readSheet } from "read-excel-file/node";
import { recordAudit } from "../audit/record";
import { assertCan } from "../authz/permissions";
import type { Database, Transaction } from "../db/client";
import { withTenant } from "../db/context";
import { classes, enrolments, students, terms } from "../db/schema";
import { nextAdmissionNumber } from "../students/service";
import { DomainError } from "../errors";
import { linkGuardianInTx, type AddGuardianInput } from "../students/guardian-links";
import type { TenantContext } from "../tenancy/service";
import { parseCsv } from "@/lib/csv";
import { normalizePhone } from "@/lib/phone";

/**
 * Importing students (with their class this term and primary guardian) from a spreadsheet.
 * Steps: parse the file → match columns → check every row → import the rows that passed.
 */

export const MAX_ROWS = 2000;
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

export const IMPORT_FIELDS = [
  {
    key: "admissionNumber",
    label: "Admission number",
    required: false,
    aliases: [
      "admission number",
      "admission no",
      "admission no.",
      "adm no",
      "adm. no",
      "student id",
      "student number",
      "id",
    ],
  },
  {
    key: "firstName",
    label: "First name",
    required: true,
    aliases: ["first name", "firstname", "given name", "forename", "first names"],
  },
  {
    key: "otherNames",
    label: "Other names",
    required: false,
    aliases: ["other names", "other name", "middle name", "middle names"],
  },
  {
    key: "lastName",
    label: "Surname",
    required: true,
    aliases: ["surname", "last name", "lastname", "family name"],
  },
  { key: "sex", label: "Sex", required: true, aliases: ["sex", "gender"] },
  {
    key: "dateOfBirth",
    label: "Date of birth",
    required: false,
    aliases: ["date of birth", "dob", "birth date", "birthday", "d.o.b"],
  },
  {
    key: "className",
    label: "Class",
    required: false,
    aliases: ["class", "class name", "form", "grade", "stage"],
  },
  {
    key: "guardianName",
    label: "Guardian name",
    required: false,
    aliases: [
      "guardian name",
      "guardian",
      "parent name",
      "parent",
      "parent/guardian",
      "parent or guardian",
      "father/mother",
    ],
  },
  {
    key: "guardianPhone",
    label: "Guardian phone",
    required: false,
    aliases: [
      "guardian phone",
      "parent phone",
      "phone",
      "phone number",
      "telephone",
      "mobile",
      "contact",
      "contact number",
      "parent contact",
    ],
  },
  {
    key: "guardianRelationship",
    label: "Relationship",
    required: false,
    aliases: ["relationship", "relation", "relationship to student"],
  },
] as const;

export type FieldKey = (typeof IMPORT_FIELDS)[number]["key"];
/** Field → column index in the file (null when the file has no such column). */
export type ColumnMapping = Partial<Record<FieldKey, number | null>>;

export interface ParsedFile {
  headers: string[];
  rows: string[][];
}

const normaliseHeader = (h: string) => h.toLowerCase().replace(/[_*]+/g, " ").replace(/\s+/g, " ").trim();

function cellToText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).trim();
}

/** Reads a .csv or .xlsx file into a header row and data rows of text. */
export async function parseImportFile(file: {
  name: string;
  size: number;
  bytes: Buffer;
}): Promise<ParsedFile> {
  if (file.size > MAX_FILE_BYTES)
    throw new DomainError(
      "file_too_large",
      "The file is larger than 2 MB. Split it into smaller files.",
      "file",
    );
  const name = file.name.toLowerCase();
  let table: string[][];
  if (name.endsWith(".csv")) {
    table = parseCsv(file.bytes.toString("utf8"));
  } else if (name.endsWith(".xlsx")) {
    try {
      const sheet = await readSheet(file.bytes);
      table = sheet.map((row) => row.map(cellToText)).filter((r) => r.some((c) => c !== ""));
    } catch {
      throw new DomainError(
        "file_unreadable",
        "We could not read this Excel file. Save it again as .xlsx or .csv and retry.",
        "file",
      );
    }
  } else {
    throw new DomainError("file_type", "Choose an Excel (.xlsx) or CSV (.csv) file.", "file");
  }
  const [headers, ...rows] = table;
  if (!headers || rows.length === 0)
    throw new DomainError("file_empty", "The file has no student rows below the header row.", "file");
  if (rows.length > MAX_ROWS)
    throw new DomainError(
      "file_too_many_rows",
      `The file has ${rows.length} rows. Import up to ${MAX_ROWS} at a time.`,
      "file",
    );
  const width = headers.length;
  return {
    headers: headers.map((h) => h.trim()),
    rows: rows.map((r) => Array.from({ length: width }, (_, i) => (r[i] ?? "").trim())),
  };
}

/** Matches file columns to fields by their header names. Each column is used at most once. */
export function autoMapColumns(headers: string[]): ColumnMapping {
  const normalised = headers.map(normaliseHeader);
  const used = new Set<number>();
  const mapping: ColumnMapping = {};
  for (const field of IMPORT_FIELDS) {
    const index = normalised.findIndex(
      (h, i) => !used.has(i) && (field.aliases as readonly string[]).includes(h),
    );
    mapping[field.key] = index >= 0 ? index : null;
    if (index >= 0) used.add(index);
  }
  return mapping;
}

/** Accepts F/M, Female/Male, Girl/Boy (any case). */
export function parseSex(value: string): "female" | "male" | null {
  const v = value.trim().toLowerCase();
  if (["f", "female", "girl", "g"].includes(v)) return "female";
  if (["m", "male", "boy", "b"].includes(v)) return "male";
  return null;
}

/** Accepts YYYY-MM-DD and day-first dates as written in Ghana: 14/03/2018, 14-3-2018, 14.03.2018. */
export function parseDate(value: string): string | null {
  const v = value.trim();
  let y: number, m: number, d: number;
  const iso = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  const dayFirst = v.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (iso) [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else if (dayFirst) [d, m, y] = [Number(dayFirst[1]), Number(dayFirst[2]), Number(dayFirst[3])];
  else return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

const RELATIONSHIP_ALIASES: Record<string, AddGuardianInput["relationship"]> = {
  mother: "mother",
  mum: "mother",
  mom: "mother",
  mama: "mother",
  maame: "mother",
  father: "father",
  dad: "father",
  papa: "father",
  daddy: "father",
  guardian: "guardian",
  parent: "guardian",
  grandmother: "grandparent",
  grandfather: "grandparent",
  grandparent: "grandparent",
  grandma: "grandparent",
  grandpa: "grandparent",
  brother: "sibling",
  sister: "sibling",
  sibling: "sibling",
};

/** Phone numbers saved as numbers in Excel lose their leading 0 (e.g. 241234567); restore it. */
function parseImportPhone(value: string): string | null {
  const v = value.replace(/\.0$/, "").trim();
  if (/^[25]\d{8}$/.test(v)) return normalizePhone(`0${v}`);
  return normalizePhone(v);
}

export interface RowProblem {
  /** Row number as shown in the spreadsheet (the header is row 1). */
  row: number;
  field: string;
  message: string;
}

interface ValidRow {
  row: number;
  admissionNumber: string | null;
  firstName: string;
  otherNames: string | null;
  lastName: string;
  sex: "female" | "male";
  dateOfBirth: string | null;
  classId: string | null;
  guardian: AddGuardianInput | null;
}

export interface ImportCheck {
  total: number;
  valid: number;
  problems: RowProblem[];
}

function getter(row: string[], mapping: ColumnMapping) {
  return (key: FieldKey) => {
    const index = mapping[key];
    return index === null || index === undefined ? "" : (row[index] ?? "").trim();
  };
}

async function checkRows(
  tx: Transaction,
  ctx: TenantContext,
  parsed: ParsedFile,
  mapping: ColumnMapping,
): Promise<{ valid: ValidRow[]; problems: RowProblem[] }> {
  const missing = IMPORT_FIELDS.filter(
    (f) => f.required && (mapping[f.key] === null || mapping[f.key] === undefined),
  );
  if (missing.length) {
    throw new DomainError(
      "mapping_incomplete",
      `Choose a column for: ${missing.map((f) => f.label).join(", ")}.`,
    );
  }
  const classRows = await tx
    .select({ id: classes.id, name: classes.name, campusId: classes.campusId })
    .from(classes)
    .where(and(eq(classes.tenantId, ctx.tenant.id), eq(classes.status, "active")));
  const classByName = new Map(
    classRows
      .filter((c) => ctx.campusIds === null || ctx.campusIds.includes(c.campusId))
      .map((c) => [c.name.toLowerCase().replace(/\s+/g, " "), c.id]),
  );
  const [term] = await tx
    .select({ id: terms.id })
    .from(terms)
    .where(and(eq(terms.tenantId, ctx.tenant.id), eq(terms.isCurrent, true)));

  const fileNumbers = parsed.rows
    .map((r) => getter(r, mapping)("admissionNumber").toLowerCase())
    .filter(Boolean);
  const existing = fileNumbers.length
    ? new Set(
        (
          await tx
            .select({ n: students.admissionNumber })
            .from(students)
            .where(
              and(
                eq(students.tenantId, ctx.tenant.id),
                inArray(students.admissionNumber, [...new Set(fileNumbers)]),
              ),
            )
        ).map((r) => r.n.toLowerCase()),
      )
    : new Set<string>();
  const seen = new Set<string>();

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
    else if (firstName.length > 60) problem("First name", "First name is longer than 60 characters.");
    if (!lastName) problem("Surname", "Surname is empty.");
    else if (lastName.length > 60) problem("Surname", "Surname is longer than 60 characters.");
    const otherNames = get("otherNames") || null;

    const sexText = get("sex");
    const sex = parseSex(sexText);
    if (!sex)
      problem(
        "Sex",
        sexText ? `“${sexText}” is not a sex we recognise. Use F or M.` : "Sex is empty. Use F or M.",
      );

    const dobText = get("dateOfBirth");
    const dateOfBirth = dobText ? parseDate(dobText) : null;
    if (dobText && !dateOfBirth)
      problem("Date of birth", `“${dobText}” is not a date. Use day/month/year, e.g. 14/03/2018.`);
    else if (dateOfBirth && dateOfBirth >= new Date().toISOString().slice(0, 10))
      problem("Date of birth", "The date of birth is in the future.");

    const admissionNumber = get("admissionNumber") || null;
    if (admissionNumber) {
      const key = admissionNumber.toLowerCase();
      if (admissionNumber.length > 30)
        problem("Admission number", "Admission number is longer than 30 characters.");
      else if (existing.has(key))
        problem("Admission number", `A student with admission number ${admissionNumber} already exists.`);
      else if (seen.has(key))
        problem(
          "Admission number",
          `Admission number ${admissionNumber} appears more than once in the file.`,
        );
      seen.add(key);
    }

    const className = get("className");
    let classId: string | null = null;
    if (className) {
      classId = classByName.get(className.toLowerCase().replace(/\s+/g, " ")) ?? null;
      if (!classId)
        problem("Class", `There is no class called “${className}”. Check the spelling on the Classes page.`);
      else if (!term)
        problem("Class", "Set the current term in Settings → Calendar before placing students in classes.");
    }

    const guardianName = get("guardianName");
    const guardianPhoneText = get("guardianPhone");
    let guardian: AddGuardianInput | null = null;
    if (guardianName || guardianPhoneText) {
      const phone = guardianPhoneText ? parseImportPhone(guardianPhoneText) : null;
      if (guardianPhoneText && !phone)
        problem(
          "Guardian phone",
          `“${guardianPhoneText}” is not a phone number we recognise, e.g. 024 123 4567.`,
        );
      if (!guardianName) problem("Guardian name", "Guardian name is empty but a phone number was given.");
      else if (guardianName.length < 2 || guardianName.length > 120)
        problem("Guardian name", "Guardian name must be 2 to 120 characters.");
      if (!guardianPhoneText)
        problem(
          "Guardian phone",
          "Guardian phone is empty. Add a number so the school can reach the family.",
        );
      const relText = get("guardianRelationship").toLowerCase();
      const relationship = relText ? RELATIONSHIP_ALIASES[relText] : "guardian";
      if (relText && !relationship)
        problem(
          "Relationship",
          `“${get("guardianRelationship")}” is not a relationship we recognise. Use mother, father, guardian, grandparent or sibling.`,
        );
      if (phone && guardianName)
        guardian = {
          fullName: guardianName,
          phone,
          email: null,
          relationship: relationship ?? "guardian",
          isPrimary: true,
        };
    }

    if (rowProblems.length) problems.push(...rowProblems);
    else
      valid.push({
        row,
        admissionNumber,
        firstName,
        otherNames,
        lastName,
        sex: sex!,
        dateOfBirth,
        classId: classId && term ? classId : null,
        guardian,
      });
  });
  return { valid, problems };
}

/** Checks every row without saving anything. */
export async function checkStudentImport(
  database: Database,
  ctx: TenantContext,
  parsed: ParsedFile,
  mapping: ColumnMapping,
): Promise<ImportCheck> {
  assertCan(ctx.roles, "students.manage");
  if (parsed.rows.length > MAX_ROWS)
    throw new DomainError("file_too_many_rows", `Import up to ${MAX_ROWS} rows at a time.`);
  return withTenant(database, { tenantId: ctx.tenant.id, userId: ctx.userId }, async (tx) => {
    const { valid, problems } = await checkRows(tx, ctx, parsed, mapping);
    return { total: parsed.rows.length, valid: valid.length, problems };
  });
}

/**
 * Imports the rows that pass the checks, all in one transaction (rows with problems are left out and
 * reported). Guardians are shared by phone number, so siblings in the file are linked automatically.
 */
export async function importStudents(
  database: Database,
  ctx: TenantContext,
  parsed: ParsedFile,
  mapping: ColumnMapping,
): Promise<{ imported: number; skipped: number; problems: RowProblem[] }> {
  assertCan(ctx.roles, "students.manage");
  if (parsed.rows.length > MAX_ROWS)
    throw new DomainError("file_too_many_rows", `Import up to ${MAX_ROWS} rows at a time.`);
  return withTenant(database, { tenantId: ctx.tenant.id, userId: ctx.userId }, async (tx) => {
    // Serialise imports per school so admission numbers and guardian links cannot race.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${"student-import:" + ctx.tenant.id}, 0))`,
    );
    const { valid, problems } = await checkRows(tx, ctx, parsed, mapping);
    const [term] = await tx
      .select({ id: terms.id })
      .from(terms)
      .where(and(eq(terms.tenantId, ctx.tenant.id), eq(terms.isCurrent, true)));
    const admittedOn = new Date().toISOString().slice(0, 10);
    for (const row of valid) {
      const admissionNumber = row.admissionNumber ?? (await nextAdmissionNumber(tx, ctx.tenant.id));
      const [student] = await tx
        .insert(students)
        .values({
          tenantId: ctx.tenant.id,
          admissionNumber,
          firstName: row.firstName,
          otherNames: row.otherNames,
          lastName: row.lastName,
          sex: row.sex,
          dateOfBirth: row.dateOfBirth,
          admittedOn,
        })
        .returning({ id: students.id });
      if (row.classId && term) {
        await tx
          .insert(enrolments)
          .values({ tenantId: ctx.tenant.id, studentId: student!.id, termId: term.id, classId: row.classId });
      }
      if (row.guardian) await linkGuardianInTx(tx, ctx, student!.id, row.guardian);
    }
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "students.imported",
      entityType: "student",
      metadata: { imported: valid.length, skipped: parsed.rows.length - valid.length },
    });
    return { imported: valid.length, skipped: parsed.rows.length - valid.length, problems };
  });
}

/** The template's header row, in the order schools usually keep their registers. */
export const TEMPLATE_HEADERS = IMPORT_FIELDS.map((f) => f.label);
