import "server-only";
import { z } from "zod";
import { saveScores } from "../assessment/scores";
import { syncRegister } from "../attendance/registers";
import { createStudent, createStudentSchema, findPossibleDuplicates } from "../students/service";
import type { OperationHandler, OperationKind } from "./protocol";

/**
 * What each operation kind does. Every handler calls the service the web screens use; the protocol adds
 * idempotency and the outcome format around it.
 */

/** A class register: marks with the version each was made from (as the offline register screen sends). */
const attendanceRegister: OperationHandler = async (database, ctx, payload, op) => {
  const input =
    payload && typeof payload === "object"
      ? { source: "offline", recordedAt: op.recordedAt, ...(payload as Record<string, unknown>) }
      : payload;
  const result = await syncRegister(database, ctx, input);
  return {
    status: result.conflicts.length ? "conflict" : "applied",
    result: result as unknown as Record<string, unknown>,
  };
};

const scoresPayload = z.object({
  termId: z.string().uuid(),
  classId: z.string().uuid(),
  subjectId: z.string().uuid(),
  /** Each changed mark with what the sheet showed when the device read it. */
  cells: z.array(z.unknown()).min(1).max(2000),
});

/** Marks on a score sheet: each applies only if the mark is still what the device saw. */
const assessmentScores: OperationHandler = async (database, ctx, payload) => {
  const p = scoresPayload.parse(payload);
  const result = await saveScores(database, ctx, p.termId, p.classId, p.subjectId, { cells: p.cells });
  return {
    status: result.conflicts || result.locked ? "conflict" : "applied",
    result: result as unknown as Record<string, unknown>,
  };
};

const registerPayload = createStudentSchema.extend({
  /** Set after the person has seen the possible duplicates and confirmed this is a different child. */
  confirmDuplicate: z.boolean().optional(),
});

/**
 * A student registered on a device (possibly offline). The school assigns the admission number. If a
 * student with the same name (and date of birth, when known) is already on record, nothing is created
 * until the person confirms it is a different child, so an offline registration never silently duplicates
 * one made meanwhile at the office.
 */
const studentRegister: OperationHandler = async (database, ctx, payload) => {
  const { confirmDuplicate, ...input } = registerPayload.parse(payload);
  if (!confirmDuplicate) {
    const duplicates = await findPossibleDuplicates(database, ctx, input);
    if (duplicates.length) return { status: "conflict", result: { possibleDuplicates: duplicates } };
  }
  const created = await createStudent(database, ctx, input);
  return { status: "applied", result: created };
};

export const SYNC_HANDLERS: Record<OperationKind, OperationHandler> = {
  "attendance.register": attendanceRegister,
  "assessment.scores": assessmentScores,
  "student.register": studentRegister,
};
