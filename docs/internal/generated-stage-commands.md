# Generated stage commands

Every deterministic command the compilers emit into a MalaClaw manifest,
derived from the frozen golden manifests in
`packages/*/tests/fixtures/compiled/`. **Do not edit by hand** — regenerate with:

```bash
UPDATE_GOLDEN=1 npx vitest run tests/generated-stage-commands.test.ts \
  --root packages/longwrite
```

This is the MM-0.2 inventory: MM-1 and MM-2 relocate the `longwriteCommand()`
and `longexperimentCommand()` call sites, and this table is what proves the
resulting manifests still invoke the same subcommands.

## `longwrite`

| Subcommand | Flags | Stages |
| --- | --- | --- |
| `build research` | — | `initial_build`, `rebuild` |
| `build visual-review` | — | `render_visual_review` |
| `draft section` | — | `draft` |
| `evidence allocate` | — | `allocate_evidence`, `quality_allocate_evidence`, `quality_reallocate_outline_evidence` |
| `evidence audit` | — | `evidence_audit` |
| `evidence consolidate` | — | `citation_ledger`, `consolidate_citations` |
| `evidence index` | — | `corpus_recovery_evidence_index`, `evidence_index`, `quality_evidence_index_refresh` |
| `metrics acquire` | `--metric` | `acquire_claim_support`, `acquire_latex_build_status`, `acquire_rendered_visual_review`, `acquire_review_score` |
| `metrics evaluate` | `--tier` | `measure_round_metrics`, `measure_unit_metrics` |
| `publication package` | — | `package_submission` |
| `research assess` | — | `assess`, `final_release_assess_research` |
| `research assess-final-release-progress` | — | `final_release_progress` |
| `research assess-reachability` | — | `assess_reachability` |
| `research backfill-validated-evidence-history` | — | `quality_backfill_validated_evidence_history` |
| `research citation-repair-packet` | — | `citation_repair_packet` |
| `research cited-source-upgrade-packet` | — | `cited_source_upgrade_packet` |
| `research classify` | `--topic` | `classify` |
| `research codebases` | — | `codebase_prepare` |
| `research comparison-registry` | — | `comparison_registry` |
| `research corpus-gates` | `--advisory` | `corpus_gate_assessment`, `corpus_gates`, `corpus_recovery_assessment`, `quality_corpus_gates` |
| `research dispatch-metrics` | — | `quality_dispatch_metrics` |
| `research enrich` | `--disabled` `--max-sources` | `enrich` |
| `research expand` | `--action-plan` | `corpus_recovery_expand`, `targeted_research_expansion` |
| `research final-release-baseline` | — | `final_release_baseline` |
| `research finalize-evidence-depth` | — | `corpus_recovery_finalize_evidence_depth`, `finalize_evidence_depth`, `quality_finalize_evidence_depth` |
| `research fulltext` | `--max-sources` `--no-pdf-download` | `corpus_recovery_fulltext`, `fulltext`, `quality_fulltext_refresh` |
| `research gate-reachability` | — | `gate_reachability` |
| `research generate-final-release-plan` | — | `final_release_plan` |
| `research import-experiment` | `--manifest` | `experiment_import` |
| `research prepare-experiment` | — | `experiment_evidence_prepare` |
| `research recall` | `--provider` `--query-budget` `--target-candidates` `--topic` | `recall` |
| `research reconcile-identities` | — | `identity_reconcile` |
| `research reconcile-targets` | — | `reconcile_targets` |
| `research repair-bibliography` | — | `repair_bibliography` |
| `research repair-citation-plan` | — | `repair_citation_plan` |
| `research repair-source-metadata` | — | `repair_source_metadata` |
| `research score` | — | `score` |
| `research select-semantic-candidates` | — | `semantic_candidate_select` |
| `research select-source-evidence-candidates` | — | `corpus_recovery_source_candidate_select`, `quality_source_evidence_candidate_select`, `source_evidence_candidate_select` |
| `research snowball` | — | `snowball_recall` |
| `research survey-contract` | — | `outline_initial_survey_contract`, `outline_recheck_survey_contract`, `quality_outline_survey_contract`, `survey_contract` |
| `research venue-upgrade` | — | `venue_upgrade` |
| `research verify` | `--max-sources` `--section` | `final_release_verify_citations`, `verify_citations`, `verify_section_citations` |
| `review assess-disagreement` | — | `assess_review_disagreement` |
| `review claims` | — | `claim_score` |
| `review diagnose-objective` | — | `build_diagnosis_packet` |
| `review outline-approval` | — | `outline_approval_gate` |
| `review request-clarification` | `--action-plan` | `request_operator_clarification` |
| `review score-outline-readiness` | — | `outline_initial_readiness_score`, `outline_recheck_readiness_score` |
| `review split-action-plan` | — | `action_plan_split` |
| `review structure` | — | `outline_initial_structure_audit`, `outline_recheck_structure_audit`, `quality_outline_structure_audit`, `structure_audit` |
| `review validate-outline-reopen` | `--action-plan` | `quality_outline_reopen_validate` |
| `validate research` | `--advisory` | `final_release_assessment`, `final_validate` |

## `longexperiment`

| Subcommand | Flags | Stages |
| --- | --- | --- |
| `stage aggregate` | — | `aggregate_results` |
| `stage approval candidate` | — | `candidate_execution_approval` |
| `stage approval design` | — | `design_approval` |
| `stage approval revision` | — | `revision_approval` |
| `stage audit` | — | `audit_results` |
| `stage audit-study` | — | `audit` |
| `stage design` | — | `design` |
| `stage materialize-candidate` | — | `materialize_candidate` |
| `stage pin-inputs` | — | `pin_inputs` |
| `stage report` | — | `report` |
| `stage research-context` | — | `experiment_research_context` |
| `stage run-agentic-study` | — | `execute` |
| `stage run-study` | — | `execute` |
| `stage smoke-candidate` | — | `smoke_candidate` |
| `stage suite-plan` | — | `suite_plan` |
| `stage test-candidate` | — | `test_candidate` |
| `stage validate-proposal` | — | `validate` |
| `stage validate-result-interpretation` | — | `validate_result_interpretation` |
| `stage worktrees` | — | `prepare_worktrees` |

## Other commands

| Command | Subcommand | Stages |
| --- | --- | --- |
| `sh` | `(no subcommand)` | `execute` |
