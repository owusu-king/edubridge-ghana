import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { ActionButton } from "@/components/ui/action-forms";
import { Section } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { listPayComponents } from "@/server/payroll/service";
import { COMPONENT_BASIS_LABELS, COMPONENT_KIND_LABELS } from "@/lib/payroll";
import { requireTenant } from "@/web/auth";
import {
  addPayComponentAction,
  addSuggestedComponentsAction,
  setPayComponentArchivedAction,
} from "../actions";
import { ComponentDialog } from "../payroll-controls";

export const metadata: Metadata = { title: "Pay components" };

/** The school's pay components (PRL-01a). No statutory rates are built in. */
export default async function ComponentsPage({ params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "payroll.view")) notFound();
  const slug = ctx.tenant.slug;
  const components = await listPayComponents(db(), ctx);
  const canManage = allowed(ctx, "payroll.manage");

  return (
    <Section
      title="Pay components"
      description="Earnings, deductions and the school's own contributions. EduBridge has no built-in tax or pension rates: enter SSNIT, PAYE and others as your accountant advises, on each salary."
      aside={
        canManage && (
          <div className="flex flex-wrap gap-2">
            <ActionButton
              action={addSuggestedComponentsAction.bind(null, slug)}
              label="Add suggested names"
            />
            <ComponentDialog action={addPayComponentAction.bind(null, slug)} />
          </div>
        )
      }
    >
      {components.length === 0 ? (
        <p className="text-base text-ink-3">No components yet. A salary can still be basic pay alone.</p>
      ) : (
        <TableFrame>
          <Table>
            <caption className="sr-only">Pay components</caption>
            <THead>
              <tr>
                <TH>Name</TH>
                <TH>Kind</TH>
                <TH className="hidden sm:table-cell">Worked out as</TH>
                <TH>
                  <span className="sr-only">Actions</span>
                </TH>
              </tr>
            </THead>
            <TBody>
              {components.map((c) => (
                <TR key={c.id}>
                  <TD className={c.archived ? "text-ink-3" : undefined}>
                    {c.name}
                    {c.archived && (
                      <Badge tone="neutral" className="ml-2">
                        Archived
                      </Badge>
                    )}
                  </TD>
                  <TD>{COMPONENT_KIND_LABELS[c.kind]}</TD>
                  <TD className="hidden sm:table-cell">{COMPONENT_BASIS_LABELS[c.basis]}</TD>
                  <TD className="text-right">
                    {canManage && (
                      <ActionButton
                        action={setPayComponentArchivedAction.bind(null, slug, c.id, !c.archived)}
                        label={c.archived ? "Restore" : "Archive"}
                        variant={c.archived ? "secondary" : "danger-outline"}
                        ariaLabel={`${c.archived ? "Restore" : "Archive"} ${c.name}`}
                      />
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </TableFrame>
      )}
    </Section>
  );
}
