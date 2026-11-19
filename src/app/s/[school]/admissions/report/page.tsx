import type { Metadata } from "next";
import { buttonStyles } from "@/components/ui/button";
import { Select } from "@/components/ui/field";
import { EmptyState, Section } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { admissionOptions, getAdmissionsReport, type FunnelRow } from "@/server/admissions/service";
import { db } from "@/server/db/client";
import { APPLICATION_SOURCE_LABELS, type ApplicationSource } from "@/lib/admissions";
import { requireTenant } from "@/web/auth";

export const metadata: Metadata = { title: "Admissions report" };

const pct = (n: number, of: number) => (of === 0 ? "—" : `${Math.round((n * 100) / of)}%`);

function FunnelTable({ rows, caption, first }: { rows: FunnelRow[]; caption: string; first: string }) {
  const sum = (k: keyof Omit<FunnelRow, "key" | "label">) => rows.reduce((a, r) => a + r[k], 0);
  return (
    <TableFrame>
      <Table>
        <caption className="sr-only">{caption}</caption>
        <THead>
          <tr>
            <TH>{first}</TH>
            <TH numeric>Inquiries and applications</TH>
            <TH numeric>Applied</TH>
            <TH numeric>Offered</TH>
            <TH numeric>Enrolled</TH>
            <TH numeric className="hidden sm:table-cell">
              Declined
            </TH>
            <TH numeric className="hidden sm:table-cell">
              Withdrew
            </TH>
            <TH numeric className="hidden md:table-cell">
              Offers taken up
            </TH>
          </tr>
        </THead>
        <TBody>
          {rows.map((r) => (
            <TR key={r.key}>
              <TD className="font-medium text-ink">{r.label}</TD>
              <TD numeric>{r.total}</TD>
              <TD numeric>{r.applied}</TD>
              <TD numeric>{r.offered}</TD>
              <TD numeric>{r.enrolled}</TD>
              <TD numeric className="hidden sm:table-cell">
                {r.declined}
              </TD>
              <TD numeric className="hidden sm:table-cell">
                {r.withdrawn}
              </TD>
              <TD numeric className="hidden md:table-cell">
                {pct(r.enrolled, r.offered)}
              </TD>
            </TR>
          ))}
          <TR>
            <TD className="font-semibold text-ink">All</TD>
            <TD numeric className="font-semibold">
              {sum("total")}
            </TD>
            <TD numeric className="font-semibold">
              {sum("applied")}
            </TD>
            <TD numeric className="font-semibold">
              {sum("offered")}
            </TD>
            <TD numeric className="font-semibold">
              {sum("enrolled")}
            </TD>
            <TD numeric className="hidden font-semibold sm:table-cell">
              {sum("declined")}
            </TD>
            <TD numeric className="hidden font-semibold sm:table-cell">
              {sum("withdrawn")}
            </TD>
            <TD numeric className="hidden font-semibold md:table-cell">
              {pct(sum("enrolled"), sum("offered"))}
            </TD>
          </TR>
        </TBody>
      </Table>
    </TableFrame>
  );
}

/** How families moved from inquiry to enrolment (ADM-08), by level and by how they came. */
export default async function AdmissionsReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ school: string }>;
  searchParams: Promise<{ term?: string }>;
}) {
  const [{ school }, search] = await Promise.all([params, searchParams]);
  const { ctx } = await requireTenant(school);
  const options = await admissionOptions(db(), ctx);
  const termId = options.terms.some((t) => t.id === search.term) ? search.term : undefined;
  const report = await getAdmissionsReport(db(), ctx, { termId });
  const bySource = report.bySource.map((r) => ({
    ...r,
    label: APPLICATION_SOURCE_LABELS[r.key as ApplicationSource],
  }));
  return (
    <div className="space-y-10">
      <form method="get" className="flex items-end gap-2" aria-label="Choose entry term">
        <div className="space-y-1.5">
          <label htmlFor="report-term" className="block text-sm font-medium text-ink">
            Starting term
          </label>
          <Select id="report-term" name="term" defaultValue={termId ?? ""} className="min-w-56">
            <option value="">Every term</option>
            {options.terms.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </div>
        <button type="submit" className={buttonStyles("secondary")}>
          Show
        </button>
      </form>
      {report.byLevel.length === 0 ? (
        <EmptyState
          title="No applications yet"
          description="The report fills in as inquiries and applications come in."
        />
      ) : (
        <>
          <Section
            title="By level"
            description="How many reached each stage. An applicant who withdrew after an offer still counts as offered."
          >
            <FunnelTable rows={report.byLevel} caption="Admissions by level" first="Level" />
          </Section>
          <Section title="By how families came" description="Where inquiries and applications came from.">
            <FunnelTable rows={bySource} caption="Admissions by source" first="Source" />
          </Section>
        </>
      )}
    </div>
  );
}
