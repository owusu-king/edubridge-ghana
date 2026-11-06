"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { Route } from "next";
import type { Stage } from "@/server/academics/classes";
import { requestReportCardPrint } from "@/server/assessment/batches";
import { publishReportCards, saveReportRemarks, withdrawReportCard } from "@/server/assessment/report-cards";
import { saveScores } from "@/server/assessment/scores";
import {
  createSubject,
  resetGradingScale,
  saveAssessmentScheme,
  saveGradingScale,
  setupDefaultSubjects,
  updateSubject,
} from "@/server/assessment/setup";
import { db } from "@/server/db/client";
import type { TenantContext } from "@/server/tenancy/service";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { toFormError, type FormState } from "@/web/forms";
import { printAfterResponse } from "@/web/report-cards";

async function run(
  slug: string,
  formData: FormData | null,
  fn: (ctx: TenantContext) => Promise<string | void>,
  message: string,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  let result: string | void;
  try {
    result = await fn(ctx);
  } catch (error) {
    return toFormError(error, formData ?? undefined);
  }
  revalidatePath(schoolPath(slug, "assessment"), "layout");
  return { status: "success", message: result || message };
}

const strings = (formData: FormData, name: string) => formData.getAll(name).map(String);

export async function setupSubjectsAction(slug: string, _prev: FormState, _formData: FormData) {
  return run(
    slug,
    null,
    async (ctx) => {
      const n = await setupDefaultSubjects(db(), ctx);
      return `${n} subjects added.`;
    },
    "Subjects added.",
  );
}

export async function addSubjectAction(slug: string, _prev: FormState, formData: FormData) {
  return run(
    slug,
    formData,
    (ctx) =>
      createSubject(db(), ctx, { name: formData.get("name"), levelIds: strings(formData, "levelIds") }).then(
        () => undefined,
      ),
    "Subject added.",
  );
}

export async function updateSubjectAction(
  slug: string,
  subjectId: string,
  _prev: FormState,
  formData: FormData,
) {
  return run(
    slug,
    formData,
    (ctx) =>
      updateSubject(db(), ctx, subjectId, {
        name: formData.get("name"),
        levelIds: strings(formData, "levelIds"),
      }),
    "Subject saved.",
  );
}

export async function saveSchemeAction(slug: string, termId: string, _prev: FormState, formData: FormData) {
  const keys = strings(formData, "key");
  const names = strings(formData, "name");
  const weights = strings(formData, "weight");
  const outOfs = strings(formData, "outOf");
  const components = names
    .map((name, i) => ({ key: keys[i] || undefined, name, weight: weights[i] ?? "", outOf: outOfs[i] ?? "" }))
    // A blank new row is ignored rather than reported.
    .filter((c) => c.key || c.name.trim() || c.weight.trim() || c.outOf.trim());
  return run(
    slug,
    formData,
    (ctx) =>
      saveAssessmentScheme(db(), ctx, termId, {
        components,
        showPositions: formData.get("showPositions") === "on",
      }),
    "Assessment saved.",
  );
}

export async function saveScaleAction(slug: string, stage: Stage, _prev: FormState, formData: FormData) {
  const mins = strings(formData, "min");
  const grades = strings(formData, "grade");
  const remarks = strings(formData, "remark");
  const bands = grades
    .map((grade, i) => ({ grade, min: mins[i] ?? "", remark: remarks[i] ?? "" }))
    .filter((b) => b.grade.trim() || b.min.trim() || b.remark.trim());
  return run(slug, formData, (ctx) => saveGradingScale(db(), ctx, stage, { bands }), "Grades saved.");
}

export async function resetScaleAction(slug: string, stage: Stage, _prev: FormState, _formData: FormData) {
  return run(slug, null, (ctx) => resetGradingScale(db(), ctx, stage), "Default grades restored.");
}

/** Score sheet fields are "s:{studentId}:{part}" (the mark) and "o:…" (the mark when the sheet was opened). */
export async function saveScoresAction(
  slug: string,
  termId: string,
  classId: string,
  subjectId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const cells: { studentId: string; key: string; original: string; value: string }[] = [];
  for (const [name, value] of formData.entries()) {
    if (!name.startsWith("s:") || typeof value !== "string") continue;
    const [, studentId, key] = name.split(":");
    if (!studentId || !key) continue;
    cells.push({ studentId, key, value, original: String(formData.get(`o:${studentId}:${key}`) ?? "") });
  }
  const { ctx } = await requireTenant(slug);
  try {
    const result = await saveScores(db(), ctx, termId, classId, subjectId, { cells });
    revalidatePath(schoolPath(slug, "assessment"), "layout");
    const parts = [
      result.saved === 0
        ? "No changes to save."
        : `${result.saved} ${result.saved === 1 ? "mark" : "marks"} saved.`,
    ];
    if (result.conflicts)
      parts.push(
        `${result.conflicts} ${result.conflicts === 1 ? "mark was" : "marks were"} changed by someone else while you were entering them and ${result.conflicts === 1 ? "was" : "were"} not overwritten. The sheet now shows the latest marks.`,
      );
    if (result.locked)
      parts.push(
        `${result.locked} on published report cards ${result.locked === 1 ? "was" : "were"} not changed.`,
      );
    return {
      status: result.conflicts || result.locked ? "error" : "success",
      message: parts.join(" "),
    };
  } catch (error) {
    return toFormError(error);
  }
}

export async function saveRemarksAction(
  slug: string,
  termId: string,
  classId: string,
  studentId: string,
  _prev: FormState,
  formData: FormData,
) {
  const text = (name: string) => String(formData.get(name) ?? "");
  return run(
    slug,
    formData,
    (ctx) =>
      saveReportRemarks(db(), ctx, termId, classId, studentId, {
        attitude: text("attitude"),
        conduct: text("conduct"),
        interest: text("interest"),
        classTeacherRemark: text("classTeacherRemark"),
        ...(formData.has("headTeacherRemark") ? { headTeacherRemark: text("headTeacherRemark") } : {}),
        daysPresent: text("daysPresent"),
        daysOpen: text("daysOpen"),
      }),
    "Report card saved.",
  );
}

export async function publishAction(
  slug: string,
  termId: string,
  classId: string,
  studentIds: string[] | null,
  _prev: FormState,
  _formData: FormData,
) {
  return run(
    slug,
    null,
    async (ctx) => {
      const n = await publishReportCards(db(), ctx, termId, classId, studentIds ? { studentIds } : {});
      return n === 0 ? "Nothing to publish." : `${n} report ${n === 1 ? "card" : "cards"} published.`;
    },
    "Published.",
  );
}

export async function withdrawAction(
  slug: string,
  termId: string,
  classId: string,
  studentId: string,
  _prev: FormState,
  formData: FormData,
) {
  return run(
    slug,
    formData,
    (ctx) => withdrawReportCard(db(), ctx, termId, classId, studentId, { reason: formData.get("reason") }),
    "Report card withdrawn. It is a draft again.",
  );
}

/** Starts a print run, then opens the print runs page where it shows progress. */
export async function printAction(
  slug: string,
  termId: string,
  classIds: string[],
  _prev: FormState,
  _formData: FormData,
) {
  const { ctx } = await requireTenant(slug);
  let batchId: string;
  try {
    batchId = await requestReportCardPrint(db(), ctx, termId, { classIds });
  } catch (error) {
    return toFormError(error);
  }
  printAfterResponse(ctx.tenant.id, batchId);
  redirect(schoolPath(slug, "assessment/prints") as Route);
}
