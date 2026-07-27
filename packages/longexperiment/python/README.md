# MalaClaw scientific runner protocol

Python runners receive a versioned `run_trial` request through
`LONGEXPERIMENT_PROTOCOL_REQUEST`. During the migration they also receive the
legacy `LONGEXPERIMENT_*` environment variables. Read the request with
`maliang_experiment_protocol.read_request()` and emit exactly one final JSON
line with `emit_completed()`.

Runners may write only workspace-relative artifacts below the declared
`artifact_dir`. LongExperiment remains the statistic auditor and manifest
writer; a runner only reports measurements and artifact paths.
