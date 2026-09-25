# Host behaviour notes

Observed behaviour of the two host agents, captured during Phase 0. Companion to the fixtures in
`packages/guard/test/fixtures/`. Update this file in the same change as any adapter fix needed
because a real host does not match an assumption.

## Antigravity (`agy`)

### Hook discovery and config locations — verified 23 Sep 2026

The compiled agent runtime loads and merges hooks from both of these locations:

- Workspace: `<workspace>/.agents/hooks.json`.
- Global: `~/.gemini/config/hooks.json`.

The runtime confirmed both paths in `%APPDATA%/Antigravity IDE/logs/<session>/ls-main.log`:

```text
Loaded hooks.json from d:\Projects\...\jev-guard\.agents\hooks.json: 1 named hooks, 1 total handlers
Loaded hooks.json from C:\Users\...\.gemini\config\hooks.json: 1 named hooks, 1 total handlers
```

If the same handler is installed in both scopes, it runs twice for every matching event. The
Phase 0 logger produced two byte-identical captures per tool call for exactly this reason. The
installer must therefore install one global handler and must not also add a workspace copy.

The Electron "Manage Hooks" UI separately reads
`~/.gemini/<applicationName>/hooks.json` (`~/.gemini/antigravity-ide/hooks.json` in this
installation). The agent runtime did not report loading that file. A handler appearing in the
settings panel is therefore not evidence that the runtime installed it.

### Command execution on Windows — verified 23 Sep 2026

The runtime invokes command hooks, but a quoted script path containing spaces was split
incorrectly. This command:

```text
node "D:\workspace with spaces\jev-guard\scripts\log-hook.js"
```

caused Node to attempt to load:

```text
C:\Users\...\.gemini\config\"D:\workspace
```

For the Phase 0 probe, the script was copied to the no-space path
`C:\Users\...\.jev\log-hook.js` and invoked without quotes. That command captured all live
payloads and returned `{"decision":"allow"}`. The production installer must avoid relying on
this broken quoting path—for example, by using a bundled path without spaces or a wrapper path
whose invocation is verified on Windows.

### hooks.json schema — verified from bundled implementation and documentation

```json
{
  "<handlerName>": {
    "enabled": true,
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "...", "timeout": 10 }
        ]
      }
    ]
  }
}
```

`enabled` is optional and defaults to true. Other supported event keys are `PostToolUse`,
`PreInvocation`, `PostInvocation`, and `Stop`. The matcher accepts regular expressions; `*` and
an empty string are special all-tool values. Only command hooks are currently supported.

Commands run via `sh -c` on Unix and `cmd /c` on Windows. The working directory is the directory
containing `hooks.json`, `~` is expanded, and the default timeout is 30 seconds. Hooks run
synchronously and block the agent loop.

### PreToolUse contract — fixture-verified 23 Sep 2026

All five captures contain these common camelCase fields:

- `artifactDirectoryPath`
- `conversationId`
- `modelName`
- `stepIdx`
- `toolCall: { name, args }`
- `transcriptPath`
- `workspacePaths`

Exact observed tool names and argument keys:

| Action | Tool name | Argument keys |
|---|---|---|
| List directory | `list_dir` | `DirectoryPath` |
| Read file | `view_file` | `AbsolutePath` |
| Write file | `write_to_file` | `CodeContent`, `Description`, `Overwrite`, `TargetFile` |
| Run shell command | `run_command` | `CommandLine`, `Cwd`, `WaitMsBeforeAsync` |
| Fetch URL | `read_url_content` | `Url` |

Sanitized golden payloads are stored in `packages/guard/test/fixtures/agy-*.json`. The captures
confirm that metadata keys are camelCase while tool-argument keys are PascalCase.

Documented `PreToolUse` decisions are `allow`, `deny`, `ask`, and `force_ask`. `ask` respects
the host's Always Allow cache; `force_ask` ignores cached permissions. Output can also contain
`reason`, temporary `permissionOverrides`, and `overwrite`. `overwrite` is a shallow top-level
merge into the tool-call arguments.

## Claude Code

Not yet investigated — Phase 0.4.

---

## Browser tool — Antigravity (`agy`)

### Tool name — verified from live agent system prompt, Sep 2026

Antigravity exposes exactly one browser tool to the model:

```
browser_subagent
```

There is no separate `navigate`, `click`, or `type` tool. The model composes
all browser intent into a natural-language `Task` string that is sent to a
browser sub-agent. All seven action kinds (navigate, click, type, select,
scroll, wait, submit) arrive through this single tool name.

### Argument schema — verified from live system prompt

PascalCase keys, consistent with all other Antigravity tools:

| Key | Type | Required | Description |
|---|---|---|---|
| `Task` | string | yes | Full natural-language task description for the sub-agent |
| `TaskName` | string | yes | Human-readable title (used as step identifier in logs) |
| `TaskSummary` | string | yes | 1–2 sentence summary shown in the UI |
| `RecordingName` | string | yes | Lowercase-underscore label for the WebP session recording |
| `ReusedSubagentId` | string | no | ID of a previous sub-agent to resume from |
| `MediaPaths` | string[] | no | Absolute paths to images/videos passed as context (max 3) |
| `toolAction` | string | yes | 2–5 word action summary shown in the UI |
| `toolSummary` | string | yes | 2–5 word noun phrase shown in the UI |

Sanitised golden payloads for each action kind are in
`packages/guard/test/fixtures/agy-browser-*.json`.

### How tool results are returned to the agent — observed behaviour

The sub-agent's final report text is returned as the tool result string. The
agent host resumes the outer agent loop with that string as the tool-call
response. No structured schema is imposed on the result; it is free-form text
produced by the sub-agent.

Browser sessions are recorded as WebP videos written to the artifact directory.
The recording path is derived from `RecordingName` and is included in the
sub-agent's context but is not part of the structured tool result.

### PreToolUse hook behaviour for `browser_subagent`

The `browser_subagent` tool call passes through the same PreToolUse hook
pipeline as every other Antigravity tool. The hook receives the standard
payload shape (see the Antigravity section above) with:

- `toolCall.name` = `"browser_subagent"`
- `toolCall.args` = the PascalCase argument object above

A hook may return any documented decision:

| Decision | Effect |
|---|---|
| `allow` | Sub-agent launches normally |
| `deny` | Sub-agent is not launched; the agent receives the `reason` string as an error |
| `ask` | Host displays a confirmation dialog; respects the Always Allow cache |
| `force_ask` | Host displays a confirmation dialog; ignores the Always Allow cache |

`overwrite` performs a shallow top-level merge into `toolCall.args`. This
means individual argument keys (e.g. `Task`, `RecordingName`) can be
rewritten by the hook before the sub-agent sees them. It **cannot** surgically
rewrite a substring of `Task` without replacing the entire string.

### Can the hook substitute a complete tool result? — verified limitation

**No.** A PreToolUse hook cannot inject a synthetic tool-result value that the
agent receives as if the sub-agent had run. The hook can only allow, deny, or
ask. If the hook denies, the agent sees an error; it does not see a
plausible browser result.

This means a transparent adapter — one that intercepts the `browser_subagent`
call, runs its own CDP session, and returns a normal-looking result — is **not
achievable** through the PreToolUse hook alone.

### Adapter integration decision — Phase 0 gate

**Decision: deny-and-retry bridge.**

Because transparent result substitution is not supported, the adapter must use
a bridge pattern:

```text
1. PreToolUse hook receives browser_subagent call.
2. Hook extracts the Task string and workspace path.
3. Hook sends Task + workspace to the local jev-guard sidecar via loopback.
4. Sidecar runs the fast-browser CDP loop and Jev decision.
5. Hook returns { decision: "deny", reason: "<sidecar result>" }.
6. Agent receives the sidecar result as a tool error / reason string.
```

This is a functional but imperfect bridge: the agent sees the result as a
denial reason rather than as a successful tool return. Two consequences:

- The agent may interpret the result differently from a real tool success.
- Some agent behaviours (e.g. retry logic, error recovery prompts) may be
  triggered unnecessarily.

For the hackathon demo, this limitation is acceptable. The extension console
will show the complete sidecar workflow independently of the agent's
interpretation. The limitation must be disclosed in the demo and in this
document.

A transparent integration would require a host-level API (e.g. a result-inject
hook type) that does not currently exist in Antigravity. If such an API is
added in a future release, the adapter can be upgraded without changing the
sidecar or the Jev decision logic.

This decision is the Phase 0 gate: **do not claim transparent browser
integration until the host can receive the adapter's result through a
non-error channel.**

### Automatic workspace sidecar lifecycle

The extension now removes the manual CDP and URL prompts for the real
Antigravity path. After **Jev: Install Antigravity Guard** in a workspace, the
extension activates a loopback control endpoint only for that workspace and
writes `.jev/browser-sidecar.json`. The file contains a random loopback token,
endpoint, and matching workspace path—never the Typesafe API key—and is ignored
by Git.

When `browser_subagent` arrives, the hook reads that workspace-local record,
forwards the task to `/v1/browser/task`, and the extension launches an isolated
visible Chrome profile on demand. Every selected DOM action still passes through
the Jev browser guard. The browser remains visible after the task for inspection.
The target, CDP connection, browser process, and temporary profile are closed by
**Stop**, the next task, workspace change, or extension shutdown. The control endpoint is invalidated and its
registration removed when VS Code deactivates or the extension is uninstalled.

An `ask` decision is never auto-approved in this hook path: because a PreToolUse
hook cannot present the extension confirmation UI, the sidecar stops and returns
the reason. This keeps automatic operation fail-closed.
