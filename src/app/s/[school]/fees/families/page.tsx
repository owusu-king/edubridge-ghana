import type { Metadata } from "next";
import Link from "next/link";
import { Users } from "lucide-react";
import { EmptyState, Section } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { db } from "@/server/db/client";
import { listFamilies } from "@/server/fees/concessions";
import { formatPhone } from "@/lib/phone";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";

export const metadata: Metadata = { title: "Fees · Families" };

export default async function FamiliesPage({ params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  const slug = ctx.tenant.slug;
  const families = await listFamilies(db(), ctx);

  return (
    <Section
      title="Families with more than one child"
      description="Children who share a parent or guardian. To give a sibling discount, open a child and add it under Fees."
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
                          <span className="block font-mono text-xs text-ink-3">{child.admissionNumber}</span>
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
  );
}
