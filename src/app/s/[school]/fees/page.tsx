import type { Metadata } from "next";
import Link from "next/link";
import { Wallet } from "lucide-react";
import { buttonStyles } from "@/components/ui/button";
import { Select } from "@/components/ui/field";
import { EmptyState } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { can } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { getBillingStatus } from "@/server/fees/ledger";
import { getFeeStructure, listFeeTerms, type FeeTerm } from "@/server/fees/structure";
import { formatCedis, pesewasToInput } from "@/lib/money";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { billTermAction, copyFeeStructureAction, saveLevelFeesAction } from "./actions";
import { BillTermDialog, CopyStructureDialog, LevelFeesDialog } from "./fee-controls";

export const metadata: Metadata = { title: "Fees" };

const termLabel = (t: FeeTerm) => `${t.name}, ${t.yearName}`;

export default async function FeeStructurePage({
  params,
  searchParams,
}: {
  params: Promise<{ school: string }>;
  searchParams: Promise<{ term?: string }>;
}) {
  const [{ school }, search] = await Promise.all([params, searchParams]);
  const { ctx } = await requireTenant(school);
  const slug = ctx.tenant.slug;
  const canManage = can(ctx.roles, "fees.manage") && ctx.campusIds === null;
  const terms = await listFeeTerms(db(), ctx);

  if (terms.length === 0) {
    return (
      <EmptyState
        icon={<Wallet />}
        title="No terms yet"
        description="Fees are set per term. Add your academic year and its terms first."
        action={
          can(ctx.roles, "academics.manage") && (
            <Link href={schoolPath(slug, "settings/calendar")} className={buttonStyles("primary")}>
              Set up the calendar
            </Link>
          )
        }
      />
    );
  }

  const term = terms.find((t) => t.id === search.term) ?? terms.find((t) => t.isCurrent) ?? terms[0]!;
  const [structure, billing] = await Promise.all([
    getFeeStructure(db(), ctx, term.id),
    getBillingStatus(db(), ctx, term.id),
  ]);
  const activeItems = structure.items.filter((i) => i.status === "active");
  const copySources = terms.filter((t) => t.id !== term.id && t.lineCount > 0);
  const empty = term.lineCount === 0;

  const picker = (
    <form method="get" className="flex items-end gap-2" aria-label="Choose term">
      <div className="space-y-1.5">
        <label htmlFor="fee-term" className="block text-sm font-medium text-ink">
          Term
        </label>
        <Select id="fee-term" name="term" defaultValue={term.id} className="min-w-56">
          {terms.map((t) => (
            <option key={t.id} value={t.id}>
              {termLabel(t)}
              {t.isCurrent ? " (current)" : ""}
            </option>
          ))}
        </Select>
      </div>
      <button type="submit" className={buttonStyles("secondary")}>
        Show
      </button>
    </form>
  );

  if (structure.items.length === 0) {
    return (
      <EmptyState
        icon={<Wallet />}
        title="No fee items yet"
        description="Fee items are what you charge for, such as tuition and PTA dues. Add them first."
        action={
          <Link href={schoolPath(slug, "fees/items")} className={buttonStyles("primary")}>
            Add fee items
          </Link>
        }
      />
    );
  }
  if (structure.levels.length === 0) {
    return (
      <EmptyState
        icon={<Wallet />}
        title="No levels yet"
        description="Fees are set for each level, such as Basic 4. Set up your levels and classes first."
        action={
          <Link href={schoolPath(slug, "classes")} className={buttonStyles("primary")}>
            Go to classes
          </Link>
        }
      />
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        {picker}
        {canManage && empty && copySources.length > 0 && (
          <CopyStructureDialog
            action={copyFeeStructureAction.bind(null, slug, term.id)}
            terms={copySources.map((t) => ({ value: t.id, label: termLabel(t) }))}
          />
        )}
      </div>
      {empty && (
        <p className="text-base text-ink-2">
          No fees set for {termLabel(term)} yet.
          {canManage && " Set fees for each level, or copy them from another term."}
        </p>
      )}
      <TableFrame>
        <Table>
          <caption className="sr-only">Fees per level for {termLabel(term)}</caption>
          <THead>
            <tr>
              <TH>Level</TH>
              {structure.items.map((item) => (
                <TH key={item.id} className="hidden text-right lg:table-cell">
                  {item.name}
                </TH>
              ))}
              <TH className="text-right">Total per term</TH>
              {canManage && (
                <TH>
                  <span className="sr-only">Actions</span>
                </TH>
              )}
            </tr>
          </THead>
          <TBody>
            {structure.levels.map((level) => {
              const overrides = level.classes.filter((c) => c.total !== null);
              const hasAmounts = Object.keys(level.amounts).length > 0 || overrides.length > 0;
              const initial: Record<string, string> = {};
              for (const [itemId, amount] of Object.entries(level.amounts))
                initial[`amount:${itemId}`] = pesewasToInput(amount);
              for (const [classId, byItem] of Object.entries(level.classAmounts))
                for (const [itemId, amount] of Object.entries(byItem))
                  initial[`class:${classId}:${itemId}`] = pesewasToInput(amount);
              return (
                <TR key={level.id}>
                  <TD>
                    <span className="font-medium text-ink">{level.name}</span>
                    {overrides.map((c) => (
                      <span key={c.id} className="block text-sm text-ink-3">
                        {c.name}: {formatCedis(c.total!)}
                      </span>
                    ))}
                  </TD>
                  {structure.items.map((item) => (
                    <TD key={item.id} className="hidden text-right tabular-nums lg:table-cell">
                      {item.id in level.amounts ? (
                        formatCedis(level.amounts[item.id]!)
                      ) : (
                        <span className="text-ink-3">—</span>
                      )}
                    </TD>
                  ))}
                  <TD className="text-right font-medium text-ink tabular-nums">
                    {hasAmounts ? (
                      formatCedis(level.total)
                    ) : (
                      <span className="font-normal text-ink-3">Not set</span>
                    )}
                  </TD>
                  {canManage && (
                    <TD className="text-right whitespace-nowrap">
                      {activeItems.length > 0 && (
                        <LevelFeesDialog
                          action={saveLevelFeesAction.bind(null, slug, term.id, level.id)}
                          levelName={level.name}
                          termLabel={termLabel(term)}
                          items={activeItems.map((i) => ({ value: i.id, label: i.name }))}
                          classes={level.classes.map((c) => ({ value: c.id, label: c.name }))}
                          initial={initial}
                          hasAmounts={hasAmounts}
                        />
                      )}
                    </TD>
                  )}
                </TR>
              );
            })}
          </TBody>
        </Table>
      </TableFrame>
      {!empty && billing && (
        <section aria-labelledby="billing-heading" className="space-y-4 border-t border-line pt-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="space-y-1">
              <h2 id="billing-heading" className="text-md font-semibold text-ink">
                Billing
              </h2>
              <p className="text-base text-ink-2">
                {billing.enrolled === 0
                  ? "No students are placed in a class this term, so there is no one to bill yet."
                  : `${billing.billedStudents} of ${billing.enrolled} students billed for ${termLabel(term)}.`}
              </p>
              {billing.studentsToBill > 0 && (
                <p className="text-base text-ink-2">
                  {billing.studentsToBill} {billing.studentsToBill === 1 ? "student has" : "students have"}{" "}
                  charges still to bill: {formatCedis(billing.amountToBillPesewas)} in total.
                </p>
              )}
              <p className="text-sm text-ink-3">
                Billing charges each student what their class pays. Running it again only bills new students
                and new items; existing charges never change.
              </p>
            </div>
            {canManage && billing.studentsToBill > 0 && (
              <BillTermDialog
                action={billTermAction.bind(null, slug, term.id)}
                termLabel={termLabel(term)}
                students={billing.studentsToBill}
                amount={formatCedis(billing.amountToBillPesewas)}
              />
            )}
          </div>
          {billing.differenceCount > 0 && (
            <div className="space-y-2">
              <h3 className="text-base font-semibold text-ink">
                {billing.differenceCount}{" "}
                {billing.differenceCount === 1 ? "charge differs" : "charges differ"} from the fee structure
              </h3>
              <p className="text-sm text-ink-3">
                The fees changed, or the student moved class, after billing. To correct a charge, reverse it
                on the student&rsquo;s account, then bill again.
              </p>
              <TableFrame>
                <Table>
                  <caption className="sr-only">Charges that differ from the fee structure</caption>
                  <THead>
                    <tr>
                      <TH>Student</TH>
                      <TH>Item</TH>
                      <TH className="text-right">Billed</TH>
                      <TH className="text-right">Fee structure</TH>
                    </tr>
                  </THead>
                  <TBody>
                    {billing.differences.map((d) => (
                      <TR key={`${d.studentId}-${d.itemName}`}>
                        <TD>
                          <Link
                            href={schoolPath(slug, `students/${d.studentId}`)}
                            className="font-medium text-ink underline-offset-2 hover:underline"
                          >
                            {d.studentName}
                          </Link>
                          <span className="block font-mono text-sm text-ink-3">{d.admissionNumber}</span>
                        </TD>
                        <TD>{d.itemName}</TD>
                        <TD className="text-right tabular-nums">{formatCedis(d.billedPesewas)}</TD>
                        <TD className="text-right tabular-nums">{formatCedis(d.structurePesewas)}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </TableFrame>
            </div>
          )}
        </section>
      )}
      {!canManage && can(ctx.roles, "fees.manage") && (
        <p className="text-sm text-ink-3">
          Fees apply to the whole school, so they can only be changed by staff with access to every campus.
        </p>
      )}
    </div>
  );
}
