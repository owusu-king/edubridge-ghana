"use client";

import type { Route } from "next";
import Link from "next/link";
import { useState, useTransition } from "react";
import { Download, Upload } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button, buttonStyles } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { useFormAction } from "@/components/ui/use-form-action";
import { formatCedis } from "@/lib/money";
import type { ParsedFile } from "@/server/imports/students";
import type { FormState } from "@/web/forms";
import type { CheckedFile, ImportResult } from "./actions";

export function BalancesImport({
  check,
  runImport,
  defaultAsOf,
  accountsHref,
}: {
  check: (prev: FormState<CheckedFile>, formData: FormData) => Promise<FormState<CheckedFile>>;
  runImport: (parsed: ParsedFile, asOf: string) => Promise<ImportResult>;
  defaultAsOf: string;
  accountsHref: Route;
}) {
  const { state, pending, onSubmit } = useFormAction<CheckedFile>(check);
  const [asOf, setAsOf] = useState(defaultAsOf);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [importing, startImport] = useTransition();
  const checked = state.status === "success" ? state.data : undefined;

  if (result?.ok) {
    return (
      <div className="space-y-4">
        <Alert tone="positive">
          {result.imported} opening {result.imported === 1 ? "balance" : "balances"} recorded.
        </Alert>
        <Link href={accountsHref} className={buttonStyles("primary")}>
          View accounts
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <form onSubmit={onSubmit} className="space-y-5" noValidate>
        <p className="text-base text-ink-2">
          Use a spreadsheet with an <strong className="font-medium text-ink">Admission number</strong> column
          and a <strong className="font-medium text-ink">Balance</strong> column. Write credits as negative
          amounts (-120), in brackets, or with CR.{" "}
          <a
            href="/templates/opening-balances.csv"
            download
            className="inline-flex items-center gap-1 text-accent hover:underline"
          >
            <Download aria-hidden="true" className="size-4" />
            Download the template
          </a>
        </p>
        {state.status === "error" && !state.fieldErrors?.file && (
          <Alert tone="critical">{state.message}</Alert>
        )}
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Spreadsheet (.xlsx or .csv)" error={state.fieldErrors?.file}>
            {(p) => <Input {...p} name="file" type="file" accept=".xlsx,.csv" required className="pt-2" />}
          </Field>
          <Field label="Balances as of" description="Usually the day before this term began.">
            {(p) => (
              <Input {...p} type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} required />
            )}
          </Field>
        </div>
        <Button type="submit" variant={checked ? "secondary" : "primary"} pending={pending}>
          <Upload aria-hidden="true" />
          Check file
        </Button>
      </form>

      {checked && (
        <section aria-labelledby="check-heading" className="space-y-4 border-t border-line pt-6">
          <h2 id="check-heading" className="text-md font-semibold text-ink">
            {checked.fileName}
          </h2>
          <ul className="space-y-1 text-base text-ink-2">
            <li>
              <span className="font-medium text-ink">{checked.check.ready.length}</span> balances ready to
              record: {formatCedis(checked.check.owedPesewas)} owed and{" "}
              {formatCedis(checked.check.creditPesewas)} in credit.
            </li>
            {checked.check.alreadySet > 0 && (
              <li>
                {checked.check.alreadySet} students already have an opening balance and will be left as they
                are.
              </li>
            )}
            {checked.check.zero > 0 && (
              <li>{checked.check.zero} rows have a zero balance and are skipped.</li>
            )}
            {checked.check.problems.length > 0 && (
              <li>
                {checked.check.problems.length} rows have problems and are skipped. Fix them and check the
                file again.
              </li>
            )}
          </ul>
          {checked.check.problems.length > 0 && (
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
                  {checked.check.problems.slice(0, 200).map((p, i) => (
                    <TR key={`${p.row}-${i}`}>
                      <TD numeric>{p.row}</TD>
                      <TD className="whitespace-nowrap text-ink">{p.field}</TD>
                      <TD>{p.message}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableFrame>
          )}
          {result && !result.ok && <Alert tone="critical">{result.message}</Alert>}
          {checked.check.ready.length > 0 && (
            <Button
              pending={importing}
              onClick={() =>
                startImport(async () => {
                  setResult(await runImport(checked.parsed, asOf));
                })
              }
            >
              Record {checked.check.ready.length} {checked.check.ready.length === 1 ? "balance" : "balances"}
            </Button>
          )}
        </section>
      )}
    </div>
  );
}
