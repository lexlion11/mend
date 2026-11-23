# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/lexlion11/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/lexlion11/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend applies an edit that an AI model wrote to a tree of text files. It reads four patch
formats — a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A
patch format and text-editor tool calls as JSON — finds the lines each edit names at the
first of three matching tiers, and writes every change or none.

- `main.ts` — the CLI: `node main.ts [--format=NAME] [--check] [--strict] [PATCH]`, Node 22
  and the standard library alone.
- `runner.ts` — the trial runner: reads the checks from the trial env and posts what the
  CLI did. It hands over from `main.ts` when `MAKEFUN_ENV_URL` is set.
- `SPEC.md` — the specification mend implements.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

With no `PATCH` the patch is read from standard input. `--format` selects one of `unified`,
`search-replace`, `v4a`, `json` or `auto` (the default, which detects the format).
`--check` computes the result without writing; `--strict` matches lines exactly.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
