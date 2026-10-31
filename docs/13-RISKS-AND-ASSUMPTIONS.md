# 13 — Risks and Assumptions

| | |
|---|---|
| Status | **Draft — living document, reviewed at the start of every release** |
| Phase | 0 — Discovery and architecture |
| Related | `01-PRODUCT-REQUIREMENTS.md`, `02-SOFTWARE-ARCHITECTURE.md` |
| Last updated | 2026-10-31 |

Ratings: **Likelihood** and **Impact** are each Low, Medium or High. The highest-rated risks are listed first within each section.

---

## 1. Technical risks

| ID | Risk | L | I | Mitigation | Owner |
|---|---|---|---|---|---|
| T-01 | **Cross-tenant data leak** through a missing tenant filter, a misconfigured RLS policy, or a connection that keeps tenant context between requests | M | **H** | Defence in depth (`02` §5.2): composite FKs, forced RLS, non-owner DB role without `BYPASSRLS`, transaction-local context, a single `withTenantTx` access path, a CI check that every tenant table has RLS, and isolation tests for every table | CTO |
| T-02 | **Incorrect balances** from floating-point arithmetic, race conditions on concurrent payments, or editable history | M | **H** | Integer minor units; append-only ledger with DB triggers blocking mutation; account-level locking; idempotency keys; a nightly ledger consistency check; property-based tests | CTO |
| T-03 | **False "paid" status** from forged or replayed webhooks, or from trusting the browser redirect | M | **H** | Signature verification + server-side `verify()` before any state change; event de-duplication; tests for forged, replayed and out-of-order webhooks | CTO |
| T-04 | **Payment provider behaviour differs from documentation**: sandbox differs from live, settlement delays, MoMo prompt timeouts | H | M | Sandbox spike before committing to a provider; pending-state timeouts with re-verification; daily reconciliation; a live low-value test with a pilot school before launch | CTO |
| T-05 | **Offline attendance sync conflicts** (R2) silently overwrite data | M | M | Per-record versioning; conflicts surfaced for human resolution and never silently overwritten (last-write-wins forbidden for attendance); detailed design in `09` | CTO |
| T-06 | **Scope creep**: the bible's 18 modules pull effort away from a working MVP | **H** | H | Release plan in `01` §4; every new feature needs a problem statement and a user; the founder approves scope changes per release | Founder + CTO |
| T-07 | **Low-end device performance**: heavy JS bundles make the parent portal unusable on cheap Android phones | M | H | Server rendering; a separate parent bundle with an enforced size budget in CI; testing on a real low-end device (≈ 2 GB RAM) each release | CTO |
| T-08 | **Bulk operations time out or partially fail** (billing 2,000 students) | M | M | Background jobs; chunked, idempotent processing; progress tracking; resumable runs | CTO |
| T-09 | **Drizzle tooling immaturity** (migration edge cases) | M | L | Treat migrations as reviewed SQL; never use automatic schema push outside local development | CTO |
| T-10 | **SMS delivery unreliability** (network filtering, sender ID registration delays) | M | M | Delivery receipts; a fallback provider behind the interface; email and in-app as secondary channels; early sender ID registration | CTO |
| T-11 | **Key-person dependency**: knowledge concentrated in the founder and AI-assisted development | H | H | ADRs, module READMEs, high test coverage of domain logic, conventional technology choices | Founder |
| T-12 | **Secret or credential leakage** (provider keys, DB credentials) | L | **H** | Secrets only in the platform secret store; secret scanning in CI (e.g. gitleaks); per-tenant provider credentials encrypted; key rotation procedure | CTO |
| T-13 | **Backup exists but restore fails** | L | **H** | Managed PITR; quarterly restore drills to staging (data restored into an isolated, access-restricted environment, then destroyed) | CTO |
| T-14 | **AI features (R5) leak data or fabricate answers** | M | H | Deferred to R5; AI only calls permission-checked, audited query tools; answers cite sources; no free-form SQL generation against production | CTO |

## 2. Commercial risks

| ID | Risk | L | I | Mitigation |
|---|---|---|---|---|
| C-01 | **Willingness to pay is lower than assumed**, especially at small private basic schools | **H** | H | Interview at least 10 school owners and bursars before fixing prices; test the pricing structure with pilots; consider pricing per enrolled student per term, aligned to school cash flow |
| C-02 | **Established competitors and low-cost local systems** already serve the market | H | M | Compete on financial correctness, parent mobile experience and reliability, not feature count; offer migration assistance from spreadsheets and competitor exports |
| C-03 | **Long sales cycles**: decisions tied to the academic calendar (term start in September, January and April/May) | H | M | Time onboarding to term boundaries; target schools 6–8 weeks before a term starts; free assisted onboarding for pilots |
| C-04 | **Parent adoption is low**: parents keep paying cash at the school | M | H | SMS OTP sign-in (no passwords); SMS links straight to the invoice; receipts by SMS for cash payments too, so parents see value without paying online |
| C-05 | **Transaction fees deter online payment**: who pays the provider fee, parent or school? | M | M | Configurable per school (absorb or pass on, where provider rules and regulations allow); clear disclosure before payment |
| C-06 | **Support burden**: schools expect phone and WhatsApp support and on-site training | H | M | In-product onboarding checklist, import templates and short guides; price support into plans; track support hours per school |
| C-07 | **Onboarding data quality**: student and guardian data arrives in messy spreadsheets | H | M | Strong import validation with row-level errors; assisted import service (possibly paid); duplicate detection on guardian phone numbers |
| C-08 | **SMS costs erode margin** at scale | M | M | SMS quotas per plan; metered overage; in-app and push for non-urgent messages |
| C-09 | **Customer concentration**: a few pilot schools shape the product toward their own quirks | M | M | Configuration over customisation; reject school-specific code paths |
| C-10 | **Reputational damage** from one incident (data leak, wrong balance) in a small, connected market | L | **H** | The technical mitigations above; incident response plan in `07`; honest, fast communication with schools |

## 3. Legal, regulatory and compliance risks

These require **professional legal advice**. Nothing in our documentation claims compliance.

| ID | Matter | Why it matters | Action |
|---|---|---|---|
| L-01 | **Data Protection Act, 2012 (Act 843)**: roles of school (likely data controller) and EduBridge (likely data processor); registration with the Data Protection Commission | Registration and processing obligations; children's data | Legal review; data processing agreement template with schools; DPC registration as required |
| L-02 | **Cross-border data transfer** if hosting outside Ghana (Europe or South Africa) | Hosting region decision D-12 | Legal opinion before production launch |
| L-03 | **Payment services regulation (Bank of Ghana, Payment Systems and Services Act, 2019 (Act 987))**: whether EduBridge's role requires licensing | Strongly influenced by D-07 (we never hold funds) | Legal confirmation that a direct-settlement model needs no EduBridge licence; written confirmation of each provider's settlement model |
| L-04 | **Consent for children's data** and parental authorisation | Student photos, medical data, any GPS tracking (R4) | Consent capture per school policy; legal review of consent wording |
| L-05 | **Payroll and statutory deductions** (GRA income tax, SSNIT) | Risk of incorrect calculations | Out of scope until validated with a Ghanaian accountant (`01` §7) |
| L-06 | **Electronic receipts and invoices**: any GRA e-invoicing or VAT obligations for schools or for EduBridge's own subscription invoices | Tax compliance | Accountant review before commercial launch |
| L-07 | **Terms of service, privacy notice, SLA, DPA** | Contractual basis for selling | Drafted by a lawyer before the first paid contract |
| L-08 | **SMS sender ID and messaging rules** (NCA guidance; consent for non-transactional messages) | Deliverability and regulatory exposure | Follow provider registration processes; separate transactional and promotional messages |

## 4. Assumptions

Each assumption needs validation. If one proves false, the affected documents must be revisited.

| ID | Assumption | Affects | How to validate |
|---|---|---|---|
| A-01 | The buyer is the school owner or director; the bursar is the main daily user | Product focus, overview design | Pilot interviews |
| A-02 | Fee collection and parent communication are the top-priority pains that schools will pay to solve | MVP scope (D-01) | Interviews with at least 10 schools |
| A-03 | Most parents have an Android smartphone with intermittent mobile data; nearly all can receive SMS | PWA, SMS-first notifications | Pilot school parent survey |
| A-04 | Mobile Money is the dominant online payment method for school fees | Provider choice | Pilot bursar data on payment methods |
| A-05 | Each invoice has exactly one currency; schools billing in USD do not need automatic FX conversion in R1 | Data model, reporting | Ask international pilot schools |
| A-06 | Tenant = one school with campuses; school groups are a later need | Tenant model (D-11) | Founder answer to `01` Q3 |
| A-07 | Schools can and will open a payment provider account or subaccount in their own name | Direct-settlement model (D-07) | Provider onboarding requirements; pilot school willingness |
| A-08 | Schools will keep their existing accounting software or accountant; EduBridge covers receivables and exports | Out-of-scope GL | Bursar interviews |
| A-09 | A pilot scale of 1–5 schools and under 5,000 students in the first year | Infrastructure sizing and cost | Founder pipeline |
| A-10 | Development is led by the founder with AI assistance; a hire is possible later | Process and tooling investment | Founder answer to `01` Q5 |
| A-11 | English-only UI is acceptable for launch | i18n effort | Pilot feedback |
| A-12 | Hosting in Europe is acceptable to schools and permitted under Act 843 with appropriate safeguards | Region choice (D-12) | Legal review (L-02) and school feedback |

## 5. Open questions (consolidated)

| # | Question | Blocks |
|---|---|---|
| Q1 | Who are the pilot schools (size, campuses, curriculum, currencies)? | Final MVP prioritisation; cost model |
| Q2 | Confirm direct settlement to schools (D-07) | Payment architecture; legal review |
| Q3 | Single schools only, or school groups? | Tenant model |
| Q4 | Acceptable monthly infrastructure budget in the pilot year? | Hosting choice (`12`) |
| Q5 | Sole founder-developer, or a team? | Process and roadmap pacing (`11`) |
| Q6 | Is there budget for legal review (Act 843, payments, contracts) before launch? | Commercial launch readiness |

## 6. Review cadence

- Reviewed at the start of each release, and whenever a high-impact risk materialises.
- Closed risks stay in the table with a closure note. They are not deleted.
