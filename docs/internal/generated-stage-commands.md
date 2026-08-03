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
| `publication package` | — | `package_submission` |
| `research assess` | — | `assess`, `final_release_assess_research` |
| `research classify` | `--topic` | `classify` |
| `research codebases` | — | `codebase_prepare` |
| `research comparison-opportunities` | — | `comparison_opportunities` |
| `research corpus-gates` | `--advisory` | `corpus_gate_assessment`, `corpus_gates`, `corpus_recovery_assessment`, `quality_corpus_gates` |
| `research dispatch-metrics` | — | `quality_dispatch_metrics` |
| `research enrich` | `--disabled` `--max-sources` | `enrich` |
| `research expand` | `--action-plan` | `corpus_recovery_expand`, `targeted_research_expansion` |
| `research finalize-evidence-depth` | — | `corpus_recovery_finalize_evidence_depth`, `finalize_evidence_depth`, `quality_finalize_evidence_depth` |
| `research fulltext` | `--max-sources` `--no-pdf-download` | `corpus_recovery_fulltext`, `fulltext`, `quality_fulltext_refresh` |
| `research gate-reachability` | — | `gate_reachability` |
| `research prepare-experiment` | — | `experiment_evidence_prepare` |
| `research recall` | `--provider` `--query-budget` `--target-candidates` `--topic` | `recall` |
| `research reconcile-identities` | — | `identity_reconcile` |
| `research score` | — | `score` |
| `research select-semantic-candidates` | — | `semantic_candidate_select` |
| `research select-source-evidence-candidates` | — | `corpus_recovery_source_candidate_select`, `quality_source_evidence_candidate_select`, `source_evidence_candidate_select` |
| `research snowball` | — | `snowball_recall` |
| `research survey-contract` | — | `outline_initial_survey_contract`, `outline_recheck_survey_contract`, `quality_outline_survey_contract`, `survey_contract` |
| `research venue-upgrade` | — | `venue_upgrade` |
| `research verify` | `--max-sources` | `final_release_verify_citations`, `verify_citations` |
| `review claims` | — | `claim_score` |
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
