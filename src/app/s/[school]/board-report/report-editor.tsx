"use client";

import { useState, useTransition } from "react";
import { Alert } from "@/components/ui/alert";
import { toast } from "@/components/ui/toast";
import { Button, buttonStyles } from "@/components/ui/button";
import { Field, Textarea } from "@/components/ui/field";

type Draft = (
  termId: string,
  campusId: string | null,
) => Promise<
  { ok: true; draftId: string; text: string; uncheckedFigures: string[] } | { ok: false; message: string }
>;

/**
 * The board report (R5-5, DRF-03): a draft around the Command Center figures, which the Proprietor edits and
 * downloads with the board summary as one PDF. The figures in it were put in by EduBridge, not written by the AI.
 */
export function ReportEditor({
  draft,
  downloadUrl,
  termId,
  campusId,
  available,
  unavailableMessage,
}: {
  draft: Draft;
  downloadUrl: string;
  termId: string;
  campusId: string | null;
  available: boolean;
  unavailableMessage: string | null;
}) {
  const [pending, startTransition] = useTransition();
  const [text, setText] = useState("");
  const [draftId, setDraftId] = useState("");
  const [unchecked, setUnchecked] = useState<string[]>([]);
  return (
    <div className="max-w-3xl space-y-4">
      {available ? (
        <Button
          type="button"
          variant={text ? "secondary" : "primary"}
          pending={pending}
          onClick={() =>
            startTransition(async () => {
              const r = await draft(termId, campusId);
              if (!r.ok) return void toast(r.message, "critical");
              setText(r.text);
              setDraftId(r.draftId);
              setUnchecked(r.uncheckedFigures);
            })
          }
        >
          {text ? "Draft again" : "Draft the report"}
        </Button>
      ) : (
        <p className="text-base text-ink-2">
          Drafting is not available: {unavailableMessage} You can still write the report yourself below.
        </p>
      )}
      {unchecked.length > 0 && (
        <Alert tone="info">
          The draft contains figures that are not from the Command Center: {unchecked.join(", ")}. Check or
          remove them.
        </Alert>
      )}
      <form method="post" action={downloadUrl} className="space-y-4">
        <input type="hidden" name="term" value={termId} />
        {campusId && <input type="hidden" name="campus" value={campusId} />}
        <input type="hidden" name="draftId" value={draftId} />
        <Field
          label="Report"
          description="Edit it as you wish. Figures in a draft come from the Command Center; the summary of figures is printed after the report."
        >
          {(p) => (
            <Textarea
              {...p}
              name="report"
              rows={14}
              maxLength={6000}
              value={text}
              onChange={(e) => setText(e.target.value)}
              required
            />
          )}
        </Field>
        <button type="submit" className={buttonStyles("secondary")} disabled={!text.trim()}>
          Download as PDF
        </button>
      </form>
    </div>
  );
}
