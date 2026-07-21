# Release Preparation

MrMaLiang uses one lockstep pre-1.0 version across its root product, LongWrite, LongExperiment, and the research protocol. MalaClaw is an external compatibility dependency; the supported range is declared in [`runtime-compatibility.json`](../runtime-compatibility.json) and its resolved version is written to run provenance.

Before creating a public Git tag or publishing any package:

1. Run `npm run build` and `npm test` on Node 22.
2. Run one small real flagship with an audited experiment manifest where applicable.
3. Verify `reports/run-provenance.json`, the immutable records in `reports/provenance/`, and all final output checksums.
4. Update the changelog and version consistently.
5. Create the Git tag only after the release artifacts and their provenance have been archived.

No public package publication or GitHub release is performed automatically by this repository. Those are deliberate maintainer actions because they create irreversible external state.
