import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "@/components/ui/layout";
import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { getStudent } from "@/server/students/service";
import { getStudentMedical } from "@/server/students/profile";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { saveMedicalAction } from "../profile-actions";
import { MedicalForm } from "../profile-controls";

export const metadata: Metadata = { title: "Medical information" };

/** SIS-06: restricted to the Proprietor, Head teacher and Administrator; opening this page is recorded. */
export default async function MedicalPage({ params }: { params: Promise<{ school: string; id: string }> }) {
  const { school, id } = await params;
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "students.medical")) notFound();
  const student = await getStudent(db(), ctx, id);
  if (!student) notFound();
  const medical = await getStudentMedical(db(), ctx, id);
  return (
    <div className="space-y-6">
      <Link
        href={schoolPath(ctx.tenant.slug, `students/${id}`) as Route}
        className="inline-flex items-center gap-1.5 text-sm text-ink-2 hover:text-ink"
      >
        <ArrowLeft aria-hidden="true" className="size-4" />
        {student.fullName}
      </Link>
      <PageHeader
        title="Medical and emergency information"
        description="Seen only by the Proprietor, Head teacher and Administrator. Each time this page is opened or saved, it is recorded in the audit log."
      />
      <MedicalForm
        action={saveMedicalAction.bind(null, ctx.tenant.slug, id)}
        values={medical ? { ...medical, updatedAt: null } : {}}
      />
    </div>
  );
}
