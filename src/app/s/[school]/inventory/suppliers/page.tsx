import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ActionButton } from "@/components/ui/action-forms";
import { StatusText } from "@/components/ui/badge";
import { Section } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { listSuppliers } from "@/server/inventory/suppliers";
import { formatPhone } from "@/lib/phone";
import { requireTenant } from "@/web/auth";
import { saveSupplierAction, setSupplierArchivedAction } from "../actions";
import { SupplierDialog } from "../inventory-controls";

export const metadata: Metadata = { title: "Inventory · Suppliers" };

/** The school's suppliers (INV-02a). */
export default async function SuppliersPage({ params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "inventory.view")) notFound();
  const slug = ctx.tenant.slug;
  const manage = allowed(ctx, "inventory.manage");
  const suppliers = await listSuppliers(db(), ctx);

  return (
    <Section
      title="Suppliers"
      aside={manage ? <SupplierDialog action={saveSupplierAction.bind(null, slug, null)} /> : undefined}
    >
      {suppliers.length === 0 ? (
        <p className="text-base text-ink-3">No suppliers yet.</p>
      ) : (
        <TableFrame>
          <Table>
            <caption className="sr-only">Suppliers</caption>
            <THead>
              <tr>
                <TH>Supplier</TH>
                <TH className="hidden sm:table-cell">Contact</TH>
                {manage && (
                  <TH>
                    <span className="sr-only">Change</span>
                  </TH>
                )}
              </tr>
            </THead>
            <TBody>
              {suppliers.map((s) => (
                <TR key={s.id}>
                  <TD>
                    <span className="font-medium text-ink">{s.name}</span>
                    {s.note && <span className="block text-sm text-ink-3">{s.note}</span>}
                    {s.status === "archived" && <StatusText tone="neutral">Archived</StatusText>}
                  </TD>
                  <TD className="hidden sm:table-cell">
                    {[s.contactName, s.phone && formatPhone(s.phone), s.email].filter(Boolean).join(" · ") ||
                      "—"}
                  </TD>
                  {manage && (
                    <TD className="text-right">
                      <div className="inline-flex flex-wrap justify-end gap-2">
                        {s.status === "active" && (
                          <SupplierDialog
                            action={saveSupplierAction.bind(null, slug, s.id)}
                            supplier={{ ...s, phone: s.phone ? formatPhone(s.phone) : "" }}
                          />
                        )}
                        <ActionButton
                          action={setSupplierArchivedAction.bind(null, slug, s.id, s.status === "active")}
                          label={s.status === "active" ? "Archive" : "Restore"}
                          variant={s.status === "active" ? "danger-outline" : "secondary"}
                          ariaLabel={`${s.status === "active" ? "Archive" : "Restore"} ${s.name}`}
                        />
                      </div>
                    </TD>
                  )}
                </TR>
              ))}
            </TBody>
          </Table>
        </TableFrame>
      )}
    </Section>
  );
}
