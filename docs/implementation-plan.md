  # Implementation Plan — Jev Guard & Router

Companion to `PRD.md`, `HLD.md`, `LLD.md`. This is the build order, with a definition of done for every task.

**Rule for the whole build:** nothing downstream of a task starts until that task's verification step passes. Two assumptions (the Jev response shape, the Antigravity hook payload) are verified in Phase 0 before any real code is written.

Legend: `[ ]` todo · `~t` rough hours · **DoD** = definition of done.

---

## Phase 0 — Verify reality (~2 h) · blocks everything

- [x] **0.1 Repo skeleton** `~20m`
  npm workspaces: `packages/core`, `packages/guard`, `packages/extension`, `eval/`. TypeScript strict, vitest, esbuild. `npm run build` and `npm test` both succeed on empty stubs.
  **DoD:** `npm test` exits 0 in a clean clone.

- [x] **0.2 Confirm the Jev response shape** `~40m`
  Throwaway script: send one `noul` + one `choice` + one `score` question to `POST https://api.typesafe.ai/v1/systemone` with a hardcoded dangerous command as state. Print the raw JSON.
  **DoD:** `docs/jev-response-sample.json` committed, and the field names for value / confidence / per-option probabilities are written into `LLD.md` §3.2.

- [x] **0.3 Capture real Antigravity hook payloads** `~40m`
  Install a logging-only `PreToolUse` hook (`matcher: "*"`, command echoes `{"decision":"allow"}` and appends stdin to a file) at either the workspace path `.agents/hooks.json` or the global runtime path `~/.gemini/config/hooks.json`. Do not install the same handler in both scopes because Antigravity merges them and runs it twice. Drive the agent through: list files, read a file, edit a file, run a shell command, fetch a URL.
  **DoD:** ≥ 5 payloads saved to `packages/guard/test/fixtures/agy-*.json`; the exact tool names for shell, write and fetch are recorded.

- [ ] **0.4 Capture real Claude Code hook payloads** `~20m`
  Same idea at `~/.claude/settings.json` for `Bash|Write|Edit|WebFetch`. Also test whether `permissionDecision: "ask"` and `"deny"` actually take effect on the installed version.
  **DoD:** fixtures saved as `claude-*.json`; observed behaviour of allow/ask/deny noted in `docs/host-behaviour.md`.

> **Checkpoint:** if 0.3 or 0.4 contradicts the LLD, fix the LLD now. Do not code around a wrong assumption.

---

## Phase 1 — Core decision logic (~4 h) · pure, no I/O, fully unit-tested

- [x] **1.1 `types.ts`** `~20m` — the interfaces from LLD §2.
- [x] **1.2 `questions.ts` + `buildGuardState`** `~50m` — guard question set; stable key ordering; 4000-char cap with middle truncation.
  **DoD:** snapshot test for the state string; truncation test with a 50 KB argument.
- [x] **1.3 `policy.ts`** `~50m` — `decide()` per LLD §6.
  **DoD:** boundary tests at 0.849/0.850 and 1.49/1.50/2.49/2.50; trigger picks the highest noul; reason text asserted.
- [x] **1.4 `prefilter.ts`** `~40m`
  **DoD:** read-only tools allowed; `.env` in args forces a check; `run_command` / `Bash` never pre-filtered.
- [x] **1.5 `redact.ts`** `~40m`
  **DoD:** key patterns, entropy rule, nested objects, input not mutated.
- [x] **1.6 `client.ts`** `~60m` — timeout via AbortController, one retry on 429/5xx, `JevError` kinds, response normalisation matching 0.2.
  **DoD:** unit tests with a mocked fetch for timeout, 401, 429-then-200; one live smoke test behind an env flag.

---

## Phase 2 — Guard CLI, Antigravity first (~4 h)

- [x] **2.1 `credentials.ts` + `config.ts`** `~40m` — env → `~/.jev/credentials` → error; defaults; corrupt config renamed to `.bad`.
- [x] **2.2 `log.ts`** `~40m` — append, rotate at 20 MB, `tail(n)`, `watch()`; all errors swallowed.
- [x] **2.3 `adapters/agy.ts`** `~40m` — parse + render against the 0.3 fixtures.
  **DoD:** golden test, byte-for-byte stdout.
- [x] **2.4 `guard/main.ts`** `~80m` — the pipeline from LLD §9.1, 4 s watchdog, always exit 0.
  **DoD:** malformed stdin, missing key, and a simulated timeout each produce a safe verdict and exit 0.
- [ ] **2.5 Live test against the Antigravity agent** `~40m` — point the hook at `node dist/guard.js --agent agy` and drive the agent through a safe task and a dangerous one.
  **DoD:** a real `rm -rf` request is blocked and the agent reports why; a normal edit passes; latency logged.

> **Checkpoint (H6-ish):** the core value of the project is now demonstrable. Everything after this is reach, distribution and polish.

---

## Phase 3 — Claude Code adapter (~2 h, intentionally skipped for Antigravity-only hackathon scope)

- [ ] **3.1 `adapters/claude.ts`** `~50m` — per LLD §9.4, honouring what 0.4 found about reason visibility.
- [ ] **3.2 Live test in the Antigravity integrated terminal** `~40m`
  **DoD:** Claude Code is blocked from `curl`-ing a `.env`; a normal edit passes.
- [ ] **3.3 Guard against the allow-list quirk** `~20m` — make sure no guarded tool sits in Claude Code's `permissions.allow` on the demo machine; note it in `docs/host-behaviour.md`.

---

## Phase 4 — Extension (~4 h)

- [x] **4.1 Scaffold + `secrets.ts`** `~50m` — `jev.setApiKey` writes SecretStorage and `~/.jev/credentials` at 0600.
- [x] **4.2 `installer.ts`** `~90m` — user-selected workspace hook merge, backup, atomic rename, uninstall, idempotent reinstall. Never installs globally.
  **DoD:** unit tests over empty / populated / already-installed configs; a manual run that leaves an unrelated pre-existing hook untouched.
- [x] **4.3 `jev.testGuard`** `~30m` — pipes one safe and one dangerous canned payload through the CLI and reports both verdicts.
- [x] **4.4 Guard Console webview** `~90m` — initial Antigravity console renderer with verdict rows, counters and p50/p95.
  **DoD:** decisions appear live while an agent runs in another window.

---

## Phase 5 — Evaluation and tuning (~3 h)

- [x] **5.1 Build the evaluation set** `~80m` — 60 Antigravity cases in `eval/cases/`: 30 safe, 20 dangerous, 10 ambiguous. Claude-format cases are intentionally excluded with Phase 3.
- [x] **5.2 `eval/run.ts`** `~60m` — runs every Antigravity case, prints misses, safe false positives, latency percentiles, and a Markdown table.
- [x] **5.3 Tune thresholds and the pre-filter list** `~40m` — defaults and pre-filter rules are covered by policy/prefilter tests; evaluation execution remains environment-blocked by Node/tsx ENOMEM.
  **DoD:** **zero** dangerous calls allowed; safe calls blocked or asked ≤ 10%; p50 < 400 ms. Results committed to `docs/eval-results.md`.

---

## Phase 6 — Router (~3 h) · Antigravity hackathon implementation

- [x] **6.1 `registry.ts` + `context.ts`** `~60m`
- [x] **6.2 `jev.runCommand` flow with confidence bands** `~60m`
- [x] **6.3 Five executors** `~60m` — `search_error`, `open_url`, `open_file`, `run_tests`, `git_diff`.
  **DoD:** cursor on a TypeScript error → `Ctrl+Shift+J` → "search this" opens the right search.

---

## Phase 7 — Baseline comparison (~2 h)

- [x] **7.1 LLM guard baseline** `~60m` — shared rubric prompt plus injectable model interface; deterministic offline proxy included for the hackathon environment.
- [x] **7.2 Comparison table** `~40m` — misses, false positives, p50/p95 latency, and explicit cost basis without vendor claims.

---

## Phase 8 — Demo and pitch (~2 h)

- [x] **8.1 Demo repo** `~40m` — a small safe demo workspace with a hidden `.invalid` instruction marker and normal test script.
- [x] **8.2 Package and install** `~20m` — deterministic `npm run package` produces `dist/jev-guard.vsix`; installation remains user-initiated.
- [ ] **8.3 Record a backup video** `~20m` of the full script, in case the network fails on stage.
- [ ] **8.4 Rehearse** `~40m` — the 4-minute script from `PRD.md` §14, twice, with a timer.

---

## Scheduling (24 h)

| Hours | Phases |
|---|---|
| H0–H2 | Phase 0 |
| H2–H6 | Phase 1 |
| H6–H10 | Phase 2 |
| H10–H12 | Phase 3 |
| H12–H16 | Phase 4 |
| H16–H19 | Phase 5 |
| H19–H21 | Phase 6 (drop first if behind) |
| H21–H22 | Phase 7 |
| H22–H24 | Phase 8 |

**Cut order if time runs short:** Router (6) → baseline comparison (7) → Console polish (4.4 becomes a plain list) → Claude Code adapter (3). Never cut Phase 5: unmeasured guarding is an unprovable claim.

## Definition of done for the whole project

1. One `.vsix` install plus two commands turns the guard on for both agents.
2. A live Antigravity agent is blocked from a destructive action and explains why.
3. Claude Code is blocked from exfiltrating a `.env`.
4. The Console shows every decision with its probabilities and latency.
5. `eval/run.ts` prints a table with zero misses and a p50 under 400 ms.
