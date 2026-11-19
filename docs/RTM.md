# Requirements traceability matrix (all releases) — 2026-11-17

✓ built and tested · ◐ built with a recorded limitation (note) · ○ built early, off until approved · – not started.
Requirement IDs and release scope from `01-PRODUCT-REQUIREMENTS.md` §4–6. Tests: `tests/integration`, `tests/unit`, `tests/e2e`.

| Release | Area | Requirements and status | Main evidence (test files) |
| --- | --- | --- | --- |
| **R0** Foundation | Tenancy (TEN) | TEN-01 ✓ · TEN-02 ✓ · TEN-03 ✓ · TEN-04 ✓ · TEN-05 ✓ | tenant-isolation, tenancy, campuses, profiles-branding, billing |
| | Identity and access (IAM) | IAM-01 ✓ · IAM-02 ✓ · IAM-03 ✓ · IAM-04 ✓ · IAM-05 ✓ · IAM-06 ✓ · IAM-07 ✓¹ · IAM-08 ✓ | auth, mfa, mfa-policy, password-reset, members, permissions (unit), security.spec |
| | Platform (PLT) | PLT-01 ✓ · PLT-02 ✓ · PLT-03 ✓² | platform, support-access, billing, integrations |
| **R1** Pilot / MVP | Academic structure (ACS) | ACS-01 ✓ · ACS-02 ✓ · ACS-03 ✓³ · ACS-04 ✓ | calendar, classes, term-move, teaching |
| | Students and guardians (SIS) | SIS-01 ✓ · SIS-02 ✓ · SIS-03 ◐⁴ · SIS-04 ✓ · SIS-05 ✓ · SIS-06 ✓ · SIS-07 ✓ · SIS-08 ✓ · SIS-09 ✓ | students, guardians, import, profiles-branding |
| | Parent access (PAR) | PAR-01 ✓ · PAR-02 ✓ · PAR-03 ✓ · PAR-04 ✓ · PAR-05 ✓⁵ | parent-portal, family-messages, r1-completion.spec |
| | Fees and billing (FIN) | FIN-01 ✓ · FIN-02 ✓ · FIN-03 ✓ · FIN-04 ◐⁶ · FIN-05 ✓ · FIN-06 ✓ · FIN-07 ✓ · FIN-08 ◐⁶ · FIN-09 ✓ · FIN-10 ✓ · FIN-11 ✓ · FIN-12 ✓ · FIN-13 ✓ · FIN-14 ✓ · FIN-15 ✓ · FIN-16 ✓ | fees, ledger, payments, concessions, payment-plans, opening-balances, finance-controls, statement (unit) |
| | Online payments (PAY) | PAY-01 ◐⁷ · PAY-02 ✓ · PAY-03 ◐⁷ · PAY-04 ✓ · PAY-05 ✓ | mobile-money, mobile-money-callbacks, paystack-sandbox, parent-payments, reconciliation, kenya-school |
| | Communication (COM) | COM-01 ◐⁸ · COM-02 ✓ · COM-03 ✓ · COM-04 ✓ · COM-05 ✓ · COM-06 ✓ | messages, owing-reminders, notifications, family-messages, fee-messages (unit) |
| | Parent portal (PRT) | PRT-01 ✓ · PRT-02 ✓ · PRT-03 ✓ · PRT-04 ✓ · PRT-05 ✓ · PRT-06 ✓ · PRT-07 ✓ | parent-portal, parent-payments, parent.spec, r1-completion.spec (offline) |
| | Owner overview (OVR) | OVR-01 ✓ · OVR-02 ✓ · OVR-03 ✓ | overview, finance-controls (campus), dashboard (unit) |
| | Africa-wide readiness (founder, 2026-11-09) | Country profiles ✓ · currency per school ✓ · phone numbering ✓ · holidays ✓ · level and grading templates ✓ · Mobile Money by country and currency ✓ | countries (unit), kenya-school, teaching |
| **R2** Academic core | Attendance, assessment, teaching | Offline class registers ✓ · subjects and grading ✓ · score sheets and report cards ✓ · teaching by class or by subject ✓ · lesson (subject-period) attendance ✓ · timetables ✓ · report-card layouts (GES, Cambridge, IB, American) and subject comments ✓ · teacher home ✓ | attendance, assessment, sync, teaching, r2-completion (integration and unit), timetable.spec |
| **R3** Growth | Admissions and reach | Transfer Passport ◐⁹ · admissions CRM ✓ (documents not yet) · second/third payment provider (deferred by the founder, D-R3-3) · WhatsApp Business ✓ (live after Meta verification and template approval) · web push ✓ (families and staff) · SMS segments and delivery report ✓ · consent forms and events ✓ (statement needs the data-protection review) · subscription self-service ✓ (online payment in test mode until EduBridge's Paystack account is live) · scheduled announcements ✓ · WhatsApp delivery receipts ✓ (SMS receipts wait for the provider's documentation) | passport |
| **R4** Operations | Commercial foundation (ADR 0003) | MOD-01 ✓ · MOD-02 ✓ · MOD-03 ✓ · ENT-01 ✓ · ENT-02 ✓ · ENT-03 ✓ · ENT-04 ✓ · ENT-05 ✓ · ENT-06 ✓ · ENT-07 ✓ · ENT-08 ◐¹¹ · ENT-09 ✓ · REL-01 ✓ · REL-02 ✓ · SUB-06 ✓ · SUB-07 ✓ · SUB-08 ✓ · SUB-09 ✓ · SUB-10 ✓ | modules (unit and integration), plan (unit) |
| | Staff and HR (R4-1, released) | HR-01a ✓ · HR-01b ✓ · HR-01c ✓ · HR-01d ✓ · HR-01e ✓ · HR-02 ✓ · HR-03a ✓ · HR-03b ✓ · HR-03c ✓ · HR-03d ✓ · HR-04 ✓ · HR-05 ✓ | staff (unit and integration), staff.spec |
| | Payroll records (R4-2, released) | PRL-01a ✓ · PRL-01b ✓ · PRL-02a ✓ · PRL-02b ✓ · PRL-02c ✓ · PRL-03 ✓ · PRL-04 ✓ | payroll (unit and integration), pdf (unit), payroll.spec |
| | Safeguarding (R4-3, released) | SFG-01a ✓ · SFG-01b ✓ · SFG-01c ✓ · SFG-01d ✓ · SFG-01e ✓ · SFG-01f ✓ | safeguarding (integration), modules (unit), safeguarding.spec |
| | Visitors and pickup (R4-4, released) | VIS-01a ✓ · VIS-01b ✓ · VIS-01c ✓ · VIS-02a ✓ · VIS-02b ✓ · VIS-02c ✓ · VIS-02d ✓ · VIS-03 ✓ | visitors (unit, integration), modules (unit), visitors.spec |
| | Transport (R4-5, released) | TRN-01a ✓ · TRN-01b ✓ · TRN-01c ✓ · TRN-02a ✓ · TRN-02b ✓ · TRN-03a ✓ · TRN-03b ✓ · TRN-04 ✓ | transport (unit, integration), modules (unit), transport.spec |
| | Inventory, assets and procurement (R4-6, released) | INV-01a ✓ · INV-01b ✓ · INV-01c ✓ · INV-02a ✓ · INV-02b ✓ · INV-02c ✓ · INV-03 ✓ | inventory (unit, integration), modules (unit), inventory.spec |
| | Library (R4-7, released) | LIB-01a ✓ · LIB-01b ✓ · LIB-01c ✓ · LIB-01d ✓ · LIB-01e ✓ · LIB-02 ✓ · LIB-03 ✓ | library (unit, integration), modules (unit), library.spec |
| | Boarding (R4-8, released) | BRD-01a ✓ · BRD-01b ✓ · BRD-01c ✓ · BRD-02 ✓ · BRD-03 ✓ · BRD-04 ✓ · BRD-05 ✓ | boarding (unit, integration), modules (unit), boarding.spec |
| **R5** Intelligence | Insights and AI | School insights ✓ · assistant ○¹⁰ · early-warning indicators ✓ (below) · Command Center ✓ (below) · forecasting ✓ (below) | insights, assistant |
| | Command Center (R5-1, the overview renamed, D-R5-9) | CMD-01a ✓ · CMD-01b ✓ (board summary) · CMD-02a → Insights · CMD-02b ✓ · CMD-02c – (dropped) · CMD-03 ✓ (movement in the board summary) · CMD-04 ✓ · CMD-05 ✓ (filters; side by side in the board summary) · CMD-06 ✓ · CMD-07 ✓ (no own permission) | board-summary (integration), modules and staff (unit), overview.spec |
| | Collection forecasting and finance checks (R5-2, released) | FCT-01a ✓ · FCT-01b ✓ · FCT-01c ✓ · FCT-01d ✓ · FCT-01e ✓ · FCT-02a ✓ · FCT-02b ✓ · FCT-03 ✓ (forecast timing with history at 2,000 students not yet measured) | forecast (unit), forecasting (integration), modules and staff (unit), forecasting.spec |
| | Early-warning indicators and support plans (R5-3, released) | EWS-01a ✓ · EWS-01b ✓ · EWS-01c ✓ · EWS-02a ✓ · EWS-02b ✓ · EWS-03 ✓ · EWS-04 ✓ | early-warning (unit, integration), modules and staff (unit), early-warning.spec |
| | AI gateway (R5-4, first part, D-R5-10) | AIG-01 ✓ · AIG-02 ✓ · AIG-03 ✓ · AIG-04 ✓ · AIG-05 ✓ | ai-gateway (unit, integration), integrations and assistant (integration), ai-gateway.spec |
| | Assistant made dependable (R5-4, second part) | AST-01a ✓ · AST-01b ✓ · AST-01c ✓ · AST-02 ✓ · AIP-04 ✓ (runner built and tested; not yet scored on a real model) | answer-check (unit), assistant-checked and assistant (integration) |
| | AI drafting (R5-5, released) | DRF-01 ✓ · DRF-02 ✓ · DRF-03 ✓ · DRF-04 ✓ · DRF-05 ✓ (announcement and board drafts tried on a local model) | drafting (unit, integration), drafting.spec |

1. Access is re-checked on every request, so a deactivated member loses access on their next request (equivalent to revoking sessions).
2. Manual billing in R1, as the requirement allows; no online payment of EduBridge invoices.
3. Starter templates per country (Ghana, Kenya, Nigeria, francophone, international); a school can pick another.
4. Active, suspended, withdrawn, transferred, graduated. "Applicant" belongs to admissions (R3).
5. Parents turn announcement SMS on or off per school; receipts, fee notices and absence alerts are essential and always sent. Parents have no email channel in R1.
6. Balance-forward ledger: a term's charges act as the invoice and payments reduce the balance; no separate invoice documents or per-invoice allocation (recorded in the roadmap).
7. Built and tested in Paystack test mode with per-school subaccounts. Live payments wait for founder approval; settlement to schools (D-07) needs legal confirmation.
8. SMS for fees billed, payment and receipt (with link), overdue reminders, portal invitations and sign-in codes; email versions of these finance messages are not built (staff email is).
9. Built early (records, signatures, transfers, family consent). Consent flow needs the data-protection review before production.
10. Built early; off until a platform key is set and each Proprietor turns it on (paid service, data leaves to Anthropic).
11. The resolver gives R4 modules a read-only state after an add-on ends (tested); R4 modules gain read and change permissions as each is built, so nothing uses the state yet. R3 modules are off when they end, as before (D-R4-5).
