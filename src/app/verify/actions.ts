"use server";

import { db } from "@/server/db/client";
import { verifyLearnerPackage } from "@/server/passport/records";

export interface VerifyState {
  status: "idle" | "valid" | "revoked" | "unsigned" | "invalid";
  message?: string;
  issuer?: string;
  student?: string;
  issuedAt?: string;
  development?: boolean;
}

const MAX = 2 * 1024 * 1024;

/** Checks a learner record file for anyone (no sign-in): only what the file itself says is shown. */
export async function verifyRecordAction(_prev: VerifyState, formData: FormData): Promise<VerifyState> {
  const file = formData.get("file");
  const pasted = String(formData.get("text") ?? "");
  const text = file instanceof File && file.size > 0 ? (file.size > MAX ? "" : await file.text()) : pasted;
  if (!text.trim())
    return { status: "invalid", message: "Choose a record file (at most 2 MB) or paste its contents." };
  let pkg: unknown;
  try {
    pkg = JSON.parse(text);
  } catch {
    return { status: "invalid", message: "This is not a learner record file." };
  }
  const v = await verifyLearnerPackage(db(), pkg);
  if (v.status === "invalid") return { status: "invalid", message: v.reason };
  if (v.status === "unsigned") return { status: "unsigned", issuer: v.issuer, student: v.student };
  return {
    status: v.status,
    issuer: v.issuer,
    student: v.student,
    issuedAt: v.issuedAt,
    development: v.development,
    message: v.status === "revoked" ? (v.revokedReason ?? undefined) : undefined,
  };
}
