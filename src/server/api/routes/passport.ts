import "server-only";
import { z } from "zod";
import { exportLearnerRecord, importLearnerRecord, verifyLearnerPackage } from "../../passport/records";
import { publishedKeys } from "../../passport/signing";
import {
  acceptTransfer,
  approveTransfer,
  cancelTransfer,
  declineTransfer,
  listTransfers,
  requestTransfer,
} from "../../passport/transfers";
import { readJson } from "../http";
import { notFound, type ApiRoute } from "../router";

const uuid = (v: string | undefined) => {
  if (!z.string().uuid().safeParse(v).success) throw notFound();
  return v!;
};

/** Transfer Passport: verification for anyone, records and transfers for schools. */
export const passportRoutes: ApiRoute[] = [
  {
    method: "GET",
    path: "/passport/keys",
    summary: "EduBridge's public keys for verifying learner records (Ed25519, SPKI DER in base64).",
    auth: "public",
    handler: async () => ({
      keys: publishedKeys().filter((k) => !k.development || process.env.NODE_ENV !== "production"),
    }),
  },
  {
    method: "POST",
    path: "/passport/verify",
    summary: "Check a learner record package: valid, revoked, unsigned or invalid, and who issued it.",
    auth: "public",
    handler: async ({ database, request }) => {
      const v = await verifyLearnerPackage(database, await readJson(request, 2 * 1024 * 1024));
      if (v.status === "invalid") return v;
      if (v.status === "unsigned") return { status: v.status, issuer: v.issuer, student: v.student };
      return {
        status: v.status,
        issuer: v.issuer,
        issuedAt: v.issuedAt,
        student: v.student,
        recordId: v.recordId,
        ...(v.status === "revoked" ? { revokedReason: v.revokedReason } : {}),
      };
    },
  },
  {
    method: "GET",
    path: "/schools/:school/students/:id/record",
    summary: "Issue and download a signed learner record for a student.",
    auth: "school",
    handler: async ({ database, ctx, params }) => exportLearnerRecord(database, ctx, uuid(params.id)),
  },
  {
    method: "POST",
    path: "/schools/:school/records/import",
    summary:
      "Import a learner record: { package, studentId? (attach to this student), classId? (place a new student) }.",
    auth: "school",
    handler: async ({ database, ctx, request }) => {
      const body = z
        .object({ package: z.unknown(), studentId: z.string().optional(), classId: z.string().optional() })
        .parse(await readJson(request, 2 * 1024 * 1024));
      return importLearnerRecord(database, ctx, {
        file: JSON.stringify(body.package ?? null),
        studentId: body.studentId,
        classId: body.classId,
      });
    },
  },
  {
    method: "GET",
    path: "/schools/:school/transfers",
    summary: "Transfers in and out of the school.",
    auth: "school",
    handler: async ({ database, ctx }) => ({ transfers: await listTransfers(database, ctx) }),
  },
  {
    method: "POST",
    path: "/schools/:school/transfers",
    summary:
      "Ask another school for a child's records: { fromSchoolId, firstName, lastName, dateOfBirth?, guardianPhone }.",
    auth: "school",
    handler: async ({ database, ctx, request }) => ({
      id: await requestTransfer(database, ctx, await readJson(request)),
    }),
  },
  {
    method: "POST",
    path: "/schools/:school/transfers/:id/approve",
    summary: "Approve a transfer out (issues a signed record; the student is withdrawn as transferred).",
    auth: "school",
    handler: async ({ database, ctx, params }) => {
      await approveTransfer(database, ctx, uuid(params.id));
      return { approved: true };
    },
  },
  {
    method: "POST",
    path: "/schools/:school/transfers/:id/decline",
    summary: "Decline a transfer out: { reason }.",
    auth: "school",
    handler: async ({ database, ctx, params, request }) => {
      await declineTransfer(database, ctx, uuid(params.id), await readJson(request));
      return { declined: true };
    },
  },
  {
    method: "POST",
    path: "/schools/:school/transfers/:id/accept",
    summary: "Accept an approved transfer in: { classId? }. Creates the student from the verified record.",
    auth: "school",
    handler: async ({ database, ctx, params, request }) =>
      acceptTransfer(database, ctx, uuid(params.id), await readJson(request)),
  },
  {
    method: "POST",
    path: "/schools/:school/transfers/:id/cancel",
    summary: "Withdraw a request this school made.",
    auth: "school",
    handler: async ({ database, ctx, params }) => {
      await cancelTransfer(database, ctx, uuid(params.id));
      return { cancelled: true };
    },
  },
];
