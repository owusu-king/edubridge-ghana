# 01 — Product Requirements Document

| | |
|---|---|
| Status | **Draft — awaiting founder approval** |
| Phase | 0 — Discovery and architecture |
| Source | `docs/00-PROJECT-BIBLE.md` |
| Related | `02-SOFTWARE-ARCHITECTURE.md`, `13-RISKS-AND-ASSUMPTIONS.md` |
| Last updated | 2026-10-31 |

---

## 1. Purpose of this document

The project bible describes the full long-term vision: about 18 modules, AI capabilities and an executive command center. This document turns that vision into a **sequenced, testable product definition**. It covers:

1. Who the users are and which problems we solve for each.
2. What the first sellable release (the **MVP / Pilot release**) contains, and what it deliberately leaves out.
3. Functional requirements with acceptance criteria for the MVP.
4. Non-functional requirements that apply to every release.
5. How we will measure success.

Items marked **[DECISION]** need founder approval. Items marked **[ASSUMPTION]** are recorded in `13-RISKS-AND-ASSUMPTIONS.md` and should be validated with real schools.

---

## 2. Product summary

EduBridge is a multi-tenant School Management and Education Operations platform. It starts in Ghana's private and international schools and is built to expand across Africa.

**Positioning statement.** For school owners and bursars in Ghanaian private and international schools who lose money and time to fragmented fee records and manual parent communication, EduBridge is a school operations platform that gives parents clear financial and academic visibility on their phones and gives the school a single, auditable source of truth. Generic school software focuses on feature count. EduBridge competes on financial correctness, parent experience and reliability on ordinary Android phones and connections.

### 2.1 Where we win first

The bible lists ten operational problems. Our first release attacks the ones with the **most direct, measurable financial impact**:

| Problem (bible §2.2) | Why first | MVP answer |
|---|---|---|
| Parents do not receive timely fee statements | Directly delays revenue | Invoices, statements and SMS/email delivery |
| Schools struggle to collect outstanding fees | Direct revenue impact; owner's top pain | Arrears views, reminders, online payment |
| Financial records are fragmented | Root cause of reconciliation pain | Single, immutable ledger per student and family |
| Parents have limited visibility | Drives parent satisfaction and payment speed | Mobile-first parent portal |
| School owners lack reliable reporting | Buyer is the owner | Owner overview built only from real ledger data |

Academic management, attendance, admissions CRM and operations modules follow in later releases (§6). **[DECISION D-01]** Approve this "finance and parent first" MVP focus.

---

## 3. Users and personas

A single person can hold different roles in different schools. A teacher at School A can be a parent at School B. Roles are **per school membership**, not per user (see `05-ROLES-AND-PERMISSIONS.md`).

| Persona | Primary goals | Primary device | MVP? |
|---|---|---|---|
| **School owner / director** | See money billed, collected and outstanding; trust the numbers; compare campuses | Laptop and phone | Yes |
| **School administrator** | Set up the school, manage students, classes and guardians; onboard parents | Desktop | Yes |
| **Bursar / accountant** | Configure fees, bill students, record and reconcile payments, issue receipts, chase arrears | Desktop | Yes |
| **Parent / guardian** | Know what is owed, pay easily, get receipts, see children's information | Low-to-mid-range Android phone, often on mobile data | Yes |
| **Headteacher / principal** | Academic oversight, approvals | Desktop and phone | Partial (read access) |
| **Teacher** | Attendance, assessment entry, report-card comments | Phone and shared laptop | Release 2 |
| **Student** | View timetable, assignments, results | Phone | Release 3+ |
| **Platform administrator (EduBridge staff)** | Onboard schools, manage subscriptions, support | Desktop | Yes (internal) |
| Transport, boarding and other staff | Module-specific operations | Phone | Release 4+ |

### 3.1 Persona detail: the parent (highest design priority)

- Often has more than one child, sometimes at more than one school.
- Uses an affordable Android phone with limited storage. May have a slow or intermittent connection, and data costs money.
- Usually pays with **Mobile Money**, sometimes cash at the school or by bank transfer.
- Wants to see "how much do I owe, for which child, by when", pay, and get a receipt, **without calling the school**.
- May share a phone with other family members. Session security and privacy on shared devices matter.
- English literacy varies. Copy must be short and plain, and must not rely on finance jargon.

### 3.2 Persona detail: the bursar (highest correctness priority)

- Currently works in spreadsheets, receipt books and bank or MoMo statements.
- Their credibility depends on numbers reconciling. A single wrong balance shown to a parent destroys trust in the product.
- Needs bulk operations: billing 600 students at the start of term, posting many payments from a statement.
- Must be able to correct mistakes **without deleting history** (reversals and adjustments).

---

## 4. Scope overview by release

The full module catalogue from the bible is mapped to releases in `11-DEVELOPMENT-ROADMAP.md`. The summary:

| Release | Name | Contents | Bible phases |
|---|---|---|---|
| **R0** | Foundation (internal) | Tenancy, auth, roles, audit, school/campus setup, design system | Phase 1 |
| **R1** | **Pilot / MVP** | Students, guardians, classes, academic years and terms, fees, invoicing, manual payments, receipts, statements, parent portal, SMS/email for finance events, one online payment provider, owner finance overview | Phases 2, 3 and part of 4 |
| R2 | Academic core | Attendance (including offline), subjects, assessments, grading, report cards, teacher experience | Phase 5 |
| R3 | Growth | Admissions CRM, additional payment providers, advanced notifications, web push, subscription self-service | Phases 4 and 8 |
| R4 | Operations | HR and payroll records, library, transport, boarding, inventory, safeguarding | Phase 6 |
| R5 | Intelligence | EduBridge Intelligence, forecasting, full Command Center, AI productivity tools | Phase 7 |

**Why not follow bible phases strictly?** The bible puts payments and communication (Phase 4) after financial management (Phase 3), and puts the Command Center in Phase 7. We keep the bible's principle, *financial correctness before payment gateways*, inside R1's internal build order. But a pilot school will not pay for a fee system that cannot notify parents or accept Mobile Money, so R1 includes **one** provider and **SMS/email for finance events only**. A minimal owner finance overview, built strictly from real ledger data, is also in R1 because the owner is the buyer.

---

## 5. MVP (R0 + R1) functional requirements

Each requirement has an ID for traceability into tests (`10-TESTING-STRATEGY.md`) and the roadmap.

### 5.1 Platform and tenancy (TEN)

| ID | Requirement | Acceptance criteria |
|---|---|---|
| TEN-01 | A platform administrator can create a school tenant with a unique slug, legal name, country, default currency and timezone | Tenant created; default roles seeded; audit entry written; slug unique across the platform |
| TEN-02 | Every tenant's data is isolated | Automated tests prove a user of tenant A cannot read or write tenant B's data through any API, even when supplying B's identifiers (see `07-SECURITY-AND-PRIVACY.md`) |
| TEN-03 | A school can have one or more campuses | Campus CRUD; campus limit enforced from the subscription entitlement, not hardcoded |
| TEN-04 | A school can upload its logo and set a brand accent colour within the design-system constraints | Branding appears on the portal, receipts, invoices and statements; colour contrast validated (WCAG AA) |
| TEN-05 | Subscription entitlements (feature flags, student limit, campus limit) are stored per tenant and checked server-side | Exceeding a limit is blocked with a clear message; limits are editable by the platform admin without code changes |

### 5.2 Identity, access and audit (IAM)

| ID | Requirement | Acceptance criteria |
|---|---|---|
| IAM-01 | Users sign in with email or Ghanaian phone number plus password | Passwords hashed with a memory-hard algorithm; rate-limited; generic error messages |
| IAM-02 | Parents can sign in with a one-time code sent by SMS **[DECISION D-02]** | OTP single-use, expires within 10 minutes, rate-limited per phone and IP |
| IAM-03 | Password reset via email or SMS | Token single-use and time-limited; all other sessions revoked on reset |
| IAM-04 | A user can belong to several schools, with different roles in each | School switcher shows only the user's memberships; the active school is resolved server-side on every request |
| IAM-05 | Role- and permission-based authorization, enforced on the server, with optional campus restriction | Permission matrix tests per role (see `05`) |
| IAM-06 | MFA (TOTP) available for all staff, and **required** for owner, bursar and platform-admin roles **[DECISION D-03]** | Users in those roles cannot access financial functions until MFA is enrolled |
| IAM-07 | Administrators can deactivate a membership; sessions are revoked immediately | Deactivated user's next request fails; audit entry written |
| IAM-08 | Sensitive actions are audit-logged: who, what, when, from where, and before/after values | Audit log is append-only and visible to authorized roles; covers all financial mutations |

### 5.3 School academic structure (ACS) — minimal for R1

| ID | Requirement | Acceptance criteria |
|---|---|---|
| ACS-01 | Configure academic years with start and end dates | Only one *current* year per school; years cannot overlap |
| ACS-02 | Configure terms or semesters within a year (default template: three terms) | Term dates fall within the year and do not overlap |
| ACS-03 | Configure levels (e.g. Creche, Nursery 1, KG 2, Primary 4, JHS 2, Year 7, Grade 10) and classes/streams per level per campus | Ghanaian level templates offered; fully editable; no level names hardcoded in logic |
| ACS-04 | Promote students between classes at year end, in bulk | Preview before commit; enrollment history preserved; reversible until confirmed |

### 5.4 Students and guardians (SIS)

| ID | Requirement | Acceptance criteria |
|---|---|---|
| SIS-01 | Create and edit student profiles: legal names, preferred name, date of birth, gender, photo, admission number, status | Admission number unique per school; configurable format |
| SIS-02 | Student enrollment history: class, campus, year, start and end, reason | History is never overwritten; changes create new records |
| SIS-03 | Student status lifecycle: applicant → active → (suspended) → withdrawn / transferred / graduated | State transitions validated; reason recorded; audit written |
| SIS-04 | Guardian records with relationship type, contact details and flags (primary contact, fee payer, emergency contact, pickup authorized, receives communications) | Several guardians per student; one guardian linked to several students |
| SIS-05 | Families: group siblings with shared guardians for family-level billing views | Family balance equals the sum of member student balances (tested) |
| SIS-06 | Medical and emergency information, restricted to authorized roles | Access logged; hidden from roles without permission |
| SIS-07 | Bulk import of students and guardians from CSV/Excel templates with validation preview | Row-level errors shown; nothing committed until the whole file validates; import is idempotent |
| SIS-08 | Documents attached to a student record, stored privately | Downloaded only via short-lived signed URLs; access logged |
| SIS-09 | Search and filter students by name, admission number, class, status and guardian phone | Paginated; responsive under 500 ms for 5,000 students |

### 5.5 Parent access (PAR)

| ID | Requirement | Acceptance criteria |
|---|---|---|
| PAR-01 | A school invites a guardian to the portal by SMS or email | Invitation link single-use and expiring; accepted only by the invited phone or email |
| PAR-02 | **Verification before access**: a portal account is linked to a guardian record only through a school-issued invitation or verified OTP to the phone number on file **[DECISION D-04]** | No self-service claim of students by name, admission number or date of birth alone |
| PAR-03 | One parent account sees all linked children across all schools that use EduBridge | Each school's data still resolves under that school's tenant context |
| PAR-04 | The school can revoke a guardian's portal access (e.g. custody changes) | Revocation is immediate; audit entry written |
| PAR-05 | Notification preferences per channel | Statutory or essential messages (e.g. receipts) cannot be fully disabled; marketing messages are opt-in |

### 5.6 Fees and billing (FIN) — flagship

| ID | Requirement | Acceptance criteria |
|---|---|---|
| FIN-01 | Configure fee items (tuition, admission, exam, transport, boarding, feeding, uniform, books, PTA levy, custom) with categories | Items are tenant-defined; categories drive reporting |
| FIN-02 | Fee structures: amounts per item per level/class per term, optional or mandatory | Structures are versioned; changing a structure never alters issued invoices |
| FIN-03 | Generate invoices individually or in bulk for a term | Bulk generation runs as a background job with progress; re-running is idempotent (no duplicate invoices) |
| FIN-04 | Invoice lifecycle: draft → issued → partially paid → paid; also void and overdue | Issued invoices are immutable; corrections use credit notes or adjustments |
| FIN-05 | Discounts, scholarships and bursaries (percentage or fixed, per item or per invoice, with reason and approver) | Applied as explicit lines; approval required above a configurable threshold |
| FIN-06 | Installment plans with due dates | Overdue status computed per installment |
| FIN-07 | Record manual payments (cash, bank transfer, MoMo to the school's own number, cheque) with reference and evidence attachment | Duplicate reference warning; payment immutable once posted |
| FIN-08 | Allocate payments to invoices (automatic oldest-first by default, manual override) | Allocation never exceeds the invoice balance; unallocated amounts held as student/family credit |
| FIN-09 | Reverse a payment or credit an invoice with mandatory reason; no deletion | The original record is preserved; the reversal is a new linked entry; balances recompute correctly |
| FIN-10 | Refund workflow: request → approve → record disbursement | Two-person rule where the school has more than one finance user **[DECISION D-05]** |
| FIN-11 | Receipts with unique sequential numbers per school, generated as PDFs | Numbers never reused; receipt reflects school branding; a downloadable link is sent to the payer |
| FIN-12 | Student and family statements for a date range | Opening balance + charges − payments ± adjustments = closing balance; verified against the ledger in tests |
| FIN-13 | Arrears and aging report (current, 1–30, 31–60, 61–90, 90+ days) by class and campus | Totals reconcile to the sum of student balances |
| FIN-14 | Collection report by period, method, item category and campus | Reconciles to posted payments |
| FIN-15 | All money stored in integer minor units with an ISO-4217 currency code; no floating-point arithmetic | Enforced by types and database constraints; property-based tests on allocation and rounding |
| FIN-16 | Period lock: a bursar or owner can close a term or month, preventing back-dated postings | Postings into a locked period are rejected; adjustments go into an open period |

### 5.7 Online payments (PAY) — one provider in R1

| ID | Requirement | Acceptance criteria |
|---|---|---|
| PAY-01 | A parent can pay an invoice (in full or in part, where the school allows) via Mobile Money or card through **one** provider **[DECISION D-06: provider choice]** | Payment initiated server-side with an idempotency key |
| PAY-02 | A payment is marked successful **only** after a verified provider confirmation: signed webhook plus server-to-server verification | Clicking "Pay" never changes a balance; tests simulate forged, duplicate and out-of-order webhooks |
| PAY-03 | Funds settle **directly to the school's own provider account or subaccount**; EduBridge does not hold school funds **[DECISION D-07]** | Settlement account configured per tenant; no pooled EduBridge account |
| PAY-04 | Daily automated reconciliation of provider transactions against EduBridge payments | Discrepancies surfaced to the bursar; nothing auto-corrected silently |
| PAY-05 | Failed, pending and abandoned payments visible to the parent and the bursar with clear status | Pending payments time out and are re-verified before being marked failed |

### 5.8 Communication (COM) — finance events only in R1

| ID | Requirement | Acceptance criteria |
|---|---|---|
| COM-01 | SMS and email notifications for: invoice issued, payment received, receipt available, overdue reminder, portal invitation, OTP | Template per event per channel; school name as sender where the provider supports it |
| COM-02 | Scheduled overdue reminders on a configurable cadence | Never more than one reminder per student per configured interval |
| COM-03 | Delivery status, retry with backoff and notification history | Bursar can see whether a parent was notified |
| COM-04 | Duplicate prevention | The same event cannot produce two messages to the same recipient (idempotency key per event and recipient) |
| COM-05 | No sensitive detail in SMS bodies: messages contain amounts and a link, never medical, safeguarding or full statement data | Template linting rule; reviewed in security tests |
| COM-06 | School announcements to all parents, or by class, level or campus (SMS, email, in-app) | Cost estimate shown before sending SMS; requires `communication.send` permission |

### 5.9 Parent portal (PRT) — mobile-first

| ID | Requirement | Acceptance criteria |
|---|---|---|
| PRT-01 | Family home: each child with outstanding balance, next due date and recent activity | Usable on a 360 × 640 px viewport; first meaningful paint under 3 s on a simulated slow 3G connection |
| PRT-02 | Invoice detail with line items, payments, balance and "Pay" action | Amounts formatted in the school currency (e.g. `GH₵ 1,250.00`) |
| PRT-03 | Payment history and receipt download (PDF) | Receipts accessible offline once downloaded |
| PRT-04 | Statement view per child and per family | Matches the bursar's statement for the same period (tested) |
| PRT-05 | School announcements | Read state tracked |
| PRT-06 | Contact the school: phone, email, WhatsApp link and office hours as configured by the school | No in-app chat in R1 |
| PRT-07 | Installable PWA with an offline shell; recently viewed balances shown with an "as of" timestamp when offline | Financial data in the offline cache is limited and cleared on sign-out (see `09`) |

### 5.10 Owner finance overview (OVR) — Command Center seed

| ID | Requirement | Acceptance criteria |
|---|---|---|
| OVR-01 | Totals for the selected term and campus: billed, collected, outstanding, collection rate | Every figure links to the underlying report; figures equal the reports exactly |
| OVR-02 | Arrears aging and collection trend by week | Charts render only real data; an empty state is shown when no data exists — **never demo data** |
| OVR-03 | Enrollment counts by campus and level | Derived from enrollment records |

### 5.11 Platform administration (PLT)

| ID | Requirement | Acceptance criteria |
|---|---|---|
| PLT-01 | EduBridge staff can onboard a school, set its plan and entitlements, and suspend or reactivate it | All actions audit-logged |
| PLT-02 | Support access to a school's data only through an explicit, time-limited, school-approved "support session" **[DECISION D-08]** | Every support read and write is logged with the support session ID and visible to the school owner |
| PLT-03 | Subscription records: plan, billing period, status (trial, active, past due, grace, suspended), invoices to schools | Subscription billing may be manual in R1 (EduBridge invoices schools offline) |

---

## 6. Post-MVP scope (summary)

Detailed requirements will be written at the start of each release. They are kept short here on purpose, so we don't create specifications that go stale.

- **R2 Academic core:** class and subject attendance with offline capture and conflict handling; subjects and curricula; assessment types and weights; grading scales; score entry; report-card templates (GES basic-school style, British/Cambridge, IB, American) with an approval workflow and PDF output; teacher home; parent results and attendance views.
- **R3 Growth:** admissions CRM (inquiry → application → assessment → offer → enrollment); a second and third payment provider; WhatsApp Business messaging where authorized; web push; consent forms; events calendar; subscription self-service for schools.
- **R4 Operations:** staff and HR records, leave, payroll records (no statutory tax calculation until validated), library, transport (GPS optional and consent-based), boarding, inventory and procurement, visitor and pickup management, safeguarding (restricted case management).
- **R5 Intelligence:** permission-aware natural-language assistant over curated, audited queries; collection forecasting; academic early-warning indicators reviewed by teachers; the full Command Center; AI drafting tools with human approval.

---

## 7. Explicitly out of scope for the MVP

| Item | Reason |
|---|---|
| Native Android and iOS apps | The PWA covers the need; the API is designed for React Native later |
| Payroll tax calculations | Requires validated GRA/SSNIT rules — legal and accounting risk |
| AI features | Not a dependency for operations; adds cost and privacy risk before product–market fit |
| Multiple online payment providers | One working, verified integration beats three half-built ones |
| Student logins | Low value for the buyer in the first release; adds safeguarding and consent complexity |
| Custom domains per school | Subdomain or path-based branding is sufficient for the pilot |
| General ledger / full accounting (expenses, payables) | EduBridge records receivables; schools keep their accounting system. Export provided |
| In-app chat | Moderation, safeguarding and support burden |

---

## 8. Non-functional requirements (all releases)

| Area | Requirement |
|---|---|
| **Security** | OWASP ASVS Level 2 as the target baseline; tenant isolation enforced in both the application and the database (RLS); see `07` |
| **Privacy** | Designed with Ghana's Data Protection Act, 2012 (Act 843) in mind; data minimisation; access and correction workflows; no real student data outside production |
| **Financial integrity** | Append-only ledger; integer minor units; idempotent posting; period locks; daily reconciliation; every report traceable to ledger entries |
| **Performance** | Interactive staff screens: p95 API latency < 300 ms for common reads at pilot scale; parent home < 3 s on slow 3G; JS for the parent route budgeted at < 170 KB compressed |
| **Availability** | Target 99.5% monthly during the pilot, 99.9% once commercial; planned maintenance outside school hours (GMT) |
| **Data durability** | Point-in-time recovery for the database; RPO ≤ 15 minutes, RTO ≤ 4 hours (pilot); tested restores quarterly |
| **Accessibility** | WCAG 2.2 AA; keyboard navigable; screen-reader labels; minimum 44 px touch targets on the parent portal |
| **Devices** | Chrome for Android (last 3 years), Safari iOS 16+, current Chrome, Edge, Firefox and Safari on desktop |
| **Localisation** | English at launch; strings externalised for future languages; currency, date, number and phone formats driven by tenant locale; timezone per tenant (default `Africa/Accra`) |
| **Observability** | Structured logs with request and tenant IDs (no PII in logs); error monitoring; job-failure alerting; payment and webhook dashboards |
| **Maintainability** | Strict TypeScript; domain modules with enforced boundaries; documented ADRs |

---

## 9. Ghana-specific requirements (MVP-relevant)

- **Currency:** GHS (`GH₵`), stored in pesewas (minor units). Multi-currency at the data level from day one (for international schools billing in USD), with **one currency per invoice**. No FX conversion in R1. **[ASSUMPTION A-05]**
- **Phone numbers:** stored in E.164 (`+233XXXXXXXXX`); local input such as `024 123 4567` accepted and normalised; network prefix recognised for display only, never for routing payments (because of number portability).
- **Calendar:** three-term template by default, fully configurable.
- **Levels:** Ghanaian templates (Creche, Nursery, KG, Primary 1–6, JHS 1–3, SHS 1–3) plus international templates (Year/Grade).
- **Payments:** Mobile Money is the primary online method. Cash and bank deposits remain first-class manual methods.
- **SMS:** primary notification channel for parents; sender ID registration per school where the provider allows.
- **Connectivity:** low-bandwidth design — small payloads, server-side rendering, no heavy client libraries on parent routes.

---

## 10. Success metrics (pilot)

These are targets to validate with pilot schools, not claims.

| Metric | Target |
|---|---|
| Time for a bursar to bill a full term | < 30 minutes for 500 students (from typically days) |
| Parent portal activation | ≥ 60% of fee-paying guardians within one term |
| Share of payments made online | ≥ 30% by the end of the first term |
| Statement disputes caused by system error | 0 |
| Reconciliation discrepancies unresolved > 7 days | 0 |
| Owner weekly active use of the finance overview | ≥ 1 session per week |
| Pilot school conversion to paid | ≥ 2 of 3 pilot schools |

---

## 11. Decisions requiring founder approval

| ID | Decision | Recommendation |
|---|---|---|
| D-01 | MVP focus: finance and parent portal first; academics in R2 | Approve |
| D-02 | Parent sign-in by SMS OTP (password optional) | Approve; SMS cost per login is low and removes forgotten-password support load |
| D-03 | Mandatory MFA for owner, bursar and platform-admin roles | Approve |
| D-04 | Parent access only via school invitation or OTP to the phone on file | Approve; never allow self-claim |
| D-05 | Two-person approval for refunds and large adjustments (configurable) | Approve, with a threshold set by the school |
| D-06 | First payment provider (Paystack vs Hubtel vs direct MTN MoMo API) | Decide after a sandbox spike; see `02` §9 |
| D-07 | Funds settle directly to schools; EduBridge never holds school money | **Strongly recommend.** Avoids payment-service licensing obligations and custody risk; legal confirmation required |
| D-08 | Support access only via school-approved, time-limited support sessions | Approve |

---

## 12. Open questions for the founder

These questions materially affect architecture or business direction:

1. **Pilot schools:** Do you have specific pilot schools? How many students, how many campuses, and do any bill in USD?
2. **Money flow:** Confirm D-07 — schools receive funds directly, and EduBridge earns from subscriptions (and possibly a transparent per-transaction fee) rather than holding money.
3. **Tenant unit:** Is the customer always one school (with campuses), or will school *groups* own several distinct schools with separate branding? (This affects the tenant model; see `02` §5.)
4. **Budget:** What monthly infrastructure budget is acceptable during the pilot year?
5. **Team:** Will you be the sole developer working with Claude Code, or will engineers join? This affects how much we invest in tooling and process up front.
