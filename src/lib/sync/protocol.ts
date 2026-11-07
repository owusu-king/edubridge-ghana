/**
 * Sync protocol types shared by the server (src/server/sync) and devices (the browser today; other clients
 * later). Framework-free and browser-safe.
 */
export const OPERATION_KINDS = ["attendance.register", "assessment.scores", "student.register"] as const;
export type OperationKind = (typeof OPERATION_KINDS)[number];

/** One change made on a device, as sent to the server. */
export interface SyncOperation {
  /** A UUID chosen by the device; sending it again never applies it twice. */
  id: string;
  kind: OperationKind;
  payload: unknown;
  /** When the change was made on the device (ISO). */
  recordedAt?: string;
}

export interface OperationError {
  code: string;
  message: string;
  fields?: Record<string, string>;
}

export type OperationOutcome =
  | {
      id: string;
      kind: OperationKind;
      status: "applied" | "conflict";
      result: Record<string, unknown>;
      replayed: boolean;
    }
  | { id: string; kind: OperationKind; status: "rejected"; error: OperationError; replayed: boolean };
