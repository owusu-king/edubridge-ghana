"use client";

import { CloudOff } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ATTENDANCE_STATUSES,
  normaliseReason,
  REASON_MAX,
  STATUS_LABELS,
  type AttendanceStatus,
} from "@/lib/attendance";
import { cn } from "@/lib/cn";
import {
  getConflicts,
  getQueued,
  queueMarks,
  registerKey,
  resolveConflict,
  type QueuedMark,
  type QueuedRegister,
  type StoredConflict,
} from "@/lib/offline-queue";
import {
  flushQueued,
  registerServiceWorker,
  savePagesForOffline,
  sendOrQueue,
  type SendRegister,
} from "./offline";

export interface RegisterStudent {
  id: string;
  name: string;
  admissionNumber: string;
  mark: {
    status: AttendanceStatus;
    reason: string | null;
    version: number;
    by: string | null;
    at: Date;
  } | null;
}

interface Props {
  slug: string;
  userId: string;
  classId: string;
  className: string;
  date: string;
  lock: string | null;
  students: RegisterStudent[];
  send: SendRegister;
  /** The school's time zone, for times shown. */
  timeZone: string;
}

type Message = { tone: "positive" | "critical" | "info"; text: string } | null;

/**
 * A class register that keeps working without a connection. Marks are sent with the version each was made
 * from; marks that cannot be sent wait on the device and go when the connection returns. If someone else
 * changed a mark meanwhile, both are shown and the person chooses: nothing is overwritten silently.
 */
export function RegisterScreen(props: Props) {
  const { slug, userId, classId, className, date, send, timeZone } = props;
  const timeFormat = new Intl.DateTimeFormat("en-GH", { hour: "2-digit", minute: "2-digit", timeZone });
  const router = useRouter();
  const key = registerKey(userId, slug, classId, date);
  const online = useOnline();
  const [message, setMessage] = useState<Message>(null);
  const [queued, setQueued] = useState<QueuedRegister | undefined>();
  const [conflicts, setConflicts] = useState<StoredConflict[]>([]);
  const [busy, setBusy] = useState(false);
  /** When this register's offline copy was last brought up to date (null: none yet, or no service worker). */
  const [offlineCopyAt, setOfflineCopyAt] = useState<Date | null>(null);

  // Keeps the copy that opens offline in step with the server, so marks made from it start from the latest.
  const saveOfflineCopy = useCallback(async () => {
    setOfflineCopyAt(null);
    if (await savePagesForOffline([location.pathname + location.search])) setOfflineCopyAt(new Date());
  }, []);

  const reload = useCallback(async () => {
    if (!("indexedDB" in window)) return;
    setQueued(await getQueued(key));
    setConflicts((await getConflicts(key))?.items ?? []);
  }, [key]);

  const flush = useCallback(async () => {
    const summary = await flushQueued(userId, slug, send);
    await reload();
    if (summary.sent || summary.refused.length) {
      router.refresh();
      void saveOfflineCopy();
      const parts: string[] = [];
      if (summary.sent)
        parts.push(
          `${summary.sent} ${summary.sent === 1 ? "register" : "registers"} kept on this device ${summary.sent === 1 ? "was" : "were"} sent.`,
        );
      if (summary.conflicts)
        parts.push(
          `${summary.conflicts} ${summary.conflicts === 1 ? "mark needs" : "marks need"} your decision.`,
        );
      for (const r of summary.refused) parts.push(`${r.className}, ${r.date}: ${r.message}`);
      setMessage({
        tone: summary.refused.length || summary.conflicts ? "critical" : "positive",
        text: parts.join(" "),
      });
    }
    return summary;
  }, [userId, slug, send, reload, router, saveOfflineCopy]);

  useEffect(() => {
    registerServiceWorker();
    // Show what is waiting on this device, then send it if there is a connection.
    const start = setTimeout(async () => {
      await reload();
      if (!navigator.onLine) return;
      await flush();
      await navigator.serviceWorker?.ready;
      await saveOfflineCopy();
    }, 0);
    const back = () => void flush();
    window.addEventListener("online", back);
    return () => {
      clearTimeout(start);
      window.removeEventListener("online", back);
    };
  }, [flush, reload, saveOfflineCopy]);

  async function submit(marks: QueuedMark[], source: "online" | "kept_mine"): Promise<boolean> {
    setBusy(true);
    try {
      const entry = { userId, school: slug, classId, className, date, marks };
      // Marks already waiting on this device go first, together with these, so they keep their order.
      if (queued) {
        await queueMarks({ ...entry, source: source === "kept_mine" ? "kept_mine" : "offline" });
        await flush();
        return true;
      }
      const outcome = await sendOrQueue(send, { ...entry, source });
      await reload();
      if (outcome.queued) {
        setMessage(null);
        return true;
      }
      if (outcome.refused) {
        setMessage({ tone: "critical", text: outcome.refused });
        return false;
      }
      router.refresh();
      void saveOfflineCopy();
      const r = outcome.result!;
      setMessage(
        r.conflicts.length
          ? {
              tone: "critical",
              text: `${r.applied} saved. ${r.conflicts.length} ${r.conflicts.length === 1 ? "mark was" : "marks were"} changed by someone else since you opened the register; choose which to keep below.`,
            }
          : {
              tone: "positive",
              text: r.applied
                ? `Register saved.${r.alerts ? ` An absence SMS went to ${r.alerts} ${r.alerts === 1 ? "family" : "families"}.` : ""}`
                : "No changes to save.",
            },
      );
      return true;
    } finally {
      setBusy(false);
    }
  }

  async function keepMine(c: StoredConflict) {
    await resolveConflict(key, c.studentId);
    await submit(
      [
        {
          studentId: c.studentId,
          status: c.yours.status,
          reason: c.yours.reason,
          baseVersion: c.theirs.version,
        },
      ],
      "kept_mine",
    );
  }

  async function keepTheirs(c: StoredConflict) {
    await resolveConflict(key, c.studentId);
    await reload();
    router.refresh();
  }

  const gridKey = JSON.stringify([
    props.students.map((s) => [s.id, s.mark?.status, s.mark?.version]),
    queued?.recordedAt,
  ]);

  return (
    <div className="space-y-5">
      {!online && (
        <Alert>
          <span className="inline-flex items-center gap-1.5 font-medium">
            <CloudOff aria-hidden="true" className="size-4" /> No connection.
          </span>{" "}
          You can still take the register: it is kept on this device and sent when you are back online.
        </Alert>
      )}
      {message && <Alert tone={message.tone}>{message.text}</Alert>}
      {queued && (
        <Alert>
          {queued.marks.length} {queued.marks.length === 1 ? "mark is" : "marks are"} kept on this device, not
          sent yet{online ? "." : ". They will be sent when you are back online."}
        </Alert>
      )}
      {conflicts.length > 0 && (
        <section
          aria-labelledby="conflicts"
          className="space-y-3 rounded-lg border border-caution/30 bg-caution-soft p-4"
        >
          <h2 id="conflicts" className="text-base font-semibold text-ink">
            Changed by someone else
          </h2>
          <p className="text-sm text-ink-2">
            These marks were changed by someone else before yours arrived. Choose which to keep for each.
          </p>
          <ul className="space-y-3">
            {conflicts.map((c) => (
              <li key={c.studentId} className="rounded-md border border-line bg-surface p-3">
                <p className="font-medium text-ink">{c.name}</p>
                <p className="mt-1 text-sm text-ink-2">
                  You marked <strong>{STATUS_LABELS[c.yours.status]}</strong>
                  {c.yours.reason ? ` (${c.yours.reason})` : ""}. {c.theirs.by ?? "Someone"} marked{" "}
                  <strong>{STATUS_LABELS[c.theirs.status]}</strong>
                  {c.theirs.reason ? ` (${c.theirs.reason})` : ""} at{" "}
                  {timeFormat.format(new Date(c.theirs.at))}.
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" disabled={busy} onClick={() => void keepMine(c)}>
                    Keep mine ({STATUS_LABELS[c.yours.status]})
                  </Button>
                  <Button size="sm" variant="secondary" disabled={busy} onClick={() => void keepTheirs(c)}>
                    Keep {STATUS_LABELS[c.theirs.status]}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      {offlineCopyAt && online && (
        <p className="text-sm text-ink-3">
          Saved on this device at {timeFormat.format(offlineCopyAt)}: this register opens without a
          connection.
        </p>
      )}
      <RegisterGrid
        key={gridKey}
        {...props}
        queued={queued}
        conflictIds={new Set(conflicts.map((c) => c.studentId))}
        busy={busy}
        onSave={(marks) => submit(marks, "online")}
      />
    </div>
  );
}

function subscribeOnline(onChange: () => void) {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

/** Whether the browser thinks it has a connection (true while rendering on the server). */
export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );
}

type Local = Record<string, { status: AttendanceStatus | null; reason: string }>;

function RegisterGrid({
  students,
  lock,
  queued,
  conflictIds,
  busy,
  onSave,
}: Props & {
  queued: QueuedRegister | undefined;
  conflictIds: Set<string>;
  busy: boolean;
  onSave: (marks: QueuedMark[]) => Promise<boolean>;
}) {
  // What the register shows before any new tap: the server's marks, with marks waiting on the device on top.
  const base = useMemo<Local>(() => {
    const waiting = new Map((queued?.marks ?? []).map((m) => [m.studentId, m]));
    return Object.fromEntries(
      students.map((s) => {
        const w = waiting.get(s.id);
        return [
          s.id,
          { status: w?.status ?? s.mark?.status ?? null, reason: w?.reason ?? s.mark?.reason ?? "" },
        ];
      }),
    );
  }, [students, queued]);
  const [local, setLocal] = useState<Local>(base);
  const waiting = new Set((queued?.marks ?? []).map((m) => m.studentId));
  const changed = students.filter(
    (s) =>
      local[s.id]!.status !== null &&
      (local[s.id]!.status !== base[s.id]!.status ||
        normaliseReason(local[s.id]!.status!, local[s.id]!.reason) !==
          normaliseReason(local[s.id]!.status!, base[s.id]!.reason)),
  );
  const counts = Object.fromEntries(
    ATTENDANCE_STATUSES.map((st) => [st, students.filter((s) => local[s.id]!.status === st).length]),
  ) as Record<AttendanceStatus, number>;
  const unmarked = students.filter((s) => local[s.id]!.status === null).length;
  const set = (id: string, patch: Partial<Local[string]>) =>
    setLocal((l) => ({ ...l, [id]: { ...l[id]!, ...patch } }));

  async function save() {
    const marks = changed.map((s) => ({
      studentId: s.id,
      status: local[s.id]!.status!,
      reason: normaliseReason(local[s.id]!.status!, local[s.id]!.reason),
      baseVersion: s.mark?.version ?? 0,
    }));
    await onSave(marks);
  }

  return (
    <div className="space-y-4">
      {lock ? (
        <Alert>{lock}</Alert>
      ) : (
        unmarked > 0 && (
          <Button
            variant="secondary"
            onClick={() =>
              setLocal((l) =>
                Object.fromEntries(
                  Object.entries(l).map(([id, v]) => [
                    id,
                    v.status === null ? { ...v, status: "present" as const } : v,
                  ]),
                ),
              )
            }
          >
            {unmarked === students.length ? "Mark everyone present" : `Mark the other ${unmarked} present`}
          </Button>
        )
      )}
      <ul className="divide-y divide-line rounded-lg border border-line bg-surface shadow-raised">
        {students.map((s) => {
          const value = local[s.id]!;
          const needsReason = value.status === "absent" || value.status === "excused";
          return (
            <li key={s.id} className={cn("px-4 py-3", conflictIds.has(s.id) && "bg-caution-soft/60")}>
              <fieldset disabled={Boolean(lock)} className="space-y-2">
                <legend className="flex w-full flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <span>
                    <span className="font-medium text-ink">{s.name}</span>{" "}
                    <span className="text-sm text-ink-3">{s.admissionNumber}</span>
                  </span>
                  {waiting.has(s.id) ? (
                    <Badge tone="caution">Not sent yet</Badge>
                  ) : conflictIds.has(s.id) ? (
                    <Badge tone="caution">Choose above</Badge>
                  ) : null}
                </legend>
                <div
                  className="grid grid-cols-4 gap-1.5"
                  role="radiogroup"
                  aria-label={`${s.name} attendance`}
                >
                  {ATTENDANCE_STATUSES.map((status) => (
                    <label
                      key={status}
                      className={cn(
                        "flex h-11 cursor-pointer items-center justify-center rounded-md border text-sm font-medium transition-colors select-none",
                        "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent/40",
                        value.status === status
                          ? status === "present"
                            ? "border-positive bg-positive-soft text-positive"
                            : status === "late"
                              ? "border-caution bg-caution-soft text-caution"
                              : status === "absent"
                                ? "border-critical bg-critical-soft text-critical"
                                : "border-accent bg-accent-soft text-accent"
                          : "border-line-strong bg-surface text-ink-2 hover:bg-subtle",
                        lock && "cursor-not-allowed opacity-70",
                      )}
                    >
                      <input
                        type="radio"
                        className="sr-only"
                        name={`status-${s.id}`}
                        value={status}
                        checked={value.status === status}
                        onChange={() => set(s.id, { status })}
                        aria-label={`${s.name}: ${STATUS_LABELS[status]}`}
                      />
                      {STATUS_LABELS[status]}
                    </label>
                  ))}
                </div>
                {needsReason && (
                  <input
                    value={value.reason}
                    onChange={(e) => set(s.id, { reason: e.target.value })}
                    maxLength={REASON_MAX}
                    placeholder="Reason (optional)"
                    aria-label={`${s.name}: reason`}
                    className="block h-10 w-full rounded-md border border-line-strong bg-surface px-3 text-base text-ink placeholder:text-ink-3 focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-accent/25"
                  />
                )}
              </fieldset>
            </li>
          );
        })}
      </ul>
      {!lock && (
        <div className="sticky bottom-0 -mx-4 flex flex-wrap items-center justify-between gap-3 border-t border-line bg-canvas/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-lg sm:border">
          <p className="text-sm text-ink-2 tabular-nums" aria-live="polite">
            {counts.present} present · {counts.late} late · {counts.absent} absent · {counts.excused} excused
            {unmarked ? ` · ${unmarked} not marked` : ""}
          </p>
          <Button onClick={() => void save()} pending={busy} disabled={changed.length === 0}>
            Save register
          </Button>
        </div>
      )}
    </div>
  );
}
