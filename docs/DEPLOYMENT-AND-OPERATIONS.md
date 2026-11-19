# Deployment and operations

How to run EduBridge in production and keep it running. Written for the founder (who handles hosting) and
whoever operates it. Hosting choices that `02-SOFTWARE-ARCHITECTURE.md` §13 leaves open (provider and region,
D-12) are still the founder's: this guide works with any provider that offers the pieces below.
**Nothing here should be bought, activated or deployed without the founder's approval** (CLAUDE.md §8–9).

## 1. Hosting architecture

| Piece | What it is | Notes |
| --- | --- | --- |
| Web | `npm run build`, then `npx next start -p $PORT` (Node 22) | Stateless; run 2 instances behind the load balancer for zero-downtime deploys |
| Worker | `npm run worker` (same image, same environment) | Exactly **one** instance. Delivers SMS/email, settles Mobile Money prompts, reconciles daily after 02:00 school time, prints report cards, sends automatic reminders, purges expired sign-ins |
| Database | PostgreSQL 16, managed, with point-in-time recovery | Holds everything, including uploaded files (logos, photos, documents, evidence) |
| Edge | HTTPS load balancer or CDN in front of the web | Terminates TLS; appends to `X-Forwarded-For` (used for audit IPs and rate limits). Set `TRUSTED_PROXY_HOPS` to the number of proxies in front of the web (§3) |

Recommended shape (decide with D-12): a managed container platform running one image as two services (web,
worker), plus a managed PostgreSQL in the same region. Europe (London or Frankfurt) or AWS Cape Town; test
latency from Accra and take legal advice on Act 843 cross-border transfer before choosing.

Health check: `GET /api/health` returns 200 `{"status":"ok"}` when the database answers, 503 otherwise. Use it
for the load balancer, the platform's restart policy and uptime monitoring.

## 2. Database production setup

1. Create the database and two roles (as the provider's admin user):
   - `edubridge_owner` — owns the schema; used **only** for migrations and operational scripts.
   - `edubridge_app` — the running app; `LOGIN`, **not** superuser, **no** `BYPASSRLS`. Row-level security
     (forced on every tenant table) is what keeps schools apart; a role that bypasses it must never run the app.
   - `edubridge_backup` — backups only: `LOGIN BYPASSRLS`, read-only (`GRANT pg_read_all_data TO
     edubridge_backup`). Forced row-level security applies to the owner too, so `pg_dump` as
     `edubridge_owner` stops at the first tenant table; this role is the one that can read every school.
     Its password lives only with the backup job.
2. Generate long random passwords for both; store them only in the secrets manager.
3. Run migrations from a one-off job or CI step: `MIGRATION_DATABASE_URL=… npm run db:migrate`. Migrations
   grant `edubridge_app` exactly what it needs (see the `*_rls.sql` and grant statements in `drizzle/`).
4. Never run `npm run db:seed` or `npm run demo:school` against production (synthetic data only, for
   development and demos).
5. Create the first platform administrator: the person signs up through an invitation or exists as a user,
   then `MIGRATION_DATABASE_URL=… npm run platform:admin -- grant them@yourdomain`. Platform access is never
   granted from inside the app. Platform administrators must set up two-step verification at first sign-in.
6. Connection limits: the web uses a small pool per instance; size the database for
   `(web instances × pool) + worker + migrations`. Use the provider's connection pooler in session mode if
   needed (transaction mode breaks `set_config` tenant context; do not use it).

## 3. Environment variables and secrets

Keep every value in the platform's secrets manager, never in the repository or an image. `.env.example`
lists them with explanations; production needs:

| Variable | Required | Purpose |
| --- | --- | --- |
| `NODE_ENV=production` | Yes | Turns on secure cookies, real providers, and refuses development fallbacks |
| `DATABASE_URL` | Yes | `edubridge_app` connection string (with `sslmode=require`) |
| `MIGRATION_DATABASE_URL` | Jobs only | `edubridge_owner`; give it to the migration job and operators, not to the web or worker |
| `APP_URL` | Yes | Public origin, e.g. `https://app.edubridge.example`; used in SMS links, emails and callbacks |
| `TRUSTED_PROXY_HOPS` | If not 1 | How many proxies append to `X-Forwarded-For` before the web (default 1: one load balancer). A CDN in front of the platform's load balancer makes 2. Wrong values let clients choose their own address (too high) or count every family as the proxy (too low), so check one request's audit IP after deploying |
| `MFA_ENCRYPTION_KEY` | Yes | 32 random bytes, base64. Encrypts two-step secrets, platform API keys and record-signing keys |
| `BREVO_API_KEY`, `EMAIL_FROM`, `EMAIL_FROM_NAME` | Yes | Email (invitations, password resets). Missing in production = messages fail, never silently dropped |
| `ARKESEL_API_KEY`, `SMS_SENDER_ID` | Yes | SMS (sign-in codes, receipts, reminders). Sender ID registered with Arkesel |
| `MOBILE_MONEY_PROVIDER` | Yes | The default for schools: `paystack` (or `none`). Each school's provider can be changed, or turned off, on its admin page |
| `MOBILE_MONEY_MOCK_SECRET` | For demo schools | Lets demo schools use the test provider in production (they never use a real one). Any long random string |
| `PAYSTACK_SECRET_KEY` | For payments | Test key until live payments are approved (§8) |
| `PAYSTACK_ALLOW_LIVE`, `PAYSTACK_CUSTOMER_EMAIL_DOMAIN` | Live only | Only after the founder approves live payments |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | For notifications | Web push to parents' phones (free; replaces announcement SMS for families who turn it on). Generate once with `node --input-type=module -e "import {generateVAPIDKeys} from 'web-push'; console.log(generateVAPIDKeys())"`; `VAPID_SUBJECT` is `mailto:` a support address (defaults to `APP_URL`). Keep the pair stable: changing it silently ends every phone's notifications. Without it the switch is hidden |
| `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` | For WhatsApp | Meta WhatsApp Cloud API: a permanent System User token and EduBridge's WhatsApp phone number id (§10). Without them families are not offered WhatsApp and every message goes by SMS |
| `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN` | For WhatsApp | The Meta app secret (checks every webhook's `X-Hub-Signature-256`) and a long random string you also enter as the webhook verify token |
| `WHATSAPP_GRAPH_VERSION`, `WHATSAPP_TEMPLATE_LANGUAGE` | No | Default `v24.0` and `en`; set the Graph API version Meta's changelog lists as current |
| `EDUBRIDGE_PAYSTACK_SECRET_KEY` | For invoice payments | EduBridge's **own** Paystack account (D-R3-5), not the one schools' Mobile Money uses. Test key until live is approved |
| `EDUBRIDGE_PAYSTACK_ALLOW_LIVE`, `EDUBRIDGE_PAYSTACK_CURRENCIES` | Live only | `true` only after the founder approves live invoice payments; currencies that account accepts (default `GHS`) |
| `PLATFORM_MFA_REQUIRED` | No | Leave unset (two-step required for platform staff) |

Not environment variables any more: the assistant's Anthropic key and the Transfer Passport signing keys are
managed by platform staff under **Admin → Integrations** (stored encrypted with `MFA_ENCRYPTION_KEY`). The
old `RECORD_SIGNING_*` and `ANTHROPIC_API_KEY` variables still work as fallbacks but should be left empty.

**`MFA_ENCRYPTION_KEY` is the one secret that cannot be lost.** Without it, every user with two-step
verification is locked out and the stored integration and signing keys are unreadable. Keep a copy in a
second, offline place (e.g. a sealed password-manager vault held by the founder). Rotating it:

1. Generate a new key. Set it as `MFA_ENCRYPTION_KEY` and the old one as `MFA_ENCRYPTION_KEY_PREVIOUS`;
   restart web and worker (both keys now open stored values).
2. Run `MIGRATION_DATABASE_URL=… npm run keys:rotate -- <platform admin email>` (prints counts only).
3. Remove `MFA_ENCRYPTION_KEY_PREVIOUS`; restart. Rotate after any suspected exposure, and when staff with
   access to secrets leave.

## 4. Domain and SSL

- One application domain (e.g. `app.edubridge.example`); schools are paths (`/s/{school}`), parents use `/p`.
  Custom domains per school are out of scope for R1.
- TLS from the platform or CDN (automatic certificates). Redirect HTTP to HTTPS; enable HSTS once stable.
- Set `APP_URL` to exactly the public origin; links in SMS and the Paystack webhook depend on it.
- Email: configure SPF, DKIM and DMARC for the sending domain in Brevo before inviting real users.
- Keep the service worker at `/sw.js` served from the same origin (the parent view and offline registers need it).

## 5. Backups and restoration

What to protect: the database (all records, the append-only ledger, audit log, and uploaded files) and the
secrets (especially `MFA_ENCRYPTION_KEY`). There is no other state: web and worker are disposable.

- Turn on the provider's **point-in-time recovery** with at least 14 days of retention.
- Also take a **daily logical dump** (`pg_dump -Fc` as `edubridge_backup`, §2) to storage in a different account
  or region, kept 30 days (and monthly copies for a year). Encrypt it; it contains children's and families' data.
- Restore drill, **before the first school goes live and then every quarter**: restore the latest dump into a
  scratch database (`pg_restore --no-owner --role=edubridge_owner`), run `npm run db:migrate` (no-op if up to
  date), point a staging web at it, sign in, open a school's fees and a receipt PDF, and check the record counts
  and the ledger total (`select sum(amount_pesewas) from ledger_entries`) against the source. Write down how
  long it took.
- Local drill, 2026-11-17 (development database, 7 schools, 633 students, 4,017 ledger entries): dump 1 s,
  restore 3 s, migrate no-op 1 s; record counts and the ledger total matched, every one of the 85 tenant tables
  still had row-level security enabled and forced, and the app role saw no rows outside a school. Repeat it
  on the real provider before go-live.
- Restoring production after data loss: stop the worker first (so no SMS or prompts go out from stale data),
  restore to a point just before the incident into a new database, check it, switch `DATABASE_URL`, start web,
  then the worker. Tell affected schools what time their data was restored to.

## 6. Monitoring and logging

- **Uptime:** an external check on `/api/health` every minute, alerting by SMS or email.
- **Logs:** web and worker write to stdout; keep 30 days in the platform's log store. The worker logs one
  line per piece of work (`notifications: … sent, … failed`, `mobile money: … checked …`,
  `reconciliation: … differences to review`, `report cards: …`); alert on `worker cycle failed`.
- **Errors:** add an error tracker (e.g. Sentry, `02` §3) with personal data scrubbed before turning it on.
  It is a paid service at scale, so it needs approval; until then, alert on error-level log lines.
- **Business signals to watch weekly:** failed notifications (Admin and each school's message history),
  Mobile Money prompts held for review, reconciliation differences left open (target: none older than 7 days),
  and SMS usage against plan limits (Admin → Billing).
- **Database:** alert on storage over 70%, connections near the limit, and long-running queries.

## 7. Security and access

- Only named people get platform administrator, each with two-step verification; review the list monthly
  (`platform_admins` table) and revoke leavers at once with `npm run platform:admin -- revoke`.
- Production database access: through the provider's console or a bastion, as `edubridge_owner`, by the
  founder and named engineers only; never from laptops with copied credentials. Every school data change
  should go through the app (it is audited); operator SQL changes need a written reason.
- Support access to a school happens only when its Proprietor allows it (Settings → Support access), for a
  limited time, and every page and change is shown to the Proprietor.
- Secrets: rotate database passwords and provider keys yearly and when anyone with access leaves.
- Keep dependencies patched: run `npm audit` and update monthly; apply PostgreSQL minor versions promptly.
  `next build` refuses to build a Next.js release with a known advisory, so a deploy can be blocked by one.
- Never set `NOTIFICATIONS_TRANSPORT=log` in production: it writes every message, sign-in codes included,
  to a file instead of sending it. It is for end-to-end tests only.
- The `Strict-Transport-Security` header includes `preload` and `includeSubDomains`. Submit the domain to the
  browsers' preload list only once every subdomain serves HTTPS; it is very slow to undo.
- Personal data: students', guardians' and medical records are the most sensitive; never copy production data
  into development or test databases (use the synthetic seed). Data protection obligations (Ghana Act 843 and
  each country's law) need legal review before schools outside Ghana go live.

## 8. Payment provider production configuration (Paystack)

Live payments stay **off until the founder approves them**. The code refuses a live key unless
`PAYSTACK_ALLOW_LIVE=true` is also set.

While in test mode (today): `MOBILE_MONEY_PROVIDER=paystack`, `PAYSTACK_SECRET_KEY=sk_test_…`. Staff and parents
see a "test mode, no money moves" notice.

Going live, after approval:

1. Complete Paystack business verification (EduBridge's account) and agree settlement terms (D-07: funds settle
   to each school; EduBridge never holds school money).
2. For each school: create its Paystack **subaccount** (its own bank or Mobile Money settlement account) and
   enter the subaccount code on the school's admin page (Admin → school → plan). Without it, live prompts are
   refused for that school.
3. In Paystack, set the webhook URL to `{APP_URL}/api/v1/mobile-money/callbacks/paystack`. Webhooks are verified
   by signature, and no payment is recorded until EduBridge has confirmed it with Paystack's verify API.
4. Set `PAYSTACK_SECRET_KEY=sk_live_…`, `PAYSTACK_ALLOW_LIVE=true` and `PAYSTACK_CUSTOMER_EMAIL_DOMAIN` (a domain
   EduBridge controls, used for the payer email Paystack requires). Restart web and worker.
5. Make one small real payment per network (MTN, Telecel, AT) to a pilot school, check the receipt, the
   school's ledger and the Paystack dashboard agree, then check the next morning's reconciliation is clean.
6. Paystack is enabled for GHS only. Schools billing in another currency have Mobile Money turned off
   automatically (staff and parents are not offered it) until a provider for their currency is added, tested
   and approved.

### 8a. EduBridge invoices paid online (SUB-04)

Schools pay EduBridge's invoices into **EduBridge's own Paystack account**, separate from the account and
subaccounts used for schools' Mobile Money (D-R3-5). Without `EDUBRIDGE_PAYSTACK_SECRET_KEY` the "Pay online"
button is hidden in production (development and end-to-end runs use a test mode in which no money moves).

1. Verify EduBridge's own Paystack business account; use its test key first.
2. On that account, set the webhook URL to `{APP_URL}/api/v1/billing/paystack`. The webhook is checked by its
   `x-paystack-signature`, and an invoice is marked paid only after Paystack's verify API confirms the full
   amount in the invoice's currency; the redirect back (`/s/{school}/settings/plan/paid`) checks the same way.
3. Going live, after approval: `EDUBRIDGE_PAYSTACK_SECRET_KEY=sk_live_…` and `EDUBRIDGE_PAYSTACK_ALLOW_LIVE=true`.
   A live key without the second variable switches online payment off.
4. A payment for an invoice already settled another way is kept and audited (`subscription_payment.duplicate`)
   for a refund or credit; it never pays the invoice twice.

## 10. WhatsApp Business (WAB-01)

EduBridge sends from **one WhatsApp Business number of its own** through Meta's WhatsApp Cloud API (no
reseller), with each school's name in the message. A school gets it when platform staff add the
**WhatsApp messages** module to its plan (a paid add-on, not in new plans by default); each family then turns
it on in the parent view, which is the opt-in WhatsApp requires. Meta charges per delivered template message;
set the price EduBridge charges schools under **Admin → Billing** (WhatsApp price). Messages that WhatsApp
cannot deliver go by SMS, and are charged as SMS.

1. Create the Meta Business portfolio and app, complete business verification, add the WhatsApp product and
   register EduBridge's number with display name "EduBridge".
2. Create a System User with `whatsapp_business_messaging` and `whatsapp_business_management`, generate a
   permanent token (`WHATSAPP_ACCESS_TOKEN`), and note the phone number id (`WHATSAPP_PHONE_NUMBER_ID`).
3. Webhook: callback URL `{APP_URL}/api/v1/whatsapp/webhook`, verify token `WHATSAPP_VERIFY_TOKEN`, subscribed
   field `messages`. `WHATSAPP_APP_SECRET` is the app secret. Delivered and read receipts then show in each
   school's delivery report; a STOP reply opts the number out at once.
4. In WhatsApp Manager, create these **Utility** templates in English (`en`), exactly as written. A template
   that is not approved, or recategorised by Meta, makes those messages fall back to SMS:

| Template | Body |
| --- | --- |
| `edubridge_payment_receipt` | Payment received by {{1}}: {{2}} for {{3}}, receipt {{4}}. {{5}} The receipt is in the EduBridge parent view. |
| `edubridge_fees_billed` | Fees notice from {{1}}: fees for {{2}} have been billed for {{3}}. {{4}} See the details in the EduBridge parent view. |
| `edubridge_fee_reminder` | A reminder from {{1}} about fees for {{2}}: {{3}} See the balance and pay at {{4}} Thank you. |
| `edubridge_absence_alert` | Attendance notice from {{1}}: {{2}} has been absent for {{3}}. Please contact the school. |
| `edubridge_announcement` | New announcement from {{1}}: {{2}}. Read it in the EduBridge parent view at {{3}} using this number. |
| `edubridge_portal_invitation` | Invitation from {{1}}: follow {{2}}'s fees, reports and news in the EduBridge parent view at {{3}} using this number. |
| `edubridge_consent_request` | Consent form from {{1}}: please answer "{{2}}" by {{3}} in the EduBridge parent view at {{4}} using this number. |
| `edubridge_event_reminder` | Reminder from {{1}}: {{2}}, {{3}}. Details are in the EduBridge parent view. |

5. Test with a pilot family who has opted in: each kind once, a STOP reply, and a number without WhatsApp
   (it must arrive by SMS).

## 9. Recovery and maintenance

**Deploying a new version**

1. CI must be green (format, lint, type check, unit and integration tests, Playwright).
2. Take a manual database snapshot.
3. Run migrations (`npm run db:migrate`) as a release job. Migrations only add or widen; they are written to work
   with the previous app version still running. Never edit an applied migration.
4. Roll out the web (one instance at a time), then restart the worker.
5. Smoke test: `/api/health`, sign in, a school's Fees page, a receipt PDF, the parent sign-in page.

**Rolling back:** redeploy the previous image. Do not reverse migrations by hand; if a migration itself is
wrong, write a new one. Restore from backup only for data loss (§5).

**Routine tasks**

| When | Task |
| --- | --- |
| Daily | Check uptime alerts and the worker's error lines |
| Weekly | Review held Mobile Money payments, reconciliation differences and failed messages; check backup jobs ran |
| Monthly | Dependency updates; platform admin and database access review; SMS usage and invoices (Admin → Billing) |
| Quarterly | Restore drill (§5); review signing keys under Admin → Integrations (rotate yearly) |
| Yearly | Rotate `MFA_ENCRYPTION_KEY`, database passwords and provider keys |

**When something breaks**

| Symptom | First checks |
| --- | --- |
| `/api/health` returns 503 | Database reachable? Connection limit reached? Credentials rotated without updating the app? |
| SMS not arriving | Worker running? `notifications: … failed` lines; Arkesel balance and sender ID; school SMS paused for an overdue EduBridge invoice or over its plan limit |
| Mobile Money stuck on "waiting" | Worker running? Paystack status page; the prompt is re-checked automatically and expires after 30 minutes |
| Two-step codes rejected for everyone | Server clock (codes are time-based); `MFA_ENCRYPTION_KEY` changed without `MFA_ENCRYPTION_KEY_PREVIOUS` |
| A school sees another school's data | Treat as a security incident: take the app offline, preserve logs, inform the founder at once |

**Go-live checklist (first paying school):** approvals recorded (hosting, region, paid services); secrets set and
`MFA_ENCRYPTION_KEY` copied offline; migrations applied; first platform admin with two-step; backups on and one
restore drill done; uptime alert working; email domain authenticated; SMS sender ID approved; Paystack in the
mode the founder approved; the school's plan, campuses and Proprietor invitation created from Admin.
