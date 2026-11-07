import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "@/components/ui/layout";
import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { listClassOptions } from "@/server/students/service";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { syncOperationsAction } from "../../sync-actions";
import { OfflineRegistration } from "./offline-registration";

export const metadata: Metadata = { title: "Register students" };

/**
 * Registering students where the connection is unreliable (e.g. an admissions day): each child is kept on
 * the device and sent through the sync protocol, which assigns the admission number and asks before
 * adding a child who may already be on record.
 */
export default async function RegisterStudentsPage({ params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "students.manage")) notFound();
  const classes = await listClassOptions(db(), ctx);
  return (
    <div className="space-y-6">
      <div>
        <Link
          href={schoolPath(ctx.tenant.slug, "students") as Route}
          className="-ml-2 inline-flex h-9 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-accent hover:bg-accent-soft"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          Students
        </Link>
        <PageHeader
          title="Register students"
          description="Works without a connection once this page has been opened on this device. Each child is sent to the school when there is a connection; the school gives the admission number."
          bordered={false}
        />
      </div>
      <OfflineRegistration
        school={ctx.tenant.slug}
        userId={ctx.userId}
        classes={classes.map((c) => ({ id: c.id, name: c.name }))}
        action={syncOperationsAction}
      />
    </div>
  );
}
