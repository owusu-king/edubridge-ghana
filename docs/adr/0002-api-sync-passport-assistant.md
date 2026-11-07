# ADR 0002 — API, sync protocol, Transfer Passport and assistant

| | |
|---|---|
| Status | **Accepted** (built on the founder's instruction of 2026-11-07); items marked *decision* still need the founder |
| Builds on | ADR 0001 (one Next.js app plus a worker; business logic in `src/server`) |

## API (`/api/v1`)

- The API lives in `src/server/api` on web-standard `Request`/`Response`, with no framework. One Next.js catch-all
  route (`src/app/api/v1/[[...path]]/route.ts`) hands requests to it; tests call it directly. Payment callbacks keep
  their own routes.
- Handlers are thin adapters over the same services as the pages. School routes resolve the school as the web does:
  the slug is only a hint, membership (or a live support grant) is checked, the school's two-step policy applies, and
  support activity is recorded. Errors use one format: `{ error: { code, message, fields? } }`.
- Clients authenticate with **device tokens** (`ebd_…`, hashed in `device_tokens`), issued after the normal sign-in
  (password, then the second step). Tokens are named, listed under Account, Devices, revocable one by one, renewed
  while in use (90 days), and revoked together when the password changes or is reset. Web session tokens are never
  accepted as bearer tokens; the session cookie is accepted only for reading (CSRF).

## Sync protocol (`src/server/sync`, `src/lib/sync`)

- Generalises the offline-register design (phase H). A device sends operations `{ id (UUID), kind, payload,
  recordedAt }`. Each one is applied by its kind's handler, which calls the existing service, and is recorded in
  `sync_operations` **in the same transaction as its effects**: the service's own transaction becomes a savepoint, and
  an advisory lock on the operation id serialises duplicates. A retry, a second tab or a restarted device gets the
  recorded outcome; nothing applies twice, and no "pending" state can be left behind.
- Outcomes: `applied`, `conflict` (someone changed the same thing, or a check needs a person, e.g. a possible duplicate
  student; nothing is overwritten, and the device decides and sends a *new* operation), `rejected` (will never
  apply as sent). Last-writer-wins is never used.
- Kinds: `attendance.register` (versioned marks), `assessment.scores` (marks apply only if still what the device saw),
  `student.register` (the school assigns the admission number; a same-name, same-birth-date student needs
  confirmation).
- Incoming changes: database triggers write `sync_changes` for students, class placements, classes, register marks and
  marks, so no code path can forget them. `GET /sync/changes` gives a snapshot, then changes after a cursor, filtered
  to what the person may see now, with removals when access ends. Cursors older than 60 days must start again;
  entries are purged after 90.
- The device queue (`src/lib/sync/queue.ts`) is framework-free over a `SyncStore` interface. The browser uses
  IndexedDB; another client (for example a desktop app on SQLite) would add a store, not a new queue.
- The web register screen keeps its proven queue; the `attendance.register` kind serves API clients. Moving the
  register screen onto the generic queue is a later, separate change.
- **Money is not captured offline.** Receipt numbers are gapless and issued by the server. *Decision:* whether to
  allow provisional offline receipts at all.

## Transfer Passport (`src/server/passport`)

- **Identity:** `learners` holds only an id. Each school's `students.learner_id` points to it (set by a trigger;
  existing students were backfilled). Personal details stay in each school's rows; the learner id travels only in
  signed records.
- **Records:** a learner record is the child's history at one school (identity, guardians, classes by term, published
  report cards as frozen, attendance by term). It is signed with Ed25519 over canonical JSON (sorted keys), stored with
  its SHA-256 in `learner_records` (never edited; revocable once), and verifiable by anyone at `/verify` or
  `POST /api/v1/passport/verify` with the keys at `/api/v1/passport/keys`. Verification checks the signature, that
  EduBridge issued exactly that record, and whether it has been revoked.
- **Transfers:** `transfers` is visible to both schools (row-level security on either school id), and the service
  narrows what each side sees. The receiving school is never told whether a child was found; the school being left
  sees nothing until the family has consented in the parent view (or started the move there). That school approves,
  which issues a signed record and withdraws the student as transferred, or declines with a reason. The receiving school
  verifies and accepts, creating its student with the same learner id, the guardians and the received record
  (`prior_records`, insert-only). Each school audits its own steps. Requests expire after 30 days.
- **Import and export:** a signed record can be downloaded for the family or for a school not on EduBridge, and
  imported. A valid signature means verified (the learner id is kept). The documented format without a signature is
  kept as unverified. A changed or revoked record is refused.
- *Decisions:* production signing key custody and rotation; whether unpaid fees may hold back a transfer (today the
  balance is shown, never used to block); data-protection review of consent and retention (Data Protection Act,
  2012, Act 843); whether to align the format with an open standard once a partner needs it.

## Insights and assistant

- Insights (`src/server/insights`) are descriptive: counts and averages computed live from published report cards,
  registers, the ledger and receipts, limited by role and campus. There are no summary tables yet; add them when schools
  grow past pilot size.
- The assistant (`src/server/assistant`) is a read-only tool loop. Each tool calls an insights or fees service with the
  asker's own context, so it can never read more than the person could open. Refusals by role go back to the model as
  errors it must report. Every question, the tools it used and their inputs, the answer, the model and the token use
  are recorded in `assistant_queries` (insert-only, tagged when asked by support). The model sits behind an interface:
  Claude (`claude-opus-5-5`, medium effort, server-side refusal fallback) through the official SDK.
- It runs only when `ASSISTANT_ENABLED=true` and the school's plan includes the `assistant` module, which new plans
  leave out by default. *Decision:* approval of the paid service and of sending school data (including student
  names) to Anthropic under its data processing terms.
