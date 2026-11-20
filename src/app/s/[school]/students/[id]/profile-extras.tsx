import type { Route } from "next";
import Link from "next/link";
import { Section } from "@/components/ui/layout";
import { ActionButton } from "@/components/fees/finance-forms";
import { formatDate } from "@/lib/format";
import { schoolPath } from "@/lib/routes";
import {
  removeDocumentAction,
  removePhotoAction,
  uploadDocumentAction,
  uploadPhotoAction,
} from "./profile-actions";
import { UploadForm } from "./profile-controls";

/** The student's photograph, private documents (SIS-08) and a link to medical information (SIS-06). */
export function ProfileExtras({
  slug,
  studentId,
  hasPhoto,
  canManage,
  canSeeDocuments,
  canSeeMedical,
  documents,
  timezone,
}: {
  slug: string;
  studentId: string;
  hasPhoto: boolean;
  canManage: boolean;
  canSeeDocuments: boolean;
  canSeeMedical: boolean;
  documents: { id: string; filename: string; sizeBytes: number; uploadedAt: Date; uploadedBy: string }[];
  timezone: string;
}) {
  const base = schoolPath(slug, `students/${studentId}`);
  return (
    <Section title="Photo, documents and medical">
      <div className="flex flex-wrap items-start gap-6">
        {hasPhoto ? (
          // eslint-disable-next-line @next/next/no-img-element -- private, access-checked route
          <img
            src={`${base}/photo`}
            alt="Student photograph"
            className="size-28 rounded-lg border border-line object-cover"
          />
        ) : (
          <div className="flex size-28 items-center justify-center rounded-lg border border-dashed border-line-strong text-sm text-ink-3">
            No photo
          </div>
        )}
        {canManage && (
          <div className="space-y-2">
            <UploadForm
              action={uploadPhotoAction.bind(null, slug, studentId)}
              label={hasPhoto ? "Replace the photo" : "Add a photo"}
              accept="image/png,image/jpeg,image/webp"
              submitLabel="Upload"
            />
            {hasPhoto && (
              <ActionButton
                action={removePhotoAction.bind(null, slug, studentId)}
                variant="danger-outline"
                label="Remove photo"
              />
            )}
          </div>
        )}
      </div>

      {canSeeDocuments && (
        <div className="space-y-3">
          <h3 className="text-base font-semibold text-ink">Documents</h3>
          <p className="text-sm text-ink-3">
            Birth certificates, previous reports and other papers. Kept private; every download is recorded.
          </p>
          {documents.length > 0 && (
            <ul className="divide-y divide-line border-y border-line text-sm">
              {documents.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
                  <span>
                    <a href={`${base}/documents/${d.id}`} className="text-accent underline">
                      {d.filename}
                    </a>{" "}
                    <span className="text-ink-3">
                      {Math.ceil(d.sizeBytes / 1024)} KB · {d.uploadedBy},{" "}
                      {formatDate(d.uploadedAt, timezone)}
                    </span>
                  </span>
                  {canManage && (
                    <ActionButton
                      action={removeDocumentAction.bind(null, slug, studentId, d.id)}
                      label="Remove"
                      variant="danger-outline"
                      ariaLabel={`Remove ${d.filename}`}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
          {canManage && (
            <UploadForm
              action={uploadDocumentAction.bind(null, slug, studentId)}
              label="Add a document (PDF, PNG or JPEG, up to 5 MB)"
              accept="application/pdf,image/png,image/jpeg"
              submitLabel="Upload"
            />
          )}
        </div>
      )}

      {canSeeMedical && (
        <p className="text-sm">
          <Link href={`${base}/medical` as Route} className="text-accent underline">
            Medical and emergency information
          </Link>{" "}
          <span className="text-ink-3">(restricted; opening it is recorded)</span>
        </p>
      )}
    </Section>
  );
}
