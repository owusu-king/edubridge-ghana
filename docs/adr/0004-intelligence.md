# ADR 0004 — Intelligence (R5): facts first, predictions labelled, AI only for language

|            |                                                                                                       |
| ---------- | ----------------------------------------------------------------------------------------------------- |
| Status     | **Accepted** (2026-11-17: founder approved the design and decisions D-R5-1 to D-R5-8 as recommended) |
| Builds on  | ADR 0002 (the school assistant: read-only tools, audited questions, pseudonymised names), phase T (Insights), OVR (the overview), ADR 0003 (modules, plans, release stages) |
| Requested  | Founder instruction of 2026-11-17: "Plan R5" (bible Part 6, Part 7 and Phase 7; `01` §4 R5)           |

## Summary

Much of what the bible calls Intelligence is already built and in use: Insights (term-by-term enrolment, results,
attendance and money; students whose results fell; outstanding registers and marks), the overview (fees, owed
today, attendance, report cards), and the school assistant (Claude, behind a platform switch: read-only tools that
run with the asker's own permissions, every question recorded with the records it read, names replaced by
references unless the school allows them). R5 builds on these; it does not start again.

The design rests on one rule, which answers the bible's demands for "accurate database retrieval", "clear
distinction between facts and predictions" and "protection against fabricated answers":

1. **Every figure comes from a database query in our own code**, never from a language model. The model may
   choose which query to run, and may write words around the results; it never computes, rounds, totals or
   estimates a number that is shown as fact.
2. **Predictions are computed by explainable rules in our code**, shown with their range and their past accuracy,
   and always labelled as forecasts.
3. **AI is used only for language**: answering questions in words from tool results, and drafting text a person
   edits and approves. Nothing it writes is sent, published or saved as a school record without a person's action.
4. **Everything in R5 except the assistant and drafting works with no AI provider at all** (bible 6.4: "AI must be
   an optional enhancement, not a dependency").

## 1. What R5 adds, by module

The four R5 modules are already in the registry (`src/lib/modules.ts`, stage `planned`, ids unchanged). Each moves
through `in_development` and `internal_testing` to `pilot` as the R4 modules did.

| Module | What it adds | AI? |
| --- | --- | --- |
| `command_center` | The Proprietor's flagship view (bible Part 7): financial, academic, enrolment, operational and campus health in one place, filtered by year, term, campus and class; every figure links to its report and equals it; a printable summary for the board | No |
| `forecasting` | Collection forecasts (expected receipts by week to the end of the term, with a range and last term's accuracy) and finance checks (rule-based flags such as duplicate references, many voids by one person, receipts outside school hours, unreconciled Mobile Money, refunds above a level) | No |
| `early_warning` | Indicators that a student may need support (attendance, absences in a row, falling average, subjects failed), each showing its evidence; the class teacher reviews them and may open a support plan; academic leads oversee | No |
| `ai_drafting` | Drafts a person edits before use: report-card remarks, announcements, and the prose of a board report around figures our code inserts | Yes |
| `assistant` (built, R3) | Becomes sellable: per-school monthly allowance, per-person rate limit, usage and cost per school, answers checked against the tool results, tools for the R4 and R5 data | Yes |

## 2. Facts, forecasts and indicators

- **Facts** are counts, sums and averages of records, exactly as the existing reports compute them. The Command
  Center reuses the services behind the overview, Insights and the fee reports, so a figure there always equals the
  report it links to (OVR-01, tested).
- **Forecasts** use the school's own history, not a trained model and no new library: for each past term, the share
  of what was billed that had been collected by each week of the term (by level), plus the instalments of active
  payment plans still due. The likely forecast is this term's billed amount times the median past curve, adjusted
  for plan instalments; the range is the lowest and highest past curve. Each forecast shows how far last term's
  forecast at the same week was from what happened (a backtest, computable from dated ledger entries). With no
  complete past term, it says there is not enough history instead of guessing.
- **Indicators** are rules with thresholds the school sets, applied to records, each listing the records that
  triggered it. They are not scores and do not rank children. The wording is "may need support", never a label.

**No predictions about individual families or children are shown (D-R5-4):** forecasts are for the school, a level
or a class; families behind on a payment plan are shown as the fact they are, not as a risk. Early-warning
indicators describe what the records show, and a teacher decides what it means. No decision about a child is made
automatically (bible 6.2; Act 843 review, `13` L-01, L-04).

## 3. The AI gateway (`src/server/ai`)

Today the assistant calls Claude through `src/server/assistant/model.ts`. R5 makes that one gateway for every AI
task, so cost, privacy and safety are handled once:

| Concern | Design |
| --- | --- |
| Provider | Claude through the official Anthropic SDK (already a dependency), behind the existing `AssistantModel` interface so tests use a scripted model and another provider could be added later. Key and switch set by platform staff (Admin, Integrations), as now |
| Model and effort per task | Platform setting per task (assistant, remark drafts, announcement drafts, report prose). Default `claude-opus-5-5` for every task (today's default), adaptive thinking, effort `medium` for the assistant. Choosing a cheaper model for a task is the founder's decision, made by measuring it on the evaluation set (D-R5-6) |
| Refusals | The server-side fallback the assistant already uses (`fallbacks: "default"`); a refusal is recorded and shown plainly |
| Cost | Prompt caching of the stable part of every request (tools and rules), with school and date after the cache point; every call metered in an `ai_usage` table (school, person, task, model, input, cached and output tokens, estimated cost); a monthly allowance per school from its plan, checked before each call; a per-person hourly limit; a platform kill switch per task |
| Privacy | Names of students, guardians and staff never go to the provider unless the school allows it (as now). Drafts about a child use placeholders (`{first name}`) filled in on our server, so remark drafting sends no names at all. Safeguarding records are never available to any AI task. Only the minimum figures a task needs are sent |
| Fabrication | The assistant's answer is checked before it is shown: every number in it must appear in the tool results of that question; if one does not, the answer is shown with a warning that a figure could not be checked against the records, and the question is flagged in the log. Drafts with figures (board report) take the figures from our code, never from the model |
| Audit | Every AI call recorded (who, task, model, tokens, outcome), as `assistant_queries` does today; drafts recorded with who accepted, changed or discarded them |
| Quality | An evaluation set of questions and draft requests on the synthetic seeded school, with the expected figures, run before any change of model, prompt or tool. Runs that call the provider cost money, so they are run on request, not in CI |

### Revision of 2026-11-18: zero operating cost first (D-R5-10)

The founder approved R5-4 but not a mandatory paid AI service. The gateway is therefore provider-agnostic, and the
first providers cost nothing:

- **Providers behind one interface.** Features speak a neutral message format (`src/server/ai/types.ts`); adapters
  translate it. `openai_compatible` (plain `fetch`, no new dependency) covers Ollama on our own machine (nothing
  leaves it) and free hosted tiers that speak that API, such as Groq; the Anthropic adapter stays for when a paid
  provider is approved. Switching provider is a platform setting (Admin, Integrations) and changes no feature code.
- **Free tiers are de-identified only.** Their terms are not a data-processing agreement (Gemini's free tier, for
  one, uses submissions to improve Google's products), so no free or local provider is sent names, admission
  numbers, phone numbers, email addresses or the school's name, whatever the school's own setting. Only a paid
  provider can be marked approved for identifiable data, by platform staff after the data-protection review
  (D-R5-7); only then does a school's consent to share names apply.
- **Off, limited and visible by default.** A global AI switch and a switch per task (feature flags); limits per
  platform (tokens a month), per school (tokens a month, overridable per school) and per person (requests a
  minute and an hour, tokens a day); a maximum of output tokens per call; every call metered in `ai_usage` with
  its outcome. When AI is off, unavailable, over a limit or out of the provider's free quota, the feature says so
  plainly and the rest of the system is unaffected.
- **Upgrade path.** To move to a paid provider: complete the data-protection review, add the provider's key in
  Admin, Integrations, choose it and its model, set the per-school allowances to match the plan's price, and, if
  the review allows, mark it approved for identifiable data. No feature changes.

## 4. Data and performance

- **Live queries, no warehouse.** Insights answer in 0.33 s at 1,991 students (pilot readiness load test). The
  Command Center reuses those queries; its budget is under 1 s at 2,000 students, measured by extending
  `npm run perf:pilot`. If a section misses it, that section gets a short per-school cache, not a new store.
- **Forecast history needs no snapshots**: ledger entries and payments carry the dates needed to rebuild what had
  been collected by any week of a past term.
- **New tables** (with row-level security, insert-only where they are history): `ai_usage`, `ai_drafts` (task, the
  draft, accepted or discarded, by whom), `early_warning_rules` (the school's thresholds), `early_warning_reviews`
  (a teacher's review of an indicator: no action, support plan, or referred to the head teacher), `support_plans`
  (goal, actions, review date, outcome; history kept), `finance_check_reviews` (a flag looked at and why it is
  fine, or what was done).

## 5. Permissions and packaging

| Permission | Who | Module |
| --- | --- | --- |
| `command_center.view` | Proprietor, Head teacher, Administrator, Accountant (finance sections for finance roles, academic sections for academic roles, as Insights) | `command_center` |
| `forecasting.view` | Proprietor, Accountant, Head teacher | `forecasting` |
| `finance_checks.review` | Proprietor, Accountant | `forecasting` |
| `early_warning.view` | Proprietor, Head teacher, Administrator; class teachers for their own classes | `early_warning` |
| `early_warning.review` | Class teachers for their classes, Head teacher | `early_warning` |
| `early_warning.manage` | Proprietor, Head teacher (thresholds) | `early_warning` |
| `drafting.use` | Staff who can already do what the draft is for (remarks: those who enter remarks; announcements: those who send them) | `ai_drafting` |

Early-warning indicators and support plans are never shown in the parent view, to students, or to EduBridge
support, and are kept out of the school-wide audit log's details (as safeguarding). They are in the school's own
data export. Packaging is a founder decision (D-R5-3).

## 6. Phases

| Phase | Scope | Needs a paid AI service? |
| --- | --- | --- |
| R5-1 | Command Center (CMD) | No |
| R5-2 | Collection forecasting and finance checks (FCT) | No |
| R5-3 | Early-warning indicators and support plans (EWS) | No |
| R5-4 | AI gateway: metering, allowances, rate limits, caching, answer checking, evaluation set; the assistant made sellable, with tools for R4 and R5 data (AIP, AST) | Yes, switched on only with the founder's approval |
| R5-5 | AI drafting: report-card remarks, announcements, board report prose (DRF) | Yes |

Value that needs no AI ships first; the AI phases come last because they carry running cost and privacy questions
that the founder and the data-protection review should settle first.

## 7. Not in R5

Lesson planning, policy drafting and meeting summaries (bible 6.4 "explore": no school asked yet, and policy text
needs legal care); machine-learned models of any kind; predictions about individual families or children; AI
reading uploaded documents (student files, safeguarding documents); SMS or WhatsApp answers from the assistant;
languages other than English; automatic actions taken by AI.

## 8. Risks

| Risk | Mitigation |
| --- | --- |
| A wrong figure looks authoritative (`13` T-14) | Figures only from our queries; answers checked against tool results; forecasts labelled with range and past accuracy |
| Children's data sent to an AI provider | Pseudonyms by default, placeholders in drafts, no safeguarding or medical data in any AI task; provider terms, retention and data location reviewed with the data-protection review (`13` L-01, L-02) before AI is switched on in production |
| AI cost grows faster than revenue | Allowance per plan, hourly limit, metering per school, kill switch; measured cost per question and per draft before prices are set |
| Indicators stigmatise children | Rules not scores, evidence shown, teacher review, never shown to families or students, thresholds verified with pilot schools |
| Forecasts mislead with little history | Shown only with a complete past term; range and backtest always visible |
