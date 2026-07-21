# MrMaLiang Quick Start

MrMaLiang requires Node.js 22+ and a compatible `malaclaw` command on `PATH`. MalaClaw remains an external runtime dependency.

```bash
npm install
npm run build
npm link --workspace @mr-maliang/maliang
maliang template list
```

The source checkout and published installations both use the same public
`maliang` command. Component CLIs are private workflow implementation details.

For a survey:

```bash
maliang init agent-survey --template paper.survey --topic "Long-horizon agent memory"
maliang run agent-survey --runtime codex
```

Add a repository and its original paper without enabling experiment execution:

```bash
maliang init repo-survey \
  --template paper.survey \
  --topic "Architecture and evidence of an autonomous research system" \
  --repository https://github.com/example/project.git \
  --reference-link https://arxiv.org/abs/2401.01234  # replace with the real paper
```

Or let the survey discover a bounded set of related repositories:

```bash
maliang init discovered-repo-survey \
  --template paper.survey \
  --topic "Architectures of autonomous research systems" \
  --discover-repositories \
  --repository-query-budget 4 \
  --repository-max-selected 3
```

Discovery performs metadata/README screening and immutable Git pinning. It
does not execute selected code or recursively crawl repositories mentioned by
their documentation.

For a new experiment paper, select it explicitly:

```bash
maliang init empirical-study \
  --template paper.empirical \
  --topic "A controlled intervention" \
  --hypothesis "The treatment improves the fixed primary metric."
```

Use `--experiment-authoring prescribed` when the operator supplies the protocol
and runner. Use `paper.empirical-import` only for an existing audited
MrMaLiang-compatible result manifest, not for figures or claims in an upstream
repository.

## Release-ready flagship runbooks

Use the dedicated runbook for the chosen template before creating a real run:

- [Flagship runbook hub](./flagships/README.md)
- [Long agentic survey](./flagships/long-agentic-survey.md)
- [Repository survey](./flagships/repository-survey.md)
- [nanoGPT agentic empirical paper](./flagships/nanogpt-agentic-empirical-paper.md)
- [Self-play autonomous empirical paper](./flagships/self-play-autonomous-empirical-paper.md)

The survey paths are the safest first live runs. The empirical paths are
executable release candidates: use `maliang preflight <workspace>`, review both
approval gates, and start on locally controlled compute. The older standalone
nanoGPT, self-play, and ProteinGym prescribed-runner examples remain incubating.
Follow [Remote GPU with Modal](./remote-gpu-modal.md) only when a reviewed remote
adapter—not an agentic local entrypoint—is selected.
