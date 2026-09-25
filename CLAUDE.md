# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this project is

**Jev Guard & Router** — a safety layer for AI coding agents. A `PreToolUse` hook intercepts every tool call made by the **Antigravity agent** and by **Claude Code**, sends it to **Jev** (TypeSafe AI's System One model) for a risk judgement, and allows or blocks it before it runs. A secondary "Intent Router" surface uses the same model to route command-palette commands to editor tools.

Design docs, in reading order: `PRD.md` (what and why) → `HLD.md` (components and flows) → `LLD.md` (types, algorithms, contracts) → `implementation-plan.md` (build order, definitions of done).

**Jev does not generate text.** It answers typed questions (`noul`, `choice`, `score`) with calibrated probabilities. All behaviour is decided by our deterministic code from those numbers. Never design a feature that expects Jev to produce prose, arguments, code, or a tool's parameters.

## Repository layout

```
packages/core/        jev-core     — Jev client, questions, policy, prefilter, config, redaction, log
packages/guard/       jev-guard    — CLI invoked as a hook; adapters/agy.ts, adapters/claude.ts
packages/extension/   Antigravity/VS Code extension — installer, Guard Console, Router
eval/                 labelled cases + benchmark runner
docs/                 captured payloads, host behaviour notes, eval results
```

npm workspaces, TypeScript strict, vitest, esbuild.

## Commands

```bash
npm install                    # root, installs all workspaces
npm test                       # all unit tests
npm test -w packages/core      # one workspace
npm run build                  # bundles dist/guard.js and dist/extension.js
npm run eval                   # eval/run.ts — misses, FP rate, latency, calibration
npm run package                # vsce package → .vsix
JEV_LIVE=1 npm test            # includes the live API smoke test
```

Manual guard check:

```bash
echo '{"toolCall":{"name":"run_command","args":{"CommandLine":"rm -rf ./src"}}}' \
  | node dist/guard.js --agent agy
```

## Non-negotiable invariants

These are correctness and safety properties, not style preferences. Breaking one is a bug even if the tests pass.

1. **`jev-guard` always writes valid JSON to stdout and exits 0.** A non-zero exit or malformed output can break the host agent's loop. Every path, including internal errors, goes through the fallback verdict.
2. **Fail closed.** Missing key, timeout, network error, malformed payload → `ask` (Claude Code) or `force_ask` with a "guard unavailable" reason (Antigravity). Never `allow` on error.
3. **The API key never reaches the log, the Console, an error message, or stdout.**
4. **Redaction applies to logs only.** The Jev request carries the original argument values; it can't judge risk on redacted text.
5. **The installer merges, never overwrites.** Back up first, write to a temp file, then rename. Other people's hooks must survive.
6. **Shell/terminal tools are never pre-filtered**, however harmless the command looks.
7. **No secrets, tokens, or absolute personal paths in committed fixtures.** Scrub captured payloads.
8. **The adapters are the only agent-specific code.** `packages/core` must not import anything that knows about Antigravity or Claude Code.

## Conventions

- TypeScript strict; no `any` in exported signatures. Errors are typed (`JevError` with a `kind`).
- Pure logic (`policy`, `prefilter`, `redact`, `questions`) stays free of I/O so it can be unit-tested directly.
- Thresholds, tool lists, and timeouts come from config, never hardcoded at a call site.
- Adapter behaviour is locked by golden fixture tests: payload in, expected stdout out, byte for byte.
- Small commits per plan task, with the task number in the message (e.g. `2.3 agy adapter`).

## Verified vs. assumed

Two external contracts were verified by hand in Phase 0 and written down. **Trust the docs, not your memory of these APIs:**

- Jev's response field names → `docs/jev-response-sample.json` and `LLD.md` §3.2.
- Antigravity and Claude Code hook payload and output formats → `packages/guard/test/fixtures/` and `docs/host-behaviour.md`.

If runtime behaviour contradicts a doc, update the doc in the same change. Never leave code that silently compensates for a doc that is wrong.

## Things not to do

- Don't add an MCP server as the guard's integration path. MCP tools are only called if the model chooses to; hooks are unavoidable, which is the whole point.
- Don't introduce a backend service, database, or local HTTP daemon. The filesystem under `~/.jev/` is the bus between hook processes and the IDE.
- Don't call a generative LLM on the guard hot path.
- Don't widen the pre-filter to hit a latency target without re-running `npm run eval`; every widening is a potential miss.
- Don't touch any file outside the two host config paths and `~/.jev/`.
- Don't commit real `.vsix` builds or `~/.jev/` contents.

## Testing expectations

Any change to `policy`, `prefilter`, or an adapter needs its unit test updated in the same commit, and `npm run eval` re-run if thresholds or the pre-filter list moved. The evaluation bar is: zero dangerous calls allowed, ≤ 10% of safe calls blocked or asked, p50 under 400 ms.

## Current status

Phase 0 onwards — see the checkboxes in `implementation-plan.md` for what's done. Update them as you go.
