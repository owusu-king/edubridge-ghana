import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { Alert } from "@/components/ui/alert";
import { PageHeader } from "@/components/ui/layout";
import { SubNav } from "@/components/ui/sub-nav";
import { allowed } from "@/server/authz/permissions";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";

export default async function InventoryLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ school: string }>;
}) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  const view = allowed(ctx, "inventory.view");
  if (!view && !allowed(ctx, "maintenance.report")) notFound();
  const slug = ctx.tenant.slug;
  const items = view
    ? [
        { label: "Stock", href: schoolPath(slug, "inventory") },
        { label: "Assets", href: schoolPath(slug, "inventory/assets") },
        { label: "Purchases", href: schoolPath(slug, "inventory/purchases") },
        { label: "Maintenance", href: schoolPath(slug, "inventory/maintenance") },
        { label: "Suppliers", href: schoolPath(slug, "inventory/suppliers") },
      ]
    : [];
  return (
    <div className="space-y-8">
      <PageHeader
        title={view ? "Inventory" : "Maintenance"}
        description={
          view
            ? "Stock and what is used, the asset register, purchase requests, repairs and suppliers."
            : "Report anything at school that needs fixing, and follow what happens."
        }
      />
      {ctx.modules.inventory_assets?.state === "read_only" && (
        <Alert tone="info">
          Inventory and assets has ended for this school. Records can be viewed and exported, but nothing can
          be changed. Ask EduBridge to add it again to carry on.
        </Alert>
      )}
      {items.length > 0 && (
        // In a block of its own: the tab bar's negative margin would otherwise cancel the space below it.
        <div>
          <SubNav label="Inventory" items={items} />
        </div>
      )}
      {children}
    </div>
  );
}
