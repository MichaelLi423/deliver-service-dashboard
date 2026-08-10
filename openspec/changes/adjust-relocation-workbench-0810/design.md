## Context

See `proposal.md` for motivation. The application is an Electron desktop app: renderer code has no Node access and must cross the preload/IPC contract into main-process facades and domain services; SQLite is main-process only. Lifecycle validation has one authoritative entry in `lifecycle.ts`, money is stored as integer cents/BigInt, business dates use `yyyy-mm-dd`, and database migrations are append-only through `PRAGMA user_version`.

The current implementation already contains parts of the requested UI and deletion behavior, but the 0810 feedback also exposes three cross-cutting gaps: overview values can be observed from separately read revisions, automatic date-driven transitions do not yet exist, and newly constrained regions/new project fields must remain compatible with existing databases. The delta specs under `specs/` are the behavioral authority for this change.

## Goals / Non-Goals

**Goals:**

- Keep project, financial, history, reminder and deletion views internally consistent across renderer, IPC and SQLite boundaries.
- Add date-driven lifecycle progression without bypassing lifecycle validation or allowing later states to regress.
- Persist the new project fields and fixed region values without silently changing or losing old data.
- Make deletion observable and safe per record type while retaining project cancellation, invoice reversal and source audit semantics.
- Make project pagination and reminder-lane selection deterministic at the shared read boundary rather than relying on renderer truncation or grouping.
- Reuse the existing tentative-instrument-count fact when editing project data, without creating instrument rows, changing status or adding another storage column.
- Preserve readable, keyboard-accessible reminder lanes at 1024px and 1440px without page-level horizontal overflow.
- Provide a focused, repeatable evidence path for dirty-data, migration, lifecycle, bounded ordering and responsive interaction behavior.

**Non-Goals:**

- Do not introduce a scheduler service, event bus, cloud sync, authentication change or external dependency.
- Do not physically delete projects, invoice records, immutable Ship-to master data or dependent business facts merely to satisfy a UI delete action.
- Do not rename already-published physical columns solely because a field label changes.
- Do not map legacy region text to a new region by inference.
- Do not load every related record into one unbounded project-detail snapshot.

## Decisions

### 1. Append one migration and preserve legacy values

Append the next schema migration (expected v15) rather than editing v1–v14. Add nullable storage for project note, temporary-storage address and temporary-storage flag. Reuse the existing planned-installation date column and change only its domain/UI label to “计划装机日期” unless apply-time inspection proves a separate fact is required.

New and edited projects accept only `East | South | West | Central | North`. Existing non-enum region text remains stored unchanged and is surfaced as “待调整” until a user explicitly selects a supported value. Null temporary-storage values remain “未填写”, not an inferred “否”. Legacy manager-approval reason/missing-data columns remain readable for history but are no longer collected by the new-project flow.

**Why:** this is the smallest reversible change and avoids destructive table rebuilds or guessed mappings. A strict database-level region constraint cannot safely be added until every legacy value has been resolved, so the domain write boundary enforces the enum first.

**Alternative rejected:** rewrite all historical region values during migration. The source document provides no mapping, so this would silently corrupt reporting dimensions.

### 2. Read overview counts and money from one consistent database revision

Compute `totalProjects` and pending-invoice amount in one SQLite read transaction (or one aggregate query) and derive the invariant `totalProjects === 0 => pendingAmount === 0`. The financial aggregate joins through an existing, non-cancelled project and retains valid balances for completed projects; it does not substitute an “active project only” filter.

Add a read-only integrity diagnostic that reports counts only for orphan contracts, orphan invoice facts, broken project/contract links and `PRAGMA foreign_key_check`. Do not print customer values. Migration or startup may diagnose, but it must not silently delete financial records. Orphan invoice records are never physically deleted; an active orphan invoice may be governance-revoked only after backup, explicit owner confirmation and an audited result, and the revocation keeps the original row while excluding it from the pending-amount metric. Because invoice tables keep a non-null project FK and revoked rows are preserved, structural `PRAGMA foreign_key_check` violations remain reportable as an unresolved count with a manual recovery/governance path; cleanup must not claim `foreign_key_check` is zeroed.

**Why:** hiding the card would mask the inconsistency, while changing the financial scope would lose legitimate balances from completed projects.

### 3. Route deletion through type-specific domain policies

Keep one IPC command shape with `recordType`, `recordId` and `expectedRevision`, but dispatch in the main process to the owning domain service. Each service rechecks state and dependencies inside the write transaction:

- deletable independent or leaf records are removed after confirmation;
- owned child facts may be deleted atomically only when the capability spec defines that ownership;
- records with downstream business facts are rejected with a user-facing reason rather than cascaded silently;
- project termination remains cancellation and invoice correction remains reversal;
- immutable or referenced Ship-to master data is not treated as a deletable registration.

Successful deletion and a minimal tombstone/audit fact are written atomically. Import-source audit is retained and marked as targeting a deleted record rather than erased. Any status recomputation caused by deleting acceptance or execution facts goes back through the lifecycle entry.

**Why:** a renderer-only confirmation cannot protect data integrity, and a generic SQL delete cannot express the different ownership rules.

**Alternative rejected:** unconditional database cascades. They can remove business history beyond the record the user confirmed.

### 4. Keep independent registrations independent

The sequence-address form supports two modes: optional association selected, or standalone registration. Standalone mode requires customer, new address, serial number, Account ID and update date; association-only consistency checks run only when an instrument/project is selected. QR requests remain independent records and do not gain a nullable project relation merely because they can be used alongside a project.

Project creation no longer owns service-order creation. Service number, engineer and order note remain fields of the separate service-order action. Existing historical values are displayed but are not copied into new project fields.

**Why:** this follows the capability boundaries already present and avoids adding a meaningless optional QR foreign key.

### 5. Run idempotent due-date progression through lifecycle

Add a main-process application operation conceptually equivalent to `advanceDuePlanVisits(today)` and pass every candidate through the lifecycle transition function. Candidates satisfy `plan_visit_date <= today`; this catches dates missed while the desktop app was closed. The transition table is explicit:

| Current state | Result |
|---|---|
| 待进单 / `pending_entry` | 执行中 |
| 待执行 / `pending_execution` | 执行中 |
| 执行中 | unchanged, no write |
| 待验收 / `pending_acceptance` | unchanged |
| 待掉票 / `pending_invoice` | unchanged |
| 已完成 / 已取消 | unchanged |

Run the check after migration and before the first workbench read, on application reactivation/resume, and when a running app crosses the local business-date boundary. The app does not promise background execution while closed; it promises catch-up on the next activation. Only real transitions update revision and audit state. Use a transaction that rechecks the candidate state before writing.

Formal entry of a project already advanced from “待进单” must update the same project and must not regress its state. Stronger facts (actual installation, acceptance and financial closure) retain priority.

**Why:** `<= today` is deterministic and recoverable; direct scheduled SQL updates would bypass the lifecycle invariant and create race conditions.

### 6. Extend bounded read models instead of restoring full snapshots

Use existing page/read patterns for:

- project search by customer name, ECC or temporary number, combined with fixed-region filtering and a main-process-enforced page size of 20;
- all-record history grouped by record type and sorted by each type’s business date descending, with record ID as a stable tie-breaker;
- complete-reminder navigation, reminder-date sorting and date-led quick-treatment lanes;
- project overview containing all scalar project facts, including the existing tentative instrument count, while associated facts stay paginated or tab-scoped.

The project-page contract does not accept an arbitrary renderer page size: the shared contract and main-process read apply 20. Search or filter changes discard the current cursor, recompute `total` from the filtered set and restart from its first page. Every cursor order includes a unique stable tie-breaker after the business sort key so page traversal does not duplicate or omit equal-key projects.

Reminder quick treatment uses two bounded reads in order: first select at most seven distinct, non-empty reminder business dates ascending from the earliest overdue date toward future reminder dates, skipping natural dates with no reminders; then read the projects for exactly those selected dates. It must not truncate a fixed number of reminder records and group afterward. If fewer than seven distinct dates exist, only those dates are returned. Projects within each date use a stable tie-breaker; a high-volume date may use its own bounded cursor, but advancing that column must not recompute or change the selected date set.

“编辑项目资料” reads and writes the already-existing tentative-instrument-count field through the current project scalar DTO. Saving refreshes the project scalar read model so the latest value is shown; it does not add a migration column, enter the per-instrument write path or invoke a lifecycle transition.

“查看全部” changes navigation state and triggers the target read; it is not a visual-only link. Define each record type’s business-date selector in one shared main-process mapping so UI sorting and exported/read results agree.

**Why:** bounded reads preserve current performance characteristics and renderer isolation. One giant IPC snapshot would make detail size unbounded.

### 7. Treat the sticky region as one coordinated layout

Use a single page scroll root. Keep global navigation at `top: 0`, then place the task-command header (title, description and actions) directly below it with an offset based on the navigation height. Reserve equivalent layout space so content and focused controls are never covered. At narrow widths, actions may wrap inside the sticky region rather than overflow.

**Why:** two unrelated sticky roots produce overlap and focus-obscuring bugs. This decision preserves the screenshot’s intended locked region without freezing the KPI and lifecycle content below it.

### 8. Verification follows the changed boundaries

The preferred evidence path is:

1. migration tests from v14 to the appended version, including null semantics, legacy region preservation, rollback and `foreign_key_check`;
2. lifecycle unit tests for before-date, due, overdue catch-up, all state rows in the transition table and repeated zero-write runs;
3. SQLite integration tests for zero-project pending amount, orphan exclusion, completed-project balance inclusion, per-type deletion success/rejection, audit retention and post-delete recomputation;
4. shared-contract and main-process read tests proving project pages are fixed at 20, filtered `total` is recomputed, search/filter changes clear the prior cursor, and stable tie-breakers prevent duplicate or missing projects across pages;
5. reminder read-model tests proving date selection happens before project reads: seven distinct dates, sparse/non-contiguous dates, forward supplementation, fewer than seven dates overall, stable within-column order, and column pagination that leaves the selected dates unchanged;
6. focused renderer/interface tests for form fields, including tentative-instrument-count save/refresh without instrument or status mutation, search, navigation, date headers and vertical same-date grouping;
7. two focused E2E viewport scenarios (1024 and 1440) for sticky behavior and reminder lanes: at 1024 the lane owns horizontal scrolling with no page overflow and keyboard focus remains reachable and visible; at 1440 the layout attempts to show all seven lanes but preserves readable lane widths and falls back to internal scrolling instead of compression. Build the Electron package before E2E and run Playwright with one worker;
8. `npm run typecheck` plus `npm run verify:matrix` after scenario evidence mapping is updated.

This path directly observes persisted state and transitions; renderer snapshots alone are insufficient for financial or lifecycle claims. Full `npm test` is not required unless focused checks expose wider regression risk.

### 9. Make queue and reminder density a contract, not renderer shaping

The shared IPC/read contracts expose two explicit bounded models: a project page whose size is always 20, and a reminder-lane result whose top level is the selected ordered business-date set. The main process owns filtering, totals, cursor interpretation, date selection and stable tie-breakers. The renderer renders the returned models and resets its project cursor when search/filter state changes; it does not fetch an oversized set and slice or regroup it locally.

The reminder renderer shows each selected business date in its column header and stacks that date’s projects vertically. Columns retain a readable minimum width. At 1024px the lane container, not the page, owns horizontal overflow, and keyboard traversal brings focused columns and controls into view with a visible focus indicator. At 1440px the layout should present all seven columns when readable widths permit, but it retains internal scrolling rather than squeezing columns below a usable width.

Editing tentative instrument count remains a scalar project update through the existing fact and DTO. After success, invalidate/refetch the project scalar model only; do not synthesize per-instrument records, infer a lifecycle event or add schema storage.

**Why:** renderer-only truncation makes totals and cursors disagree with persisted filtering, while record-first reminder truncation can consume many projects from one date and incorrectly return fewer than seven available date columns. Keeping these choices in the shared/main-process boundary makes pagination, sparse-date supplementation and refresh behavior testable and consistent without unbounded snapshots.

**Alternatives rejected:** allow the renderer to request 50 records and slice to 20; fetch a fixed reminder-record limit and group it into dates; force seven equal-width columns into every viewport; or add a second tentative-count field alongside the existing fact. These alternatives respectively create pagination drift, under-filled date lanes, unreadable layouts and competing sources of truth.

## Risks / Trade-offs

- **[Legacy regions remain outside the new enum]** → Preserve them as “待调整”, prevent new invalid writes and require explicit user correction; never guess a mapping.
- **[待进单自动进入执行中 weakens the former pre-entry rule]** → Encode it as an explicit lifecycle exception, retain the same project identity, and prevent later formal entry from regressing status.
- **[Automatic progression can race with manual edits]** → Recheck status and revision in the transaction and route both paths through lifecycle validation.
- **[Deletion can remove evidence needed by another capability]** → Reject dependent deletes, retain source audit/tombstones and recompute lifecycle only through its authority.
- **[Integrity repair could destroy customer data]** → Make diagnostics count-only and read-only by default; require backup and explicit confirmation for repair, with invoice reversal semantics preserved.
- **[Governance cleanup could be mistaken for full FK zeroing]** → Active orphan invoices are governance-revoked with the original row preserved, never physically deleted; with the non-null project FK, `PRAGMA foreign_key_check` keeps reporting those preserved rows, so cleanup reports them as an unresolved count with a manual recovery/governance path instead of claiming the check is zeroed.
- **[Sticky content reduces small-screen workspace]** → Allow internal wrapping, verify both target viewport widths and ensure focus scrolling accounts for the sticky offset.
- **[History ordering differs by record type]** → Centralize business-date selection and use a stable ID tie-breaker.
- **[A stale project cursor can be reused after filtering changes or equal sort keys can cause duplicate/missing rows]** → Bind traversal to normalized filter/search state, clear the cursor whenever that state changes, recompute filtered `total` in main and append a unique stable tie-breaker to the page order.
- **[Record-first reminder limits can hide available date columns]** → Select up to seven distinct non-empty business dates first, then query projects for those dates; keep any per-column cursor subordinate to the unchanged selected date set.
- **[Seven reminder columns can become unreadable or escape the page at narrower widths]** → Preserve a readable column width, use lane-owned horizontal scrolling, keep focus visible and accept internal scrolling at 1440px when all seven columns cannot remain readable.
- **[Editing tentative count can accidentally diverge from instrument facts or trigger lifecycle side effects]** → Reuse the existing scalar field and DTO, refresh only scalar project data after save, and verify no instrument-row or status writes occur.

## Migration Plan

1. Back up the database using the existing backup path and record the pre-migration schema version.
2. Apply the appended migration transactionally; add nullable fields/indexes without rewriting existing values.
3. Run foreign-key and orphan-count diagnostics. Structural foreign-key violations caused by pre-existing orphan rows are reported as an unresolved count with a manual recovery/governance path and do not block migration. Abort and restore the pre-migration database only if the migration itself produces a structural failure.
4. Start with domain write validation for the five regions while exposing legacy values as “待调整”.
5. Deploy read-model, lifecycle, deletion and UI changes against the migrated schema.
6. On rollback, restore the pre-migration backup before running an older binary; do not attempt to make the older binary interpret the newer schema.
