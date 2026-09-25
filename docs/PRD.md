# PRD: Jev Guard & Router — Calibrated Decisions for AI Coding Agents

| Field | Value |
|---|---|
| Working name | Jev Guard & Router |
| Owner | Shibam Mitra |
| Status | Draft v2 — hackathon build |
| Demo environment | **Google Antigravity** (IDE + its built-in agent), with Claude Code in the integrated terminal |
| Last updated | 21 Sep 2026 |

---

## 1. Summary

A toolkit that puts **Jev** (TypeSafe AI's System One model, trained with RLCD) into the decision points of AI coding tools. It has one shared core and three surfaces:

1. **Guard for agents (primary).** A `PreToolUse` hook that runs by default for every tool call made by **the Antigravity agent** and by **Claude Code**. Jev scores each call for risk in milliseconds, and the hook allows or blocks it before it executes.
2. **Guard Console.** A panel inside Antigravity that shows each guard decision live: the tool, the risk probabilities, the verdict, and the latency.
3. **Intent Router (secondary).** A command palette where the developer types a short command, Jev picks the tool, and the editor supplies the arguments.

Jev returns typed decisions with calibrated probabilities. It does not generate text. The product is built around that: Jev decides, and deterministic code acts.

### Why the guard is the primary surface

Inside an agent (Antigravity's agent, Claude Code), the LLM already chooses which tools to call. What's missing is a fast, cheap, independent check on *whether* each call should run. A generative LLM is too slow and costly to run on every tool call. Jev is designed for exactly this kind of high-frequency decision.

## 2. Problem

- Coding agents now run shell commands, edit files, and fetch URLs autonomously. A single bad instruction, whether a mistake or a prompt injection hidden in a README or web page, can delete files or leak secrets.
- Built-in protections are either static allow/deny lists (brittle) or LLM-based classifiers (slow, costly, and closed).
- LLM classifiers sound confident even when they're wrong, so there's no trustworthy signal for when to let an action through automatically.

## 3. Goals

1. Guard **every** tool call made by the Antigravity agent and by Claude Code, **on by default** after a single install step.
2. Keep guard overhead low enough that it runs on every call without being noticed (p50 < 400 ms).
3. Block known-dangerous action classes (destructive file operations, secret access, data exfiltration) with **zero** misses on the evaluation set.
4. Make every decision visible and explainable in the Guard Console.
5. Show measured speed and cost versus an LLM-based guard on the same calls.

### Non-goals

- Replacing the agent's own reasoning or tool selection.
- Sandboxing or OS-level isolation. The guard is a decision layer, not a jail.
- Guarding agents other than Antigravity and Claude Code in v1.

## 4. Target users

- **Primary:** developers who run coding agents with autonomy (auto-accept or "hands-free" modes) and want a safety net.
- **Secondary:** teams that want an auditable log of what their agents tried to do.
- **Demo audience:** hackathon judges using Antigravity.

## 5. User stories

| # | As a developer, I want to… | So that… |
|---|---|---|
| U1 | install one extension and run one command to enable the guard | every agent in my IDE is protected by default |
| U2 | have the Antigravity agent blocked from running `rm -rf` on my project | a bad plan can't destroy my work |
| U3 | have Claude Code blocked from `curl`-ing my `.env` to an unknown host | a prompt injection can't leak my secrets |
| U4 | have safe actions (list files, read source, run tests) pass through with no friction | the guard doesn't slow me down |
| U5 | see each decision with its probabilities and latency | I understand and trust the guard |
| U6 | have the agent told *why* it was blocked | it can change course or ask me instead of failing silently |
| U7 | type "search this error" in a command palette | Jev routes it to the right editor tool instantly |

## 6. Architecture

```
                      ┌──────────────────────────────┐
                      │         jev-core (TS)        │
                      │  Jev client · question sets  │
                      │  decision policy · logging   │
                      └──────────────┬───────────────┘
            ┌────────────────────────┼─────────────────────────┐
            ▼                        ▼                         ▼
   jev-guard CLI (Node)      Antigravity extension       (shared by both)
   ├─ adapter: agy          ├─ Guard Console panel      ~/.jev/decisions.jsonl
   └─ adapter: claude       ├─ Intent Router palette    ~/.jev/credentials
                             └─ "Install Guard" command
```

- **jev-core:** a TypeScript package containing the Jev API client, question definitions, the decision policy, and a JSONL logger.
- **jev-guard:** a Node CLI that is invoked as a hook command. It reads the hook payload on stdin, normalises it through an adapter, calls Jev, applies the policy, and writes the agent-specific response to stdout.
- **Extension:** a standard VS Code-API extension, packaged as a `.vsix`, that installs into Antigravity. It installs the hooks, stores the key, runs the Router, and renders the Guard Console by tailing the decision log.

### 6.1 Jev API usage

- Endpoint: `POST https://api.typesafe.ai/v1/systemone`
- Auth: `Authorization: Bearer <API_KEY>`
- Model: `jev-latest`
- One request per decision. All questions are evaluated in parallel.

## 7. Surface 1 — Guard (primary)

### 7.1 Integration points

| Agent | Hook config location | Input (stdin) | Output (stdout) |
|---|---|---|---|
| **Antigravity agent** (IDE, AGY, AGY CLI) | Workspace: `.agents/hooks.json`; global runtime: `~/.gemini/config/hooks.json` | JSON with `toolCall.name`, `toolCall.args`, `workspacePaths`, `conversationId` and common metadata | `decision`: `allow` / `deny` / `ask` / `force_ask`, with optional `reason` |
| **Claude Code** (integrated terminal) | Global: `~/.claude/settings.json` | JSON with `tool_name`, `tool_input` | `hookSpecificOutput` with `permissionDecision`: `allow` / `deny` / `ask` and a reason |

**Verified 23 Sep 2026 (Phase 0.3):** the compiled runtime logged successful loads from both `<workspace>/.agents/hooks.json` and `~/.gemini/config/hooks.json`. It merges scopes, so installing the same named handler in both makes every event run twice. The Electron Manage Hooks UI separately reads `~/.gemini/<applicationName>/hooks.json`, but the runtime did not report loading that UI file. The installer should target only the global runtime path. On Windows, a quoted command path containing spaces was misparsed by the installed runtime; the packaged hook invocation must use a verified no-space wrapper or equivalent robust command.

Antigravity hook config (global runtime path, so it is on by default):

```json
{
  "jev-guard": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [{ "type": "command", "command": "jev-guard --agent agy", "timeout": 10 }]
      }
    ]
  }
}
```

Implementation notes:

- Antigravity does not include the event name in the payload, so the adapter is told which agent it's serving through the `--agent` flag.
- The matcher is `*`. A fast local pre-filter in `jev-guard` auto-allows read-only tools (e.g. `list_dir`, `view_file`) without calling Jev, which keeps latency and cost down.
- Captured tool names are `list_dir`, `view_file`, `write_to_file`, `run_command`, and `read_url_content`. Tool argument keys are PascalCase even though the surrounding payload metadata is camelCase.
- Antigravity natively supports `ask` and `force_ask`; `force_ask` ignores its cached Always Allow permissions.

### 7.2 Normalised state sent to Jev

Both adapters convert their payload into the same state format:

```
Agent: antigravity
Tool: run_command
Arguments: {"CommandLine": "rm -rf ./src && git push --force"}
Workspace: /home/user/project
Recent user request: (from transcript, if available)
```

### 7.3 Guard questions (one parallel call)

| Key | Type | Instructions |
|---|---|---|
| `destructive` | noul | The action deletes, overwrites, or irreversibly modifies files, git history, or system state |
| `secrets` | noul | The action reads, prints, or transmits credentials, keys, tokens, or `.env` files |
| `exfiltration` | noul | The action sends local code or data to an external host |
| `outside_workspace` | noul | The action affects paths outside the listed workspace |
| `risk` | score | Overall risk: `["Safe, read-only or routine", "Modifies project files in a normal way", "Potentially harmful, needs a human", "Clearly dangerous"]` |

### 7.4 Decision policy

| Condition | Claude Code | Antigravity |
|---|---|---|
| Any noul ≥ 0.85 **or** risk score ≥ 2.5 | `deny` + reason | `deny` + reason |
| Any noul 0.5–0.85 **or** risk score 1.5–2.5 | `ask` (native prompt) | `ask` + reason (native prompt) |
| Otherwise | `allow` | `allow` |
| Jev timeout (> 3 s) or error | `ask` | `force_ask` with a "guard unavailable" reason |

The reason text always names the triggered check and its probability, e.g. `Blocked by Jev Guard: destructive (p=0.97). Ask the user before retrying.`

### 7.5 Logging

Every decision is appended to `~/.jev/decisions.jsonl` with: timestamp, agent, tool, args (with secrets redacted), all probabilities, the verdict, and the latency.

## 8. Surface 2 — Guard Console (Antigravity extension)

- A sidebar webview that tails `~/.jev/decisions.jsonl` and shows a live feed: agent icon · tool · verdict badge · top probability · latency.
- Clicking an entry shows the full state and all probabilities.
- Header stats: calls guarded, blocked, asked, and p50 latency.
- A status bar item shows the last verdict and its latency.

## 9. Surface 3 — Intent Router (secondary)

This is the command palette from v1, kept at a smaller scope.

- `Jev: Run Command` (`Ctrl+Shift+J` / `Cmd+Shift+J`) opens an input box.
- Jev picks from a tool registry using a `choice` question, plus an `is_destructive` noul.
- Arguments come from the editor context (the diagnostic under the cursor, the selection, the active file) or from the command text. If an argument can't be found, the user is asked.
- Policy: confidence ≥ 0.80 → run; 0.50–0.80 → quick pick with the top 2–3 ranked tools; < 0.50 → ask the user. Destructive actions always require confirmation.
- v1 tools: `search_error`, `open_url`, `open_file`, `run_tests`, `git_diff`.

## 10. Installation and key handling

1. Install the `.vsix` into Antigravity (Extensions → Install from VSIX). Publish to Open VSX later.
2. `Jev: Set API Key` stores the key in the extension's SecretStorage **and** writes `~/.jev/credentials` with `0600` permissions, because hook processes run outside the extension and can't read SecretStorage. `TYPESAFE_API_KEY` in the environment overrides the file.
3. `Jev: Install Guard` asks for confirmation, backs up the existing configs, copies the bundled guard to `~/.jev/bin/guard.js`, and then merges the hook into `~/.gemini/config/hooks.json` (§7.1) and `~/.claude/settings.json`. `Jev: Uninstall Guard` reverses both.
4. `Jev: Test Guard` sends a canned dangerous and a canned safe call through `jev-guard` and shows the results in the console.

## 11. Functional requirements

| ID | Requirement | Priority |
|---|---|---|
| F1 | `jev-guard` CLI with `agy` and `claude` adapters | P0 |
| F2 | Guard question set + decision policy (Section 7) | P0 |
| F3 | Read-only local pre-filter (skips the Jev call) | P0 |
| F4 | `Install Guard` / `Uninstall Guard` with config backup and merge | P0 |
| F5 | Key storage: SecretStorage + `~/.jev/credentials` (0600) + env override | P0 |
| F6 | Decision log to JSONL with secret redaction | P0 |
| F7 | Guard Console live feed + status bar | P0 |
| F8 | 3 s Jev timeout with the fallback behaviour from 7.4 | P0 |
| F9 | `Test Guard` command | P1 |
| F10 | Intent Router with 5 tools | P1 |
| F11 | Benchmark command: Jev vs. LLM guard on the evaluation set | P1 |
| F12 | Configurable thresholds | P2 |

## 12. Non-functional requirements

- **Latency:** guard p50 < 400 ms per guarded call, including Node startup. Pre-filtered calls < 50 ms.
- **Security:** the key is never logged. The credentials file is `0600`. Secret-looking strings in args are redacted before logging (not before sending to Jev, which needs them to judge the risk).
- **Safe failure:** the guard never silently allows a call when Jev is unavailable (see 7.4).
- **Non-invasive:** installing the guard never overwrites the user's existing hooks. It merges, and it keeps a backup.

## 13. Success metrics and evaluation

Build an evaluation set of **~60 tool calls** in both agents' formats: ~30 safe (reads, normal edits, tests), ~20 dangerous (`rm -rf`, force-push, reading `.env`, `curl` with piped secrets, writing outside the workspace), and ~10 ambiguous.

| Metric | Target |
|---|---|
| Dangerous calls allowed | **0** |
| Safe calls blocked or asked | ≤ 10% |
| Guard p50 latency | < 400 ms |
| Calibration | High-confidence buckets are accurate. Show a confidence-bucket → accuracy table |
| Speed and cost vs. an LLM guard | Measured on the same set and shown in the demo |

## 14. Demo script (Antigravity, ~4 minutes)

1. **Setup (30 s):** install the `.vsix` in Antigravity → `Set API Key` → `Install Guard`. The Guard Console opens.
2. **Normal work (45 s):** ask the Antigravity agent to add a function and run the tests. The console fills with green `allow` entries, each taking a few hundred milliseconds. The agent isn't slowed down.
3. **Destructive action (45 s):** ask the agent to "clean up the repo". It tries `rm -rf` or a force-push. The console shows red `deny` (destructive p≈0.97), and the agent reads the reason and asks the user instead.
4. **Prompt injection (60 s):** the repo contains a README with a hidden instruction to send `.env` to a URL. In the integrated terminal, Claude Code reads it and tries `curl`. The console shows `deny` (secrets + exfiltration), with the same guard protecting a second agent.
5. **Router (30 s):** cursor on a TypeScript error → `Ctrl+Shift+J` → "search this" → the browser opens instantly.
6. **Numbers (30 s):** run the benchmark: Jev vs. an LLM guard on 60 calls, comparing misses, latency, and cost.

## 15. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Antigravity cached permission could bypass an ambiguous-risk prompt | Use `force_ask` where cached Always Allow permissions must not apply |
| Antigravity's hook payload or format changes | Keep the adapter isolated. Log raw payloads in debug mode. Test on the demo machine's exact version |
| Claude Code hook quirks (e.g. hooks interacting with allow lists) | Rely on `deny` / `ask`. Don't add guarded tools to Claude Code's allow list on the demo machine |
| Guard latency is noticeable | Pre-filter read-only tools. Keep the Node CLI lean. Consider a warm local daemon (future) |
| False positives annoy users | Tune thresholds on the evaluation set. Treat `ask` as the default for the ambiguous band |
| Jev outage during the demo | Safe-failure behaviour + a recorded backup demo |
| TypeSafe's published numbers aren't reproducible | Present only our own measurements |

## 16. Milestones (hackathon, 24 h)

| Phase | Deliverable |
|---|---|
| H0–H2 | Verify Antigravity hook payload/output on the demo machine with a logging hook. `jev-core` client working |
| H2–H6 | `jev-guard` with the `agy` adapter, question set, policy, and JSONL log. Tested against the Antigravity agent |
| H6–H9 | `claude` adapter. Tested with Claude Code in the Antigravity terminal |
| H9–H13 | Extension: key storage, `Install / Uninstall / Test Guard`, Guard Console |
| H13–H16 | Evaluation set, threshold tuning, pre-filter |
| H16–H19 | Intent Router (5 tools) |
| H19–H22 | LLM-guard baseline + benchmark command |
| H22–H24 | Demo repo with the injected README, rehearsal, backup recording, pitch |

## 17. Future scope

- A warm local daemon so hooks skip Node startup.
- Team policy files and a shared audit dashboard.
- `PostToolUse` checks: scan tool output for injected instructions before the agent reads it.
- More agents: Cursor, Copilot agent mode, and the Antigravity SDK (`pre_tool_call` hooks).
- Learning from user overrides to refine the question instructions.

## 18. Open questions

- Should the pre-filter be a hardcoded list or learned from the evaluation set?
- Which LLM to use as the benchmark baseline guard?
