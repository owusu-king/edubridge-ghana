import "server-only";
import { readSheet } from "read-excel-file/node";
import { DomainError } from "../errors";
import { parseCsv } from "@/lib/csv";
import { countryProfile } from "@/lib/countries";
import { normalizePhone } from "@/lib/phone";

/**
 * What every spreadsheet import shares (students, staff, opening balances): reading a .csv or .xlsx file into text
 * rows, matching its columns to fields by their headings, and reading the values schools type: dates written day
 * first, F or M, and phone numbers that Excel saved without their leading 0.
 */

export const MAX_ROWS = 2000;
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

export interface ParsedFile {
  headers: string[];
  rows: string[][];
}

/** A field an import fills, with the headings schools use for it. */
export interface ImportField<K extends string = string> {
  key: K;
  label: string;
  required: boolean;
  aliases: readonly string[];
}

/** Field → column index in the file (null when the file has no such column). */
export type ColumnMapping<K extends string = string> = Partial<Record<K, number | null>>;

export interface RowProblem {
  /** Row number as shown in the spreadsheet (the header is row 1). */
  row: number;
  field: string;
  message: string;
}

export interface ImportCheck {
  total: number;
  valid: number;
  problems: RowProblem[];
}

const normaliseHeader = (h: string) => h.toLowerCase().replace(/[_*]+/g, " ").replace(/\s+/g, " ").trim();

function cellToText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).trim();
}

/** Reads a .csv or .xlsx file into a header row and data rows of text. `what` names the rows ("student"). */
export async function parseImportFile(
  file: { name: string; size: number; bytes: Buffer },
  what = "student",
): Promise<ParsedFile> {
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
    throw new DomainError("file_empty", `The file has no ${what} rows below the header row.`, "file");
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
export function mapColumns<K extends string>(
  headers: string[],
  fields: readonly ImportField<K>[],
): ColumnMapping<K> {
  const normalised = headers.map(normaliseHeader);
  const used = new Set<number>();
  const mapping: ColumnMapping<K> = {};
  for (const field of fields) {
    const index = normalised.findIndex((h, i) => !used.has(i) && field.aliases.includes(h));
    mapping[field.key] = index >= 0 ? index : null;
    if (index >= 0) used.add(index);
  }
  return mapping;
}

/** Refuses a mapping that leaves a needed field without a column. */
export function assertMappingComplete<K extends string>(
  fields: readonly ImportField<K>[],
  mapping: ColumnMapping<K>,
): void {
  const missing = fields.filter(
    (f) => f.required && (mapping[f.key] === null || mapping[f.key] === undefined),
  );
  if (missing.length)
    throw new DomainError(
      "mapping_incomplete",
      `Choose a column for: ${missing.map((f) => f.label).join(", ")}.`,
    );
}

/** Reads a row's cell for a field, as trimmed text ("" when the file has no such column). */
export function getter<K extends string>(row: string[], mapping: ColumnMapping<K>) {
  return (key: K) => {
    const index = mapping[key];
    return index === null || index === undefined ? "" : (row[index] ?? "").trim();
  };
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

/** Phone numbers saved as numbers in Excel lose their leading 0 (e.g. 241234567); restore it, in the school's country. */
export function parseImportPhone(value: string, country: string): string | null {
  const v = value.replace(/\.0$/, "").trim();
  // Restoring the lost 0 only where national numbers start with one.
  if (countryProfile(country).trunkZero && countryProfile(country).mobile.test(v))
    return normalizePhone(`0${v}`, country);
  return normalizePhone(v, country);
}
