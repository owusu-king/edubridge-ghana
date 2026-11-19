# ADR 0003 — Modules, plans, add-ons and entitlements

|            |                                                                                                       |
| ---------- | ----------------------------------------------------------------------------------------------------- |
| Status     | **Accepted** (2026-11-17: founder approved the design and decisions D-R4-1 to D-R4-8 as recommended). R4-0 built the same day; differences are marked "As built" |
| Builds on  | ADR 0001 (one app plus a worker, logic in `src/server`), phase J (plans and limits), R3-6 (plan presets, requests, invoices) |
| Requested  | Founder instruction of 2026-11-17: EduBridge as a modular, subscription-based SaaS, before R4 starts   |

## Summary

EduBridge already has the core of this: a list of modules (`src/lib/plan.ts`), each school's plan as a copy
(`tenant_entitlements`), plan presets, plan-change requests decided by EduBridge staff, invoices with online
payment, automatic subscription status, and one server-side check (`allowed` / `assertAllowed`) that combines the
member's role with the school's plan. **This ADR extends that system; it does not add a second one.** The changes:

1. A **module registry** in code that covers the whole product (built, R4 and planned), with each module's
   permissions, routes, navigation, dependencies, release stage and commercial availability.
2. **Add-ons, trials and promotions per module** with their own dates and agreed prices (`school_modules`), on top
   of the plan's modules.
3. **Release stages** kept apart from entitlements: a module that is built is not sold, and a module that is sold is
   not shown to a school until it is released to it.
4. **One resolver** that works out each school's active modules, used by every enforcement point: services, pages
   and direct URLs, the API, navigation, background jobs, the parent view and exports.
5. Catalogue prices per billing period, a platform audit log, and requests for add-ons through the existing
   plan-change requests.

## 1. Existing module inventory (R0–R3, as built)

"Gated" means a school's plan can leave it out today; everything else is in every plan.

| Area | What is built | Gated today | Main code |
| --- | --- | --- | --- |
| School and platform | School profile, branding, campuses (limit), setup guide, overview, members and roles, two-step policy, audit log, support access, data export, settings | No | `tenancy`, `members`, `support`, `exports`, `setup`, `dashboard` |
| Students and families | Students, guardians and roles, families, import, photos, documents, medical, statuses, search | No | `students`, `imports`, `files` |
| Academic structure | Calendar, terms, holidays, levels, classes, term moves, teaching model, country templates | No | `academics` |
| Fees and finance | Fee items and structures, append-only ledger, billing, payments and receipts, voids, refunds, opening balances, discounts and sibling rule, payment plans, owing list, reports, closing the books, statements, offline provisional receipts, WhatsApp share links | No | `fees` |
| Communication | Announcements (scheduled, by audience, push), events and consent forms, receipt and fees-billed SMS, message history, delivery report | No | `messages`, `events`, `notifications` |
| Timetable (R2) | Periods, lessons per class, teacher clashes | No | `timetable` |
| Insights (R3-T) | Term trends, results, attendance and money insights | No | `insights` |
| Transfer Passport (R3-S) | Learner identity, signed records, transfers, verification | No | `passport` |
| API and sync (R3-Q/R) | `/api/v1`, device tokens, offline sync | No | `api`, `sync` |
| Attendance | Class registers (offline), lesson registers, absence SMS, holidays | **Yes** `attendance` | `attendance` |
| Assessment | Subjects, schemes, grade bands, score sheets, report cards (4 layouts), approval, bulk printing | **Yes** `assessment` | `assessment` |
| Parent view | SMS-code sign-in, balances, receipts, statements, report cards, forms, news, push, parent payments, balance links | **Yes** `parent_view` | `parents` |
| Fee reminders | Staff SMS reminders and automatic reminders | **Yes** `fee_reminders` | `fees/reminders` |
| Mobile Money | Prompts, callbacks, reconciliation, held payments (Paystack, mock) | **Yes** `mobile_money` | `mobile-money` |
| Admissions | Inquiries to enrolment, online applications, offers, admission fees | **Yes** `admissions` | `admissions` |
| WhatsApp | Utility templates to families who opted in, SMS fallback | **Yes** `whatsapp` (paid) | `notifications/whatsapp` |
| Assistant (AI) | Read-only, audited answers from school records | **Yes** `assistant` (paid, off by switch) | `assistant` |

How it is enforced today:

- **Services.** `assertAllowed(ctx, permission)` checks the role, then the module behind the permission
  (`FEATURE_FOR` in `src/server/authz/permissions.ts`).
- **Navigation and settings tabs.** Built from permissions through `allowed()`.
- **Pages.** Pages call `allowed()` themselves.
- **API.** The API reaches the same services.
- **Background jobs and the parent side.** These read `tenant_entitlements.features` directly, in six places
  (reminders, Mobile Money, WhatsApp, parent schools, balance links, online applications).
- **Limits.** The limits on students, campuses and SMS per month are checked on the server.
- **Subscription status.** Trial → active → grace → payment overdue moves automatically (SUB-05). Payment overdue
  pauses school SMS only, and nothing else stops.
- **Missing schools.** A school without a plan row gets every module (tests, demo schools).

## 2. Module categorisation across releases

Module identifiers are stable strings. The eight that exist keep their identifiers, because they are stored in
`tenant_entitlements.features` and `plan_presets.features`.

| Category | Module (id) | Release | Commercial availability (proposed) |
| --- | --- | --- | --- |
| Core platform | `school_core` (profile, campuses, members, security, audit, support access, setup, overview, data export) | R0–R1 | Always included |
| Core platform | `api_sync` (API, devices, offline sync) | R3 | Always included |
| Students | `students` (students, guardians, families, import, records) | R1 | Always included |
| Academics | `academic_structure` (calendar, classes, term moves, templates) | R1 | Always included |
| Finance | `fees` (the whole fees and ledger area) | R1 | Always included: it is the product's wedge |
| Communication | `communication` (announcements, events, consent forms, message history) | R1–R3 | Always included |
| Academics | `timetable` | R2 | Always included today; see decision D-R4-3 |
| Intelligence | `insights` | R3 | Always included today; see decision D-R4-3 |
| Students | `transfer_passport` | R3 | Always included today |
| Academics | `attendance` | R2 | Plan module and add-on |
| Academics | `assessment` | R2 | Plan module and add-on |
| Families | `parent_view` | R1 | Plan module and add-on |
| Finance | `fee_reminders` | R1 | Plan module and add-on |
| Finance | `mobile_money` | R1 | Plan module and add-on |
| Growth | `admissions` | R3 | Plan module and add-on |
| Communication | `whatsapp` | R3 | Add-on (usage-billed) |
| Intelligence | `assistant` | R3 (built, off) | Add-on, once the paid service is approved |
| Staff | `staff_hr` (profiles, employment records, departments, positions, documents, leave, staff attendance) | **R4** | Plan module and add-on |
| Staff | `payroll` (salary structures, payroll records, payslips, reports; no statutory tax calculation) | **R4** | Plan module and add-on |
| Welfare | `safeguarding` (restricted incident and case records) | **R4** | Included in every plan (D-R4-4) |
| Welfare | `visitors_pickup` (visitor log, authorised collectors, pickup records) | **R4** | Plan module and add-on |
| Operations | `transport` (vehicles, drivers, routes, stops, assignments, transport fees through the ledger, trip records) | **R4** | Plan module and add-on |
| Operations | `inventory_assets` (stock, assets, vendors, purchase requests, maintenance requests) | **R4** | Plan module and add-on |
| Operations | `library` (catalogue, copies, loans, returns, overdue, reservations, fines) | **R4** | Plan module and add-on |
| Operations | `boarding` (houses, rooms, beds, assignments, exeat, boarding fees through the ledger) | **R4** | Plan module and add-on |
| Intelligence | `forecasting` (collection forecasting) | R5, planned | Not decided |
| Intelligence | `early_warning` (academic early-warning indicators, reviewed by teachers) | R5, planned | Not decided |
| Intelligence | `command_center` (full Command Center) | R5, planned | Not decided |
| Intelligence | `ai_drafting` (drafting tools with human approval) | R5, planned | Not decided |

Grouping follows how schools buy, not how the code is split. Leave and staff attendance are part of `staff_hr`;
lesson registers and absence SMS stay part of `attendance`; parent payments are part of `mobile_money` used
through `parent_view`. Inside a module, finer controls remain school settings (for example lesson registers on or
off) or permissions, not paid modules.

## 3. Subscription and add-on model (proposed; no prices)

A school's entitlement is **its plan's modules, plus its add-ons, plus the core modules**, limited by the plan's usage
limits.

- **Plans** stay as presets (`plan_presets`, SUB-01), copied onto the school (`tenant_entitlements`). A
  copy means editing a plan never changes schools already on it (decided in R3). A preset gets a price for each
  billing period it is sold on (monthly, termly, annual) and currency. Each price is either a flat amount or a
  price per active student, because risk C-01 suggests pricing per enrolled student per term (D-R4-2).
- **Proposed plan boundaries** (names and contents for the founder to decide, D-R4-2):

  | Plan | Modules beyond the core | Typical school |
  | --- | --- | --- |
  | Essentials | `parent_view`, `fee_reminders`, `mobile_money` | Wants fees and families sorted first |
  | Professional | Essentials + `attendance`, `assessment`, `admissions`, `visitors_pickup` | Full academic year in EduBridge |
  | Enterprise | Professional + `staff_hr`, `payroll`, `transport`, `inventory_assets`, `library`, `boarding` as released, `whatsapp`; higher limits, several campuses; negotiated terms | Groups and large schools |
  | Pilot (existing) | Today's default (everything except `assistant` and `whatsapp`) | Pilot schools, unchanged |

- **Add-ons.** Any module marked purchasable can be added to any plan, for example `attendance` on Essentials,
  so a school does not have to change tier for one module. Each add-on has its own start date, optional end date,
  billing period and agreed price. The catalogue price is the starting point, and a negotiated price is stored on
  the school's row.
- **Trials and promotions.** These are the same rows with a source of `trial` or `promotion`, an end date and
  usually no price. The subscription-level trial (`trial_ends_on`) is unchanged.
- **Enterprise arrangements.** The school's plan copy can be edited freely, and add-ons can have the source
  `enterprise` with negotiated prices and notes. There is no school-specific code (`13` C-09).
- **Usage limits.** Keep the existing ones: active students, campuses and SMS per month. WhatsApp is metered as
  today. Add a new limit only when a module needs one (none is needed for R4).
- **Upgrades, downgrades, add-on requests and cancellations.** These go through the existing plan-change requests
  (D-R3-4: the school asks, EduBridge staff decide). A request can also name a module to add or cancel. A
  cancelled add-on ends at the end of its paid period.
- **Invoices and renewals.** The invoice suggestion on the school's admin page adds a line for each paid add-on
  for the period. Payment, online payment, grace periods and automatic status are unchanged. Invoices issued
  automatically each period are prepared for, not built (§10).
- **Discounts.** These are a negotiated price on the plan or on the add-on. Separate discount lines and proration
  are deferred.

## 4. Module dependency map

A module is active only when every module it depends on is active. The core modules are always active.

```
fees (core) ──► fee_reminders
            ├─► mobile_money ──► (parent payments need parent_view too: feature-level)
            ├─► transport (transport fees as fee items)      ┐
            ├─► boarding (boarding fees as fee items)        ├─ fees are core, so these only
            └─► library (fines, optional)                    ┘  depend on modules always present
parent_view ──► whatsapp (families opt in from the parent view)
staff_hr ──► payroll
students (core) ──► visitors_pickup (authorised collectors build on guardian roles)
safeguarding ◄── boarding (house incidents are recorded as safeguarding cases when both are active)
attendance, assessment ──► insights and the assistant read them only when active
```

The dependencies are declared in the registry, checked when platform staff grant a module (with a clear message),
and checked again by the resolver, so a lapsed dependency switches the dependant off as well.

## 5. Entitlement architecture

**Three separate questions, answered in one place:**

| Question | Kind | Where it lives | Who changes it |
| --- | --- | --- | --- |
| Is this module released to this school? | Release control | Stage in the registry (code), plus `module_release_access` for pilot and internal-testing schools | Engineering (stage, by deploy) and platform staff (pilot schools) |
| Has this school got the module? | Entitlement | `tenant_entitlements.features` (plan) and `school_modules` (add-ons, trials, promotions) | Platform staff |
| Does the school use it, and how? | School setting | `school_preferences` (for example lesson registers, online applications, the assistant switch) | The school |
| Can this member do this action? | Permission | Roles and school grants (`permissions.ts`) | The school |

Deployment switches (`PAYSTACK_ALLOW_LIVE`, provider keys) stay environment variables. They say what this
deployment can do, not what a school has bought.

**Release stages** (in the registry): `planned` (listed, not built, never reachable), `in_development` (reachable only
outside production), `internal_testing` (demo schools and schools with release access), `ready` (finished,
waiting for a release decision; same reach as internal testing), `pilot` (schools with release access),
`general` (every entitled school), `deprecated` (no new sales; existing schools keep it), `retired` (off for
everyone; data kept and exportable). Being built never makes a module available; selling it never releases it.

**The resolver** (`src/server/entitlements`), run once per request (and once per school in each worker cycle):

```
active(school, m)    = core(m)
                       or ( released(school, m)
                            and entitled(school, m, today)
                            and every d in requires(m): active(school, d) )
entitled(school, m)  = school.isDemo
                       or m in plan modules
                       or a school_modules row for m covers today (start <= today <= end, not ended)
permission allowed   = role or school grant allows it
                       and ( module(permission) is active
                             or (module is read-only for the school and the permission is a read) )
```

It returns, for each module, `active`, `read_only` or `off`, with the source and end date for display. The
existing `Access.features` becomes the list of active modules, so every current `allowed()` / `assertAllowed()` call
keeps working unchanged.

**Read-only after an end** (D-R4-5): when an add-on, trial or promotion ends, its module is read-only for a
retention window (default 90 days, a platform setting). People can view and export, but not change. After that it
is off: the data is kept and still exportable, and reactivating brings everything back. Each R4 module's
permissions are split into reads and changes from the start. R3 modules keep today's behaviour (off means off;
families still see published report cards; exports always work) until their permissions are split, which is
deliberately not part of R4.

**Enforcement points**, all driven by the registry and the resolver:

1. **Services.** Unchanged calls (`assertAllowed`). The permission-to-module map moves into the registry and
   becomes exhaustive: adding a permission without naming its module (or `core`) fails the type check.
2. **Pages, direct URLs, server actions and file downloads.** `requireTenant` reads the request path, which the
   proxy always sets and the client cannot, and refuses with "not found" when the route's module is not active.
   Route prefixes are declared in the registry. Page-level checks stay as a second layer.
3. **API.** Each route in `src/server/api/router.ts` names its module, and dispatch checks it before the handler
   runs.
4. **Navigation and settings tabs.** Generated from the registry and the resolver.
5. **Background jobs.** Each job names its module and asks the resolver per school. This replaces the six direct
   reads of `features`. Compliance jobs (data retention, purges) and settling money already in flight (Mobile
   Money callbacks after a module is turned off) always run: these are documented exceptions.
6. **Parent view and balance links.** Use the resolver (today `parents/schools.ts` and `balance-links.ts` read
   `features`).
7. **Exports.** Data export includes every module's records whatever the entitlement (portability, Act 843 right of
   access). R4 modules add their datasets.
8. **Tests.** A registry-driven matrix: for every non-core module, a school without it gets "not found" on each
   declared route prefix, a refusal from each of its permissions, and 404 from its API routes. A school with it
   gets through. This turns "hiding a menu is not enough" into a test that fails when a new route is not declared.

**Caching.** Entitlements are read from the database on every request (two indexed reads), and once per school
in each worker cycle. So a change applies on the next request, and no invalidation is needed. If a cache is added
later, `tenant_entitlements.updated_at` and the latest `school_modules` change serve as its version.

## 6. Database changes (R4-0)

All are additive. No R3 table loses a column or changes meaning.

| Change | Purpose |
| --- | --- |
| `school_modules` (tenant, module, source `addon` / `trial` / `promotion` / `enterprise`, starts_on, ends_on, billing period, agreed price, currency, note, granted by/at, ended at/by/reason) | Add-ons, trials and promotions with dates and prices. Insert, then end once (trigger); never deleted, so it is also the history. RLS enabled and forced; platform staff write, the school reads its own |
| `module_release_access` (tenant, module, granted by/at, ended at/by) | Pilot and internal-testing schools, kept apart from entitlements. RLS as above |
| `catalog_prices` (a plan preset **or** a module, billing period, currency, price, unit `flat` / `per_student`, archived) | Catalogue prices for plans and add-ons, configurable, never hardcoded. Platform table, readable by every school. A change archives the old price (history kept). The single price on `plan_presets` stays as before. *As built: one table instead of the proposed `module_prices` and `plan_preset_prices`, since both held the same columns* |
| Widen the `features` check on `tenant_entitlements` to the registry's plan modules | Lets plans include R4 modules (and the planned R5 ids, so no migration is needed when they are built) |
| `plan_change_requests.kind` (`plan`, `add_module`, `cancel_module`) and `module` | Add-on requests through the existing workflow; the decided-once trigger covers both columns |
| `platform_settings.module_read_only_days` (default 90, 0–365) | The read-only window after an add-on ends (ENT-08) |
| Platform log: the existing `platform_events` | Catalogue, price and release-access changes, which belong to no school. Changes to a school's modules are written to the school's audit log too. *As built: `platform_events` (already used for integrations) instead of a new `platform_audit_events`* |

Migrations: `0097_modules_entitlements` (tables and columns) and `0098_modules_entitlements_rls` (grants, policies,
end-once and archive-once triggers, enum checks).

The R4 operational modules get their own tables at the start of each module, each tenant-scoped with RLS
enabled and forced (the existing integration test checks this). Money from transport, boarding and library goes
through the existing ledger as fee items, never a second ledger.

## 7. Integration with authentication, authorisation and billing

- **Authentication.** No change. Sessions, device tokens, parent sessions and two-step verification stay as they
  are.
- **Authorisation.** `allowed()` and `assertAllowed()` keep their signatures, and only the module map moves into the
  registry. School grants (such as Accountants voiding receipts) still need the module to be active. Support
  access (PLT-02) works with the school's entitlements, never more, so support cannot see an unbought module.
- **Billing.** The same `tenant_entitlements`, presets, requests, invoices, online payment (SUB-04), automatic
  status (SUB-05) and SMS and WhatsApp usage, extended with add-on lines and catalogue prices. The invoice payment
  provider stays behind the existing `invoicePaymentsFromEnv` interface, so it is not tied to Paystack.
- **Platform administration.** New: a Modules page (registry, stages, release access, add-on prices) and add-ons
  on the school's admin page. Extended: Plans (prices per period, modules from the registry).
- **School administration.** Settings, Plan shows the plan's modules, active add-ons with end dates, read-only
  modules, available add-ons with catalogue prices where set, usage against limits, requests and invoices.

## 8. Security and tenant isolation

- Every new tenant table has `tenant_id`, RLS enabled and forced, `withTenant` access, and writes allowed to
  platform staff only through the existing `app_is_platform_admin()` policy pattern, as `tenant_entitlements` does.
- A school can read only its own entitlements; catalogue tables carry no school data.
- The release stage is in code, so a school cannot raise it. Release access and add-ons are written only by
  platform staff with two-step verification, and audited both in the platform log and in the school's log.
- Platform staff do not gain school data by managing entitlements: changing a school's modules uses the platform
  admin path, which reads `tenant_entitlements` and `school_modules` only. Opening the school still needs a
  support grant.
- The route check uses the path set by the proxy (`x-edubridge-path`, always overwritten) and never a client
  value.
- Safeguarding (R4) needs stricter rules than student records: a designated-lead permission granted per member
  by the Proprietor, every view recorded (like medical records), records out of the assistant and insights, and
  support access excluded unless the Proprietor allows it specifically (D-R4-6).

## 9. Compatibility risks for R3

| Risk | Mitigation |
| --- | --- |
| **No R3 baseline exists in git**: R1-completion to R3 work (migrations 0065–0096) is uncommitted | The founder commits and tags it (for example `r3-pilot`) **before** R4 code is written. This is the only way R3 can be deployed and recovered on its own |
| R4 migrations become mandatory for an R3 deployment | R3 deploys from its tag with migrations up to 0096. R4 migrations are additive only, so R3 code also runs against an R4-migrated database, and the app can be rolled back without restoring the database |
| An R3 hotfix needs a migration after R4 migrations exist (the Drizzle journal is linear) | Hotfix migrations take the next number on the R3 branch and are merged into `main` first. R4 migrations not yet deployed are renumbered after them |
| Unfinished R4 modules reach pilot schools | Stage `in_development` is unreachable in production, and every R4 module is off in every plan until released |
| The registry refactor changes what a pilot school sees | Existing module ids, plan rows and the "no plan row = everything" rule are kept. A test asserts that every R3 permission maps to the same module as before. Navigation output is compared before and after |
| The new route check blocks a page a school uses | Only modules that are already gated get route prefixes, and the core modules have none. The full end-to-end suite must pass unchanged |
| Read-only behaviour changes R3 | Not applied to R3 modules in R4 (D-R4-5) |

## 10. Implementation sequence

| Step | Work | When |
| --- | --- | --- |
| R4-0a | Registry (`src/lib/modules.ts`, replacing `FEATURES` with compatible ids), exhaustive permission-to-module map, navigation from the registry; no behaviour change | R4, first |
| R4-0b | Resolver and enforcement: `requireTenant` route check, API route modules, jobs and parent side through the resolver, registry-driven test matrix | R4 |
| R4-0c | `school_modules`, `module_release_access`, release stages, add-ons, trials and promotions on the school's admin page, platform audit log | R4 |
| R4-0d | Catalogue prices (`catalog_prices`), Settings, Plan with modules, add-ons and available modules, add-on requests, add-on invoice lines | R4 |
| R4-1… | Operational modules, each `in_development` until it passes its tests, then released to pilot schools (roadmap, R4) | R4 |
| Prepared, not built | Self-service purchase with instant activation, invoices issued automatically each period, proration, discount lines, module limits beyond students, campuses and SMS, an entitlement cache, splitting R3 permissions into read and change | Later, when pilots need them |
| Not in R4 | R5 modules (registry entries only, stage `planned`) | R5 |

## Alternatives considered

- **Every module and plan in database tables, edited at run time.** Rejected: modules are code (routes,
  permissions, tables). A database row for a module that the code does not have cannot work, and two sources of
  truth would drift. Commercial configuration (plans, prices, add-ons) is in the database; module definitions are
  in code.
- **A third-party feature-flag or billing service.** Rejected for now: it adds a dependency and cost for a few
  dozen modules and schools, and would split the audit trail. The design does not prevent one later.
- **A separate entitlement check at every call site.** Rejected: one resolver behind `allowed()` and the route
  check is easier to test and harder to forget.
