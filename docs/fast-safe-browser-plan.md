# Fast + Safe Browser Agent — Integration Plan

## Product USP

**Jev Fast Guard:** a workspace-scoped browser agent that uses structured DOM state instead of screenshots for every decision, while Jev Guard evaluates each meaningful browser action before it executes.

The product promise is:

> Faster browser automation with an explicit safety boundary: fewer screenshots and browser round trips, with every navigation, form submission, download, and data-transmission action guarded by Jev.

The two repositories remain technically separate but ship as one extension/product:

```text
Antigravity / VS Code extension
        │
        ├── Guard Console + workspace installer
        ├── TypeScript guard daemon (workspace scoped)
        │       └── Jev risk decisions
        └── Python browser sidecar
                ├── persistent CDP session
                ├── structured DOM snapshots
                ├── one operation + target decision
                └── guarded browser execution
```

## Recommended integration strategy

The implementation uses a small TypeScript port of the ultrafast repository's snapshot/action-space ideas. This avoids shipping a Python runtime, lets esbuild include the browser engine in the VSIX, and keeps the Jev API key inside the existing TypeScript guard process. The upstream repository remains the design reference; its complete demo harness is not copied.

The extension starts the sidecar only for the selected workspace. The sidecar talks to a loopback-only JSON-RPC endpoint. The sidecar never receives the Jev API key; the TypeScript guard daemon owns credentials and Jev calls.

This gives the project a fast path quickly while preserving the existing TypeScript safety implementation.

## Shared action contract

Create one versioned contract used by both projects:

```ts
interface BrowserAction {
  id: string;                 // code-owned observed node, e.g. e17
  kind: 'click' | 'fill' | 'select' | 'scroll' | 'wait' | 'navigate';
  label: string;
  value?: string;
  url?: string;
  pageFingerprint: string;
  workspace: string;
}

interface GuardedBrowserRequest {
  workspace: string;
  page: { url: string; title: string; visibleText: string };
  action: BrowserAction;
  provenance: 'browser-sidecar';
}

interface GuardedBrowserResponse {
  decision: 'allow' | 'ask' | 'deny';
  reason?: string;
  latencyMs: number;
}
```

The browser model may select only an observed action ID. It must not emit selectors, coordinates, JavaScript, shell commands, or arbitrary URLs.

## Low-latency execution path

### Observation

1. Keep one persistent CDP/browser session.
2. Run one atomic DOM snapshot using the ultrafast `snapshot.js` approach.
3. Enumerate visible controls, roles, labels, values, options, and nearby visible text.
4. Cache DOM node identity and compute a page fingerprint.
5. Do not capture a screenshot unless the user opens the inspector or enables recording.

### Decision

1. Build one dynamic question containing the operation choice and compatible target heads.
2. Send one Jev request instead of operation-then-target requests.
3. Keep a bounded action vocabulary: `CLICK`, `TYPE_TEXT`, `SELECT`, `SCROLL`, `WAIT`, `DONE`, `BLOCKED`.
4. Reuse a text-helper result only when its full field context is unchanged.

### Execution

1. Recheck the page fingerprint immediately before execution.
2. Resolve the action ID to the cached real DOM node.
3. Check visibility, enabled state, hit testing, and current value.
4. Send the action to the TypeScript guard daemon.
5. Execute only after `allow` or an explicit user confirmation for `ask`.
6. Observe again after execution.
7. Use targeted waits only: two animation frames / approximately 50 ms normally, up to 200 ms for autocomplete suggestions.

## Guard policy for browser actions

The browser sidecar must not bypass Jev Guard.

Fast prefilter candidates:

- DOM observation.
- Reading visible page text.
- Inspecting current form values.
- Ordinary same-page clicks that do not submit, download, navigate, or mutate data.

Always check with Jev:

- External navigation.
- Form submission.
- Login or account changes.
- Downloads/uploads.
- Clipboard writes.
- Payment, booking, deletion, or publication.
- Any action whose visible context includes secrets, tokens, `.env`, credentials, or exfiltration language.

The existing workspace-only scope rule remains mandatory. Installing the browser guard must write only to:

```text
<selected-workspace>/.agents/hooks.json
```

No global Antigravity hook is allowed.

## Guard daemon

The current CLI spawns a Node process for each Antigravity hook. For the browser sidecar, add a warm loopback daemon:

```text
jev-guard serve --workspace <absolute-path> --port <ephemeral-port>
```

Requirements:

- Bind to `127.0.0.1` only.
- Generate a per-workspace random session token.
- Reject requests for another workspace.
- Keep the Jev client warm.
- Preserve the existing 4-second watchdog and fail-closed behavior.
- Log every browser decision with `agent: browser`, action ID, URL origin, decision, reason, and latency.
- Shut down when the extension deactivates or the workspace changes.

The Antigravity hook CLI remains available for normal tool calls; the daemon is an optimization for repeated browser actions.

## Extension UX

Add these workspace-scoped commands:

- No manual start command: the sidecar activates with the workspace, and Chrome/Edge launches when Antigravity calls `browser_subagent` (or from the Guard Console prompt box). The URL comes from the task text.
- `Jev: Stop Fast Browser`.
- `Jev: Open Fast Browser Console`.
- `Jev: Clear Logs`.
- `Jev: Install Workspace Guard`.

The Guard Console should distinguish:

- `agent: agy` — Antigravity tool hooks.
- `agent: browser` — fast browser sidecar actions.

Show a performance panel:

- average decision latency;
- p50/p95 decision latency;
- browser protocol calls per task;
- screenshot count;
- Jev requests per task;
- blocked/allowed/asked counts;
- estimated time saved against screenshot-per-step mode.

## Milestones

Current status:

- [x] Shared versioned browser-action contract.
- [x] Workspace-authenticated loopback guard daemon.
- [x] Dynamic operation/target question builder.
- [x] Atomic screenshot-free DOM snapshot script.
- [x] Stale fingerprint checks and guard-daemon client.
- [x] Persistent live CDP session and browser execution.
- [x] Extension start/stop integration and browser performance UI.
- [x] Goal-driven operation/target loop exposed through the extension.
- [x] Deterministic matched browser protocol benchmark.
- [x] Live-browser wall-time benchmark with a scoped browser-loop performance claim.

### B1 — Extract and freeze contracts

- Copy the ultrafast repository at a pinned commit with MIT attribution.
- Add `docs/fast-safe-browser-plan.md` and the shared action schema.
- Add fixtures for snapshot, operation/target decisions, stale fingerprints, and guard requests.

### B2 — Sidecar without guard

- Launch one persistent CDP session.
- Port `snapshot.js` and indexed action generation.
- Implement one Jev request for operation plus target.
- Execute click/fill/select/scroll/wait.
- Disable screenshots by default.
- Add independent completion verification.

### B3 — Guard daemon

- Add loopback JSON-RPC server to `packages/guard`.
- Add workspace token and workspace-path validation.
- Normalize `GuardedBrowserRequest` into existing `NormalizedToolCall`/`GuardSignals`.
- Add browser decision logging and watchdog tests.

### B4 — Guarded sidecar

- Route every non-read-only action through the daemon.
- Add confirmation handling for `ask`.
- Reject stale page fingerprints.
- Verify that a blocked delete/submission/download never reaches CDP.

### B5 — Extension integration

- Start/stop sidecar from the extension.
- Install only the selected workspace hook.
- Add browser console rows and performance counters.
- Add a workspace switch/restart test.

### B6 — USP benchmark

Compare two modes on the same disposable websites and tasks:

| Metric | Screenshot loop | Fast Guard Browser |
|---|---:|---:|
| task wall time | measured | measured |
| Jev requests | measured | measured |
| browser protocol calls | measured | measured |
| screenshots | measured | measured |
| blocked dangerous actions | measured | measured |
| false-positive asks | measured | measured |
| p50/p95 guard latency | measured | measured |

Do not claim a percentage until at least five matched runs per task. Present the ultrafast repository’s published numbers as upstream evidence, not as Jev Guard measurements.

## Demo script

1. Select a disposable workspace and install the workspace guard.
2. Give a browser task with a URL in Antigravity's chat (the browser starts automatically).
3. Open a documentation page and show a structured action table without screenshots on every step.
4. Execute a normal search; show low Jev request count and p50 latency.
5. Trigger an external navigation or form submission; show the browser action paused by Jev.
6. Ask the agent to upload a local `.env` or delete a file; show a red browser decision and prove no CDP action executed.
7. Switch to a different workspace and show that no guard or logs are active there.
8. Show the comparison panel: screenshots, protocol calls, Jev requests, latency, and blocked actions.

## Acceptance criteria

- Browser observation normally makes zero screenshot calls.
- Operation and target selection uses one Jev request per decision cycle.
- A stale page decision is discarded before action execution.
- A denied browser action produces zero corresponding CDP mutation calls.
- The guard is active only in the selected workspace.
- A second workspace remains unaffected.
- The console distinguishes Antigravity and browser decisions.
- A matched benchmark demonstrates lower browser-call volume without increasing dangerous-action allowance.

## Reuse and attribution

`jev-ultrafast-main` is MIT licensed. If code is copied rather than reimplemented, retain its LICENSE and copyright notice, pin the upstream commit, and record the copied files in a NOTICE file. Prefer a small adapter or port of the snapshot/action-space ideas over copying the complete Python demo application.
