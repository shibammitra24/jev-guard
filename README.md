<p align="center">
  <img src="assets/jev-guard-logo.png" alt="Jev Guard" width="120">
</p>

<h1 align="center">Jev Guard</h1>
<p align="center"><strong>An independent, typed safety check that runs before every tool call an AI coding agent makes.</strong></p>

<p align="center">
  <a href="#quickstart">Quickstart</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#guard-console">Guard Console</a> ·
  <a href="#jev-fast-browser">Fast Browser</a> ·
  <a href="#repository-layout">Repo layout</a> ·
  <a href="#testing--evaluation">Testing</a>
</p>

---

## The problem

Coding agents like the Antigravity agent don't just suggest code anymore — they run shell commands, edit and delete files, fetch URLs, and drive a real browser, autonomously and by default. That's what makes them useful, and it's also what makes one bad plan (or one prompt injection hidden in a README or a web page) able to delete a project, leak a `.env` file, or submit a form it should never have touched — before a human ever sees it happen.

The usual fixes don't hold up:

- **Static allow/deny lists** are brittle — they can't tell `git status` from `git clean -fdx` in a slightly different shell dialect.
- **Routing every call through a second general-purpose LLM** is slow and costly enough that nobody actually enables it for *every* tool call, and it still just produces a confident-sounding guess.

Jev Guard adds a third option: a fast, typed, independent decision at the exact moment before a tool call executes.

## What it is

Jev Guard is a `PreToolUse` hook — the mechanism the host agent itself invokes before running any tool — wired up to **Jev**, TypeSafe AI's System One decision model. Jev doesn't write text; it answers structured questions with calibrated probabilities (`noul`, `choice`, `score`). All of the actual behaviour — the thresholds, the deterministic hard-blocks, the redaction, the fail-closed handling — is ordinary, auditable TypeScript. Jev supplies numbers; this repo decides what to do with them.

```json
// what the agent sees when it tries something dangerous — real output, default policy
{
  "decision": "deny",
  "reason": "[BLOCKED BEFORE EXECUTION] Jev Guard: recursive or wildcard destructive command. This action was blocked — \"Destructive file/git operations\" is turned off in the Guard Console allow/deny list."
}
```

One monorepo, one shared decision core, and three surfaces built on it:

| Surface | What it does |
| --- | --- |
| **Guard** (primary) | Intercepts every tool call from the host agent, sends it to Jev, and allows / asks / denies before it runs. |
| **Guard Console** | A VS Code/Antigravity sidebar panel that tails the live decision log and exposes an allow/deny toggle list. |
| **Jev Fast Browser** | Runs the agent's browser tool through the same guarded decision boundary, action by action, over the real Chrome DevTools Protocol — no screenshot loop. |
| **Intent Router** (secondary) | A command-palette input box (`Jev: Run Command`) where Jev picks the right editor tool for a short typed request. |

## How it works

```
        Antigravity IDE
   ┌───────────────────────────────────────────────┐
   │  ┌──────────────┐                             │
   │  │  Agent about  │  PreToolUse hook            │
   │  │  to call a    ├──────────────┐              │
   │  │  tool         │              ▼              │
   │  └──────────────┘   ┌─────────────────────┐    │
   │                      │   jev-guard (CLI)   │────┼──► Jev API (api.typesafe.ai)
   │                      └──────────┬──────────┘    │
   │                                 │ append          │
   │                                 ▼                 │
   │                    ~/.jev/decisions.jsonl         │
   │                                 │ tail             │
   │                      ┌──────────┴──────────┐      │
   │                      │  Extension: Guard   │      │
   │                      │  Console · Installer│      │
   │                      │  · Intent Router    │      │
   │                      └─────────────────────┘      │
   └───────────────────────────────────────────────────┘
```

For every tool call:

1. **A local pre-filter** allows genuinely read-only tools (`list_dir`, `view_file`, `Read`, `Grep`, …) with no network round-trip at all — safe work stays instant.
2. **Deterministic rules** hard-block a short list of unambiguous danger classes (recursive/forced deletes, exfiltration commands referencing secrets, edits to the guard's own config) *before* Jev is ever asked, and hard-allow the routine, reversible edits and build/test commands every session needs.
3. **Everything else** goes to Jev as one batched request — six typed questions (`destructive`, `secrets`, `exfiltration`, `outsideWorkspace`, `userExplicit`, `risk`), answered in parallel, in one round trip.
4. **The policy** (`packages/core/src/policy.ts`) turns those probabilities into a verdict against fixed thresholds — `deny` above 0.85 (or risk ≥ 2.5), `ask` above 0.5 (or risk ≥ 1.5), otherwise `allow` — and a single-file delete the user explicitly asked for is downgraded from a hard deny to a confirmable `ask` rather than treated the same as a wildcard `rm -rf`.
5. **Every decision is logged** to `~/.jev/decisions.jsonl` — timestamp, tool, redacted arguments, every probability, the verdict, and the latency — which is what the Guard Console renders live.

Anything that goes wrong — a timeout, a missing key, a malformed payload, a crash inside the CLI itself — resolves to `ask`/`deny`, never to a silent `allow`. See [Security & fail-closed design](#security--fail-closed-design).

## Guard Console

A sidebar webview (`Jev Guard` icon in the activity bar) that tails the decision log in real time: agent · tool · verdict badge · top probability · latency, with header stats for calls guarded / blocked / asked and p50 latency.

It also exposes the **allow/deny list** — the same catalog defined once in `packages/core/src/toolPolicy.ts` and enforced by the CLI:

- **Tool toggles** (read, write, shell, URL fetch, web search, browser automation) default **on**. Turning one off is an immediate deny for every call to that tool, before Jev or the browser is ever contacted — a per-tool kill switch.
- **Dangerous-category toggles** (destructive ops, exfiltration, secret access, writes outside the workspace, guard tampering) default **off**, matching the deterministic hard-block. Turning one on is explicit permission for that category: the call is allowed outright — whether the deterministic regex recognized it *or* Jev's own signal is what flagged it — instead of being re-judged and denied again anyway.
- Toggles persist to `~/.jev/tool-policy.json` and take effect on the very next tool call. No reload, no reinstall.
- A tool toggled off always wins over a category toggled on (shell commands off still blocks `rm -rf`, whatever the destructive-category switch says).

## Jev Fast Browser

Browser automation is a harder safety problem than shell commands: the agent clicks, types, selects, scrolls, and submits, and a page that changes mid-decision can make a previously safe choice land on the wrong element.

Jev Fast Browser (`packages/browser`) runs the agent's `browser_subagent` calls through a dedicated pipeline instead of a screenshot loop:

- **A structured DOM snapshot**, not a screenshot: every visible interactive element gets a stable, code-owned action ID (`e1`, `e2`, …). Jev picks from IDs it actually observed — a hallucinated selector, coordinate, or URL is rejected outright.
- **One combined Jev request per step**: which action to take *and* the five guard signals, in one round trip.
- **Freshness checks before and immediately after** the guard decision, so a page that changed underneath a click is retried on fresh state rather than silently mis-clicking.
- **One visible window, one tab**: the sidecar takes over the tab the browser opened rather than spawning a second one, and window.open()/target=_blank navigation is kept in that same tab.
- Low-risk steps (click, scroll, wait, select) can proceed autonomously once Jev sees no destructive/secret/exfiltration signal, gated by the same Guard Console toggles; typing and submitting are separately gated and never invent text — every fill comes word-for-word from the task.

In a local matched Chrome benchmark (`npm run eval:browser:live`, three task shapes × five runs, documented in `docs/browser-benchmark-results.md`), the guarded loop used **51.3% fewer CDP protocol calls** and had **94.0% lower mean browser-loop wall time** than an equivalent screenshot-per-step loop, with the destructive task blocked in every run. That figure covers only the local browser-side observation/execution loop — it excludes remote Jev latency, public-site network time, and visual-only pages.

> **Known limitation:** Antigravity's `PreToolUse` hook can allow, ask, or deny a call, but it cannot inject a synthetic *successful* result back into the agent. A completed browser task therefore reports its result through the hook's denial-reason channel — the agent may show a "denied by pre-tool hook" message even though the task ran and finished. This is a documented host-integration constraint (`docs/host-behaviour.md`), not a bypass of the safety check.

## Repository layout

```
packages/core/        jev-core          — Jev client, questions, policy, prefilter, config, redaction, log
packages/guard/       jev-guard-cli     — CLI invoked as the hook; adapters/agy.ts, adapters/browser-bridge.ts
packages/browser/     jev-fast-browser  — guarded CDP session, DOM snapshot, browser goal loop
packages/extension/   jev-guard-extension — VS Code/Antigravity extension: installer, Guard Console, Intent Router
eval/                 jev-guard-eval    — labelled cases + benchmark runner
docs/                 design docs, captured host payloads, benchmark results
```

npm workspaces, TypeScript strict throughout, Vitest for tests, esbuild for bundling. Design docs, in reading order: `docs/PRD.md` → `docs/HLD.md` → `docs/LLD.md` → `docs/implementation-plan.md`.

## Quickstart

**Prerequisites:** Node.js ≥ 20, and a Typesafe API key for Jev (`TYPESAFE_API_KEY`).

```bash
git clone https://github.com/shibammitra24/jev-guard.git
cd jev-guard
npm install
npm test              # 300 tests across all workspaces (1 skipped without JEV_LIVE=1)
npm run build         # bundles dist/guard.js and dist/extension.js
npm run package        # → dist/jev-guard.vsix
```

Then, inside VS Code / Antigravity:

1. **Extensions → Install from VSIX…** → select `dist/jev-guard.vsix`, then reload the window.
2. Open the workspace you want protected.
3. Command Palette → **`Jev: Set API Key`** → paste your `TYPESAFE_API_KEY`.
4. Command Palette → **`Jev: Install Antigravity Guard`** for that workspace. This backs up any existing hook config, then merges (never overwrites) a `PreToolUse` entry into `.agents/hooks.json` that calls the installed `guard.js`.
5. Open the **Jev Guard** icon in the activity bar to watch decisions arrive as the agent works.

Try it: ask the agent to read a file (allowed instantly), then ask it to `rm -rf` something (blocked, with the reason shown in the console). `docs/JUDGE_DEMO_RUNBOOK.md` has a full five-minute walkthrough, including the browser demo, using a disposable workspace.

**Manual guard check**, no IDE required:

```bash
echo '{"toolCall":{"name":"run_command","args":{"CommandLine":"rm -rf ./src"}}}' \
  | node dist/guard.js --agent agy
# {"decision":"deny","reason":"[BLOCKED BEFORE EXECUTION] Jev Guard: recursive or wildcard
#  destructive command. This action was blocked — \"Destructive file/git operations\" is
#  turned off in the Guard Console allow/deny list."}
```

## Configuration & local state

Everything lives under `~/.jev/` — the filesystem is the bus between the short-lived hook process and the IDE; there's no daemon, no port, no database.

| Path | Written by | Purpose |
| --- | --- | --- |
| `~/.jev/credentials` | Extension (`Jev: Set API Key`) | API key, `0600` permissions. `TYPESAFE_API_KEY` in the environment overrides it. |
| `~/.jev/config.json` | User (optional) | Thresholds, pre-filter tool list, timeout, enable flag — see `DEFAULT_CONFIG` in `packages/guard/src/config.ts`. |
| `~/.jev/tool-policy.json` | Guard Console | The allow/deny toggle state described above. |
| `~/.jev/decisions.jsonl` | `guard.js` | Append-only, redacted decision log. |
| `~/.jev/backups/` | Extension installer | Timestamped copies of host config files, written before every merge. |

The API key never reaches the log, the console, or an error message. Jev itself is sent the **unredacted** arguments, because a risk judgement on redacted text is not a judgement at all — redaction applies only to what gets written to disk afterward.

## Security & fail-closed design

These are the invariants the codebase is held to (see `CLAUDE.md` for the full list enforced during development):

- **The guard always writes valid JSON to stdout and exits 0.** A non-zero exit or malformed output could break the host agent's own loop — every internal error path, including a crash, resolves to the same fail-closed fallback verdict instead.
- **Fail closed, never open.** Missing key, timeout, network error, or malformed payload → `ask` (or `force_ask` for Antigravity, since it ignores cached "Always Allow" permissions), never a silent `allow`.
- **Shell/terminal tools are never pre-filtered**, however harmless the command looks — every one goes through the deterministic rules and, unless a rule already decided it, through Jev.
- **The installer merges, never overwrites**, and always backs up first — other tools' hooks in the same config file must survive.
- **Threat model:** this defends against a confused or manipulated agent — a bad plan, a prompt injection in a README or a web page — not against a malicious user or malware already running on the host. Anyone who can edit `~/.jev/tool-policy.json` directly can disable a check the same way the Console would.

## Testing & evaluation

```bash
npm test                       # all workspaces (300 tests, 1 skipped without JEV_LIVE=1)
npm test -w packages/core      # one workspace
npm run typecheck              # tsc --noEmit, strict, across every workspace
JEV_LIVE=1 npm test            # include the live Jev API smoke test
npm run eval                   # labelled Antigravity case set: misses, false-positive rate, latency
npm run eval:browser            # deterministic browser-benchmark regression (no live Chrome)
npm run eval:browser:live       # live local Chrome benchmark (docs/browser-benchmark-results.md)
```

Golden-fixture tests lock each adapter's behaviour byte-for-byte (payload in, expected stdout out), and `policy`/`prefilter`/`redact` are pure functions tested directly, with no I/O. The evaluation bar tracked in `docs/eval-results.md` and `docs/implementation-plan.md` is **zero dangerous calls allowed, ≤ 10% of safe calls blocked or asked, p50 under 400 ms**.

## Current status

Antigravity (`agy`) is the host adapter that ships today — this is what `--agent agy` selects, and what the extension installs a hook for. The adapter layer (`HostAdapter` in `packages/guard/src/adapters/agy.ts`) is designed so a second host is one adapter away, and Claude Code is the intended next one (see `docs/PRD.md` §7.1, `docs/host-behaviour.md`), but that adapter is not implemented yet — `packages/guard/src/main.ts` currently rejects any `--agent` other than `agy`. See `docs/completion-checklist.md` for the full phase-by-phase status.

## Built for HackNex Season 2

Jev Guard was built by **Shibam Mitra** for the HackNex Season 2 hackathon. `docs/devfolio-submission.md` has the full write-up of the problem, the build challenges, and the technology choices.
