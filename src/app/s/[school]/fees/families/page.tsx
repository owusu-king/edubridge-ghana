import type { Metadata } from "next";
import Link from "next/link";
import { Users } from "lucide-react";
import { EmptyState, Section } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { db } from "@/server/db/client";
import { allowed } from "@/server/authz/permissions";
import { formatPercent, listFamilies } from "@/server/fees/concessions";
import { getSiblingRule, previewSiblingDiscounts } from "@/server/fees/siblings";
import { listFeeItems } from "@/server/fees/structure";
import { FIRST_CHILD_LABELS, ordinalPlace } from "@/lib/siblings";
import { formatPhone } from "@/lib/phone";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { applySiblingDiscountsAction, saveSiblingRuleAction } from "./actions";
import { ApplySiblingDiscounts, SiblingRuleForm } from "./sibling-controls";

export const metadata: Metadata = { title: "Fees · Families" };

export default async function FamiliesPage({ params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  const slug = ctx.tenant.slug;
  const canManage = allowed(ctx, "fees.manage") && ctx.campusIds === null;
  const [families, rule, changes, items] = await Promise.all([
    listFamilies(db(), ctx),
    getSiblingRule(db(), ctx),
    previewSiblingDiscounts(db(), ctx),
    canManage ? listFeeItems(db(), ctx) : Promise.resolve([]),
  ]);
  const pending = changes.filter((c) => c.change !== "keep");
  const count = (kind: string) => changes.filter((c) => c.change === kind).length;
  const describe = (c: (typeof changes)[number]) =>
    c.change === "end"
      ? `Ends: ${c.current!.label}`
      : `${formatPercent(c.proposed!.percentBasisPoints)} as the ${ordinalPlace(c.proposed!.place)} child${c.change === "replace" ? " (changed)" : ""}`;

  return (
    <div className="space-y-12">
      <Section
        title="Sibling discount"
        description={
          rule.configured
            ? `${FIRST_CHILD_LABELS[rule.firstChild]} pays in full; the second child gets ${rule.secondPercentBasisPoints ? formatPercent(rule.secondPercentBasisPoints) : "no discount"}${rule.laterPercentBasisPoints ? `, later children ${formatPercent(rule.laterPercentBasisPoints)}` : ""}.`
            : "Set how your school gives sibling discounts: who pays in full, and the discount for the second and later children."
        }
        aside={
          canManage &&
          pending.length > 0 && (
            <ApplySiblingDiscounts
              action={applySiblingDiscountsAction.bind(null, slug)}
              added={count("add")}
              replaced={count("replace")}
              ended={count("end")}
            />
          )
        }
      >
        {canManage && (
          <SiblingRuleForm
            action={saveSiblingRuleAction.bind(null, slug)}
            feeItems={items.filter((i) => i.status === "active").map((i) => ({ id: i.id, name: i.name }))}
            defaults={{
              firstChild: rule.firstChild,
              secondPercent: rule.secondPercentBasisPoints
                ? formatPercent(rule.secondPercentBasisPoints).replace("%", "")
                : "",
              laterPercent: rule.laterPercentBasisPoints
                ? formatPercent(rule.laterPercentBasisPoints).replace("%", "")
                : "",
              feeItemId: rule.feeItemId ?? "",
            }}
          />
        )}
        {pending.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-base font-semibold text-ink">Waiting to be applied</h3>
            <TableFrame>
              <Table>
                <caption className="sr-only">Sibling discount changes waiting to be applied</caption>
                <THead>
                  <tr>
                    <TH>Child</TH>
                    <TH className="hidden sm:table-cell">Class</TH>
                    <TH>Change</TH>
                  </tr>
                </THead>
                <TBody>
                  {pending.map((c) => (
                    <TR key={c.studentId}>
                      <TD className="text-ink">{c.name || c.admissionNumber || "A former student"}</TD>
                      <TD className="hidden sm:table-cell">
                        {c.className ?? <span className="text-ink-3">—</span>}
                      </TD>
                      <TD>{describe(c)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableFrame>
          </div>
        )}
      </Section>
      <Section
        title="Families with more than one child"
        description="Children who share a parent or guardian. A discount for one child can also be added by hand from the child's page."
      >
        {families.length === 0 ? (
          <EmptyState
            icon={<Users />}
            title="No families with more than one child"
            description="Families appear here when two or more active students share a guardian."
          />
        ) : (
          <div className="space-y-6">
            {families.map((family) => (
              <section
                key={family.guardianId}
                aria-labelledby={`family-${family.guardianId}`}
                className="space-y-2"
              >
                <h3 id={`family-${family.guardianId}`} className="text-base font-semibold text-ink">
                  {family.guardianName}
                  {family.phone && (
                    <span className="font-normal text-ink-3"> · {formatPhone(family.phone)}</span>
                  )}
                </h3>
                <TableFrame>
                  <Table>
                    <caption className="sr-only">Children of {family.guardianName}</caption>
                    <THead>
                      <tr>
                        <TH>Child</TH>
                        <TH className="hidden sm:table-cell">Class</TH>
                        <TH>Scholarships and discounts</TH>
                      </tr>
                    </THead>
                    <TBody>
                      {family.children.map((child) => (
                        <TR key={child.id}>
                          <TD>
                            <Link
                              href={schoolPath(slug, `students/${child.id}`)}
                              className="font-medium text-ink hover:underline"
                            >
                              {child.name}
                            </Link>
                            <span className="block font-mono text-xs text-ink-3">
                              {child.admissionNumber}
                            </span>
                          </TD>
                          <TD className="hidden sm:table-cell">
                            {child.className ?? <span className="text-ink-3">Not in a class</span>}
                          </TD>
                          <TD>
                            {child.concessions.length ? (
                              child.concessions.join(", ")
                            ) : (
                              <span className="text-ink-3">None</span>
                            )}
                          </TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                </TableFrame>
              </section>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}
