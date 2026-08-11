## 1. Focused Evidence Foundation

- [x] 1.1 Add focused migration tests covering empty-database bootstrap and v16-to-v17 upgrade, the three preset groups with seven stable-ID tags, repeat bootstrap without duplicate seeds, constraints/revision triggers, and transaction rollback on migration failure.
- [x] 1.2 Add focused domain tests proving tag association or removal preserves project main status, execution facts, reminders, and does not invoke lifecycle transitions.
- [x] 1.3 Add focused reporting tests proving multi-tag OR matching, no duplicate aggregate values for a project with multiple matching tags, and exclusion of independent records without a project when tag filtering is enabled.
- [x] 1.4 Add focused renderer tests that assert DOM order after the layout swap, grouped tag selection/display behavior, and keyboard-accessible interaction and selection linkage.

## 2. Schema v17 and Local Persistence

- [x] 2.1 Add only the v17 migration, preserving all historical migrations unchanged; create normalized tag groups, group tags, and project-tag associations with required indexes, uniqueness constraints, and business revision triggers, as demonstrated by the focused migration tests.
- [x] 2.2 Set `LATEST_SCHEMA_VERSION` to v17 and implement stable-ID, transactionally idempotent seeding for 项目类型（搬迁、PM、认证）、服务类型（暂存）和特殊仪器（LCMS TOF（65系列）、BSO、ICPMS）, with no duplicate rows after repeated bootstrap.
- [x] 2.3 Preserve tag groups, definitions, and project associations across restart and backup restore; ensure restoring a v16 backup is upgraded to v17 by bootstrap, with focused persistence tests passing.

## 3. Tag Domain and Project Integration

- [x] 3.1 Implement the independent project-classification tag module and repositories with trimmed global group-name uniqueness, trimmed group-local tag-name uniqueness, explicit integer ordering with stable-ID tie breaking, and catalog reads verified by focused tests.
- [x] 3.2 Implement creation of custom groups and group tags plus replace-set project tag assignment; deduplicate input IDs and reject unknown IDs, with focused tests confirming the final association set exactly matches valid input.
- [x] 3.3 Extend project creation to atomically persist supplied `tagIds` with the new project, and extend project editing to use replace-set assignment; prove rollback leaves neither partial project association nor lifecycle side effects.

## 4. IPC Contracts and Read Models

- [x] 4.1 Extend the shared IPC contract, preload bridge, and main-process facade with semantic catalog-read, group-create, tag-create, and project-tag-set operations; verify renderer access remains mediated by IPC rather than SQLite.
- [x] 4.2 Define and propagate tag DTOs and invalidation/refresh behavior so project creation, editing, queue, details, and current-context reads carry a lightweight grouped tag summary; verify unknown tag IDs return the established validation failure path.

## 5. Reporting Filter Pipeline

- [x] 5.1 Add `tagIds` to `ReportFilterDto` with `undefined` and empty arrays unrestricted and nonempty arrays matched by OR; confirm focused tests cover each input form.
- [x] 5.2 Build a shared reporting tag predicate using unique matching project IDs or SQL `EXISTS`, and apply it to every project-derived indicator without directly joining the tag association into fact aggregation; prove multi-tag projects do not duplicate counts or amounts.
- [x] 5.3 Apply the same shared filter to report construction, drilldown, and Excel/PNG/PDF export; when tags are selected, exclude independent records without a project from all three outputs, as confirmed by focused tests.

## 6. Workbench Tag and Layout UI

- [x] 6.1 Implement a global tag-library entry that creates groups and group-local tags, then refreshes the catalog; preserve the reviewed visual intent and verify custom tags become selectable for all projects.
- [x] 6.2 Add grouped same-group and cross-group multi-select controls to project creation and editing, and render grouped tag summaries in the queue, project details, and current context distinctly from the “未进单先执行” status tag and main status.
- [x] 6.3 Add a multi-select project-tag report filter wired to `tagIds`, including clear/unselected behavior; verify displayed metrics, drilldowns, and export actions retain the selected filter.
- [x] 6.4 Move existing project-details and current-context JSX/DOM regions to the reviewed order—reminders plus project details, project queue, current context—without CSS `order` or duplicated business components; verify existing selection and reminder/stage linkage remains intact.
- [x] 6.5 Implement responsive containment for the swapped regions using a `min-width: 0` internally scrollable details sidebar and a stackable current-context/queue split; verify 1440px, about-1180px breakpoint sides, and 1024px layouts have no page-level horizontal overflow and retain keyboard operation.

## 7. Terminology and Scenario Evidence

- [x] 7.1 Update `CONTEXT.md` to distinguish “项目分类标签”, the “未进单先执行” status tag, and the QR-code “临时标签”, with terminology review showing no ambiguity in domain language.
- [x] 7.2 Update `docs/verification/scenario-map.mjs` only where the new or changed scenario evidence requires it, preserving existing specification keywords; confirm the resulting tracked scenario matrix maps each affected scenario.

## 8. Final Verification

- [x] 8.1 Run the relevant focused Vitest files for migrations, tag domain/repositories, reporting, and renderer interaction; all added and affected focused tests pass.
- [x] 8.2 Run `npm run typecheck` and resolve all TypeScript errors introduced by the change.
- [x] 8.3 Run `npm run e2e:build` before `npx playwright test <相关spec> --workers=1`; confirm the relevant packaged-workbench E2E scenarios pass.
- [x] 8.4 Run `npm run verify:matrix`, inspect any tracked `scenario-test-matrix.md` rewrite, and retain only intended scenario-evidence changes.
