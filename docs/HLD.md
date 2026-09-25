# HLD: Jev Guard & Router

| Field | Value |
|---|---|
| Document | High-Level Design |
| Project | Jev Guard & Router |
| Owner | Piyush Paul |
| Companion docs | `PRD.md`, `LLD.md` |
| Last updated | 21 Sep 2026 |

---

## 1. Scope

This document describes the system structure: components, their responsibilities, how they talk to each other, and the cross-cutting decisions (security, failure handling, performance). Class-level and function-level detail lives in `LLD.md`.

## 2. Design drivers

| Driver | Consequence for the design |
|---|---|
| Jev returns typed decisions, not text | All action logic is deterministic and lives in our code. Jev only answers questions |
| The guard runs on **every** tool call | Latency and cost per call dominate the design. Hence a local pre-filter and a single batched request |
| Two different agents, two hook contracts | An adapter layer normalises input and output. The core knows nothing about either agent |
| Hook processes are separate from the IDE process | Shared state lives on the filesystem (`~/.jev/`), not in extension memory |
| A wrong "allow" is far worse than a wrong "deny" | Asymmetric policy and fail-closed behaviour |
| Hackathon timeline | One language (TypeScript/Node) across all components. No server, no database |

## 3. System context

```
        ┌───────────────────────────────────────────────┐
        │              Antigravity IDE                  │
        │                                               │
        │  ┌──────────────┐        ┌─────────────────┐  │
        │  │ AGY agent    │        │ Integrated term.│  │
        │  │ (Gemini)     │        │  └ Claude Code  │  │
        │  └──────┬───────┘        └────────┬────────┘  │
        │         │ PreToolUse              │ PreToolUse│
        │         ▼                         ▼           │
        │       ┌─────────────────────────────┐         │
        │       │      jev-guard (CLI)        │─────────┼──► Jev API
        │       └──────────────┬──────────────┘         │   (TypeSafe)
        │                      │ append                 │
        │                      ▼                        │
        │            ~/.jev/decisions.jsonl             │
        │                      │ tail                   │
        │       ┌──────────────┴──────────────┐         │
        │       │  Extension: Guard Console   │         │
        │       │  + Intent Router + Installer│─────────┼──► Jev API
        │       └─────────────────────────────┘         │
        └───────────────────────────────────────────────┘
```

External dependencies: the Jev API (`api.typesafe.ai`) and the host IDE. Nothing else. No backend of ours.

## 4. Components

### C1 — `jev-core` (library)

The only component that knows how to talk to Jev and how to turn probabilities into verdicts.

**Responsibilities**
- Build and send Jev requests; parse answers.
- Own the two question sets: `guard` and `router`.
- Apply the decision policy (thresholds → verdict).
- Load credentials; load user config.
- Append decision records to the log.

**Explicitly not responsible for:** agent payload formats, VS Code APIs, executing anything.

### C2 — `jev-guard` (CLI binary)

A short-lived process, started by the host agent once per tool call.

**Responsibilities**
- Read the hook payload from stdin; select an adapter from `--agent`.
- Run the local pre-filter (cheap, no network).
- Call `jev-core` for a guard verdict.
- Render the verdict in the host agent's response format; exit 0.
- Never crash open: any internal error produces a safe verdict, not a stack trace.

### C3 — Adapters (inside `jev-guard`)

One per host agent. Each implements the same interface in both directions.

| Adapter | Parses | Emits |
|---|---|---|
| `agy` | `toolCall.name`, `toolCall.args`, `workspacePaths` | `{"decision": "allow" \| "deny" \| "ask" \| "force_ask", "reason"?}` |
| `claude` | `tool_name`, `tool_input`, `cwd` | `hookSpecificOutput` with `permissionDecision`: `allow` / `deny` / `ask` |

Adding a third agent means adding one adapter, nothing else.

### C4 — Extension (Antigravity / VS Code API)

**Responsibilities**
- **Installer:** merge the guard hook into both agents' config files; back up first; support uninstall.
- **Credentials:** `Set API Key` → SecretStorage plus `~/.jev/credentials` (0600).
- **Guard Console:** webview that tails the decision log and renders a live feed.
- **Intent Router:** input box → `jev-core` router decision → tool execution in the editor.

### C5 — Local state (`~/.jev/`)

| File | Purpose | Written by | Read by |
|---|---|---|---|
| `credentials` | API key (0600) | Extension | `jev-guard`, Extension |
| `config.json` | Thresholds, pre-filter list, enable flag | Extension | Both |
| `decisions.jsonl` | Append-only decision log | `jev-guard`, Extension | Guard Console |
| `backups/` | Pre-install copies of host config files | Extension | Extension (uninstall) |

The filesystem is the integration bus between the hook processes and the IDE process. It needs no ports, no daemon, and it survives the IDE being closed.

## 5. Key flows

### 5.1 Guard flow (the hot path)

```
Agent about to call a tool
   │
   ▼
jev-guard starts, reads stdin ─── malformed? ──► safe verdict, exit 0
   │
   ▼
Adapter → normalised ToolCall { agent, tool, args, workspace }
   │
   ▼
Pre-filter: read-only tool & no suspicious args? ──yes──► allow (no network, <50 ms)
   │ no
   ▼
jev-core: one Jev request, 5 questions, 3 s timeout ── timeout/error ──► fail-closed verdict
   │
   ▼
Policy: probabilities → allow | ask | deny (+ reason)
   │
   ├──► append to decisions.jsonl
   └──► adapter renders host-specific JSON → stdout → agent obeys
```

### 5.2 Router flow

```
Ctrl+Shift+J → input box → context collector (active file, diagnostic, selection)
   → jev-core router request (choice + noul)
   → policy: high confidence → run | medium → quick pick | low → ask
   → argument resolver for the chosen tool
   → executor (browser, terminal, editor command) → status bar result
```

### 5.3 Install flow

```
Jev: Install Guard
   → detect which agents are present (config paths exist)
   → confirm with the user (list the files to be changed)
   → copy each file to ~/.jev/backups/<timestamp>/
   → deep-merge our hook entry into each config (never replace)
   → write back atomically
   → run Test Guard: one safe + one dangerous canned call
   → report the result in the Guard Console
```

## 6. Design decisions and alternatives rejected

| # | Decision | Why | Rejected alternative |
|---|---|---|---|
| D1 | Guard is the primary surface; router is secondary | The host agents already select tools; they don't have a fast independent safety check | A router inside agents, which duplicates the LLM's job |
| D2 | Hook-based integration, not an MCP server | MCP tools are only called if the model chooses to. Hooks are unavoidable and therefore "on by default" | MCP server |
| D3 | Short-lived CLI per call | Simple, stateless, and matches the hook contract exactly | A long-running daemon (kept as future work for latency) |
| D4 | JSONL file as the IDE ↔ hook bus | No ports, no lifecycle coupling, trivially debuggable, works when the IDE is closed | Local HTTP server in the extension |
| D5 | One batched Jev request with 5 questions | Jev evaluates questions in parallel, so extra questions cost little time | Separate calls per risk dimension |
| D6 | Local pre-filter before the network call | Most agent tool calls are reads; guarding them is wasted latency and spend | Sending everything to Jev |
| D7 | Fail closed on error/timeout | A guard that fails open is worse than no guard, because it creates false confidence | Fail open |
| D8 | Key in a 0600 file, not only SecretStorage | Hook processes are outside the extension and cannot read SecretStorage | Env var only (fragile for GUI-launched IDEs) |
| D9 | Merge into existing config files, with backups | Users already have hooks; clobbering them would be unacceptable | Overwrite |

## 7. Cross-cutting concerns

### 7.1 Performance budget (per guarded call)

| Segment | Budget |
|---|---|
| Node process start + parse | ≤ 80 ms |
| Pre-filter | ≤ 5 ms |
| Jev round trip | ≤ 250 ms (p50) |
| Policy + log append | ≤ 15 ms |
| **Total p50** | **< 400 ms** |

Pre-filtered calls skip the network entirely (< 50 ms). If the budget is missed, the mitigation order is: widen the pre-filter, then trim the state text, then move to a warm daemon.

### 7.2 Security

- The key is read from `TYPESAFE_API_KEY`, else `~/.jev/credentials` (mode checked; refuse if world-readable).
- The key never appears in the log, the console, or any error message.
- Arguments are sent to Jev **unredacted** (the risk judgement needs them) but are **redacted before logging** with pattern matching for keys, tokens, and long base64-like strings.
- The installer only ever writes to the two known config paths and `~/.jev/`.
- Threat model note: the guard defends against a *confused or manipulated agent*, not against a malicious user or malware on the host. Anyone who can edit `~/.jev/config.json` can disable it.

### 7.3 Failure handling

| Failure | Behaviour |
|---|---|
| No API key | Fail-closed verdict (`ask` / deny-with-reason) + a one-time notification in the IDE |
| Jev timeout (3 s) or 5xx | Fail-closed verdict, logged with `fallback: true` |
| Rate limited (429) | One retry with jitter, then fail-closed |
| Malformed hook payload | Fail-closed verdict; raw payload written to the debug log |
| Log file unwritable | Verdict still returned; logging errors are swallowed |
| Guard disabled in config | Immediate allow, logged as `skipped` |

The guiding rule: **the guard must always print valid JSON and exit 0**, or it risks breaking the user's agent loop.

### 7.4 Observability

Every decision record carries: timestamp, agent, tool, redacted args, all probabilities, verdict, reason, latency in ms, and whether it was pre-filtered or a fallback. That single file powers the Guard Console, the benchmark command, and the calibration table in the demo.

### 7.5 Configuration precedence

Env var → `~/.jev/config.json` → built-in defaults. Workspace-level config is out of scope for v1.

## 8. Deployment

- `jev-core` and `jev-guard` are bundled into the extension package. `Install Guard` copies the guard bundle to `~/.jev/bin/guard.js` and installs `node ~/.jev/bin/guard.js --agent agy`, avoiding Antigravity's broken handling of quoted Windows paths containing spaces. There is no global npm install or PATH dependency.
- The extension ships as a `.vsix`, installed manually in Antigravity for the demo, and published to Open VSX afterwards.
- Node is assumed present (the host IDE ships it). The `LLD` pins a minimum version check at install time.

## 9. Test strategy

| Level | What |
|---|---|
| Unit | Policy thresholds, pre-filter, redaction, config merge (with weird existing configs) |
| Contract | Golden payload files captured from both real agents → expected adapter output |
| Integration | `jev-guard` run end to end against the live Jev API with a fake payload |
| Evaluation | ~60 labelled tool calls → misses, false-positive rate, calibration, latency |
| Manual | The full demo script in Antigravity, on the demo machine |

## 10. Risks carried into the LLD

1. The real Antigravity payload and accepted output values must be confirmed by a logging hook before anything else is built (milestone H0).
2. Antigravity supports native `ask` and `force_ask` decisions; use `force_ask` when cached Always Allow permissions must not bypass a prompt.
3. Node cold start could eat the latency budget; the daemon path is pre-designed as the escape hatch.
