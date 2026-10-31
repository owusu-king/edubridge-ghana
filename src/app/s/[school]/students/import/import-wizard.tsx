"use client";

import type { Route } from "next";
import Link from "next/link";
import { useState, useTransition } from "react";
import { Download, Upload } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button, buttonStyles } from "@/components/ui/button";
import { Field, Select } from "@/components/ui/field";
import { Section } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { useFormAction } from "@/components/ui/use-form-action";
import type { ColumnMapping, FieldKey, ImportCheck, RowProblem } from "@/server/imports/students";
import type { FormState } from "@/web/forms";
import type { ActionResult, Uploaded } from "./actions";

type Field = { key: FieldKey; label: string; required: boolean };

interface Props {
  fields: Field[];
  studentsHref: Route;
  upload: (prev: FormState<Uploaded>, formData: FormData) => Promise<FormState<Uploaded>>;
  check: (
    parsed: { headers: string[]; rows: string[][] },
    mapping: ColumnMapping,
  ) => Promise<ActionResult<ImportCheck>>;
  runImport: (
    parsed: { headers: string[]; rows: string[][] },
    mapping: ColumnMapping,
  ) => Promise<ActionResult<{ imported: number; skipped: number; problems: RowProblem[] }>>;
}

const SHOW_PROBLEMS = 200;

function Problems({ problems }: { problems: RowProblem[] }) {
  if (problems.length === 0) return null;
  return (
    <div className="space-y-2">
      <TableFrame>
        <Table>
          <caption className="sr-only">Rows with problems</caption>
          <THead>
            <tr>
              <TH numeric>Row</TH>
              <TH>Column</TH>
              <TH>Problem</TH>
            </tr>
          </THead>
          <TBody>
            {problems.slice(0, SHOW_PROBLEMS).map((p, i) => (
              <TR key={`${p.row}-${p.field}-${i}`}>
                <TD numeric>{p.row}</TD>
                <TD className="whitespace-nowrap text-ink">{p.field}</TD>
                <TD>{p.message}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </TableFrame>
      {problems.length > SHOW_PROBLEMS && (
        <p className="text-sm text-ink-3">And {problems.length - SHOW_PROBLEMS} more problems not shown.</p>
      )}
    </div>
  );
}

export function ImportWizard({ fields, studentsHref, upload, check, runImport }: Props) {
  const { state: uploadState, pending: uploading, onSubmit } = useFormAction<Uploaded>(upload);
  const [file, setFile] = useState<Uploaded | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [step, setStep] = useState<"upload" | "map" | "review" | "done">("upload");
  const [checked, setChecked] = useState<ImportCheck | null>(null);
  const [result, setResult] = useState<{ imported: number; skipped: number; problems: RowProblem[] } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();

  // Move to the mapping step once a file has been read.
  if (uploadState.status === "success" && uploadState.data && file !== uploadState.data) {
    setFile(uploadState.data);
    setMapping(uploadState.data.mapping);
    setStep("map");
    setError(null);
  }

  const parsed = file ? { headers: file.headers, rows: file.rows } : null;
  const restart = () => {
    setFile(null);
    setStep("upload");
    setChecked(null);
    setResult(null);
    setError(null);
  };

  if (step === "upload" || !file || !parsed) {
    return (
      <div className="grid gap-10 lg:grid-cols-[1fr_20rem]">
        <Section
          title="1. Upload your file"
          description="Excel (.xlsx) or CSV, up to 2,000 students and 2 MB."
        >
          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            {uploadState.status === "error" && <Alert tone="critical">{uploadState.message}</Alert>}
            <Field label="Spreadsheet file">
              {(p) => (
                <input
                  {...p}
                  name="file"
                  type="file"
                  accept=".xlsx,.csv"
                  required
                  className="block w-full text-base text-ink-2 file:mr-3 file:rounded-md file:border file:border-line-strong file:bg-surface file:px-3 file:py-2 file:text-base file:font-medium file:text-ink"
                />
              )}
            </Field>
            <Button type="submit" pending={uploading}>
              <Upload aria-hidden="true" />
              Read file
            </Button>
          </form>
        </Section>
        <Section title="Before you start">
          <ul className="list-disc space-y-2 pl-5 text-base text-ink-2">
            <li>One student per row, with a heading row at the top.</li>
            <li>First name, surname and sex are needed. Sex can be F or M.</li>
            <li>Class names must match the names on your Classes page.</li>
            <li>Write dates as day/month/year, e.g. 14/03/2018.</li>
            <li>Brothers and sisters with the same guardian phone number are linked automatically.</li>
          </ul>
          <a
            href="/templates/students-import.csv"
            download
            className={buttonStyles("secondary", "md", "mt-2")}
          >
            <Download aria-hidden="true" />
            Download template
          </a>
        </Section>
      </div>
    );
  }

  if (step === "map") {
    const options = file.headers.map((h, i) => ({ value: String(i), label: h || `Column ${i + 1}` }));
    const sample = file.rows[0] ?? [];
    return (
      <Section
        title="2. Match your columns"
        description={`${file.fileName} · ${file.rows.length} ${file.rows.length === 1 ? "row" : "rows"}. We matched what we could; check each one.`}
      >
        {error && <Alert tone="critical">{error}</Alert>}
        <TableFrame>
          <Table>
            <caption className="sr-only">Column matching</caption>
            <THead>
              <tr>
                <TH>EduBridge field</TH>
                <TH>Column in your file</TH>
                <TH className="hidden sm:table-cell">First row</TH>
              </tr>
            </THead>
            <TBody>
              {fields.map((f) => {
                const value = mapping[f.key];
                return (
                  <TR key={f.key}>
                    <TD className="font-medium text-ink">
                      {f.label}
                      {f.required && <span className="ml-1 text-sm font-normal text-ink-3">(needed)</span>}
                    </TD>
                    <TD>
                      <label htmlFor={`map-${f.key}`} className="sr-only">
                        Column for {f.label}
                      </label>
                      <Select
                        id={`map-${f.key}`}
                        value={value === null || value === undefined ? "" : String(value)}
                        onChange={(e) =>
                          setMapping({
                            ...mapping,
                            [f.key]: e.target.value === "" ? null : Number(e.target.value),
                          })
                        }
                      >
                        <option value="">Not in my file</option>
                        {options.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </Select>
                    </TD>
                    <TD className="hidden max-w-[12rem] truncate sm:table-cell">
                      {value === null || value === undefined ? (
                        <span className="text-ink-3">—</span>
                      ) : (
                        sample[value] || <span className="text-ink-3">empty</span>
                      )}
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        </TableFrame>
        <div className="flex justify-between gap-2">
          <Button variant="secondary" onClick={restart}>
            Choose another file
          </Button>
          <Button
            pending={busy}
            onClick={() =>
              startTransition(async () => {
                const res = await check(parsed, mapping);
                if (res.ok) {
                  setChecked(res.data);
                  setError(null);
                  setStep("review");
                } else setError(res.message);
              })
            }
          >
            Check rows
          </Button>
        </div>
      </Section>
    );
  }

  if (step === "review" && checked) {
    const bad = checked.total - checked.valid;
    return (
      <Section title="3. Review and import">
        {error && <Alert tone="critical">{error}</Alert>}
        <Alert tone={bad ? "info" : "positive"}>
          {checked.valid} of {checked.total} {checked.total === 1 ? "row is" : "rows are"} ready to import.
          {bad > 0 &&
            ` ${bad} ${bad === 1 ? "row has" : "rows have"} problems and will be left out. Fix them in your file and import it again; rows already imported will be reported as existing.`}
        </Alert>
        <Problems problems={checked.problems} />
        <div className="flex justify-between gap-2">
          <Button variant="secondary" onClick={() => setStep("map")}>
            Back to columns
          </Button>
          <Button
            disabled={checked.valid === 0}
            pending={busy}
            onClick={() =>
              startTransition(async () => {
                const res = await runImport(parsed, mapping);
                if (res.ok) {
                  setResult(res.data);
                  setStep("done");
                } else setError(res.message);
              })
            }
          >
            Import {checked.valid} {checked.valid === 1 ? "student" : "students"}
          </Button>
        </div>
      </Section>
    );
  }

  return (
    <Section title="Import complete">
      <Alert tone="positive">
        {result?.imported} {result?.imported === 1 ? "student was" : "students were"} imported.
        {result &&
          result.skipped > 0 &&
          ` ${result.skipped} ${result.skipped === 1 ? "row was" : "rows were"} left out.`}
      </Alert>
      {result && <Problems problems={result.problems} />}
      <div className="flex gap-2">
        <Link href={studentsHref} className={buttonStyles("primary")}>
          View students
        </Link>
        <Button variant="secondary" onClick={restart}>
          Import another file
        </Button>
      </div>
    </Section>
  );
}
