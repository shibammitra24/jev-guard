# Verification-Friction Mitigation Plan

## Problem

During normal project generation, Antigravity can stop on a Jev `ask` decision
for an ordinary development action such as:

- updating an existing `main.jsx` or configuration file;
- running `npm`, `npx`, or a local development script;
- replacing a generated file while completing the requested application.

The agent then asks the user to edit files manually. That breaks the intended
workflow and makes the product look like it prevents normal development.

The problem is not that Jev detects a dangerous command incorrectly in every
case. The problem is that the current policy does not distinguish sufficiently
between a reversible in-workspace edit and an irreversible/destructive action.

## Goal

Allow the agent to finish ordinary development tasks without repeated manual
verification, while preserving strong protection against:

- recursive deletion and destructive shell commands;
- overwriting secrets or credential files;
- data exfiltration;
- writes outside the selected workspace;
- destructive browser actions and form submissions.

## Proposed decision model

Use three stages instead of treating every elevated Jev signal identically.

### Stage 1 — deterministic safety classification

Before calling Jev, classify the operation and target:

| Operation | Target/context | Default handling |
|---|---|---|
| Read/list/search | selected workspace | allow/prefilter |
| Create new source file | selected workspace | allow |
| Edit existing source/config file | selected workspace, non-secret extension | allow or low-friction ask |
| `npm run`, test, build, formatter | selected workspace | allow or low-friction ask |
| `npm install` / `npx` package download | network/package execution | Jev evaluation; ask only when risk is material |
| Edit `.env`, credentials, tokens, SSH keys | any location | ask/deny |
| Write outside workspace | any tool | deny |
| `rm -rf`, recursive delete, disk/system mutation | any location | deny |
| `curl`/upload local data | external destination | deny/ask based on exfiltration |

The classifier must never allow a command merely because it contains a safe
word. It must inspect the normalized tool, parsed arguments, path, and target
workspace.

### Stage 2 — Jev contextual questions

Update the question wording and state supplied to Jev so it can distinguish:

- “modify this React source file requested by the user” from
- “overwrite a credential file or destroy project data.”

For file edits, explicitly provide:

- path relative to the workspace;
- whether the file is newly created or already exists;
- file type and secret-file classification;
- whether the operation is a bounded edit or a deletion/rename;
- whether a backup/diff is available.

For commands, explicitly distinguish a package-manager network lookup from
sending local workspace data to an external host.

### Stage 3 — deterministic policy and confirmation tiers

Use policy tiers:

1. `allow`: routine reversible in-workspace work;
2. `low-friction ask`: safe-looking but networked or ambiguous action; display
   one concise confirmation in the console/host;
3. `deny`: destructive, secret, exfiltration, or outside-workspace action.

The policy must not turn a high-confidence destructive answer into an allow.
Only low-risk, in-workspace edits can move from `ask` to `allow` through the
new contextual rules.

## Concrete implementation changes

### 1. Add an operation classifier

Create a shared classifier in `jev-core` that returns:

```ts
type OperationClass =
  | 'read'
  | 'workspace_edit'
  | 'workspace_build'
  | 'package_network'
  | 'secret_access'
  | 'exfiltration'
  | 'destructive'
  | 'outside_workspace'
  | 'unknown';
```

The classifier is advisory input to Jev and policy; it is not a replacement for
Jev’s independent decision.

### 2. Add path and secret-file policy

Normalize Windows and POSIX paths, resolve them against the selected workspace,
and reject path traversal. Treat these as sensitive by default:

```text
.env, .env.*, credentials, secrets, *.pem, *.key, id_rsa,
tokens, service-account*.json
```

Routine edits are only eligible for low-friction handling when the resolved path
is inside the workspace and is not sensitive.

### 3. Add a reversible-edit signal

For an existing file edit, include a `reversibleEdit` signal when:

- the operation is a bounded write/edit;
- the file is inside the workspace;
- it is not a secret file;
- the agent is not deleting, renaming, truncating, or changing permissions.

This prevents ordinary `main.jsx` edits from being interpreted as destructive
overwrites while retaining protection for irreversible operations.

### 4. Reduce package-manager friction safely

Recognize common package-manager commands, but do not blanket-allow them:

- allow `npm run`, `npm test`, `npm build`, and local format/typecheck commands
  when their working directory is inside the workspace;
- keep `npm install`, `npx`, arbitrary package execution, and remote scripts
  under Jev evaluation;
- ask only when Jev identifies meaningful network, script, or exfiltration risk.

### 5. Make the host confirmation actionable

When a low-friction `ask` is necessary, return a concise reason and provide a
single **Allow once** action in the extension console. Do not instruct the agent
to ask the user to manually edit source files. The agent should retry the same
tool call after approval.

### 6. Preserve the audit trail

Log:

- operation class;
- normalized target path/origin;
- Jev probabilities and risk;
- policy tier;
- whether the action was auto-allowed, confirmed, or denied.

Never log file contents, API keys, or secret values.

## Rollout sequence

### Phase A — emergency hackathon mitigation

1. Add the operation/path classifier.
2. Permit only bounded non-secret edits inside the selected workspace.
3. Permit routine local test/build commands.
4. Keep destructive, secret, exfiltration, and outside-workspace rules unchanged.
5. Add an end-to-end fixture for the exact `main.jsx` overwrite scenario.

### Phase B — confirmation UX

1. Add an extension confirmation action for low-friction asks.
2. Add “Allow once” and “Deny” records to the console.
3. Ensure the agent retries automatically after approval.
4. Add timeout and fail-closed behavior if the confirmation UI is unavailable.

### Phase C — evaluation and tuning

Measure separately:

- normal source/config edits;
- package-manager commands;
- `.env`/credential access;
- recursive deletion;
- exfiltration;
- outside-workspace writes.

The success criterion is zero destructive misses while reducing unnecessary
asks for ordinary project generation.

## Acceptance criteria

- A prompt to create a simple app can create and update `main.jsx` without
  requiring manual file editing.
- Normal in-workspace source edits produce no more than one concise confirmation
  when Jev is genuinely uncertain.
- `rm -rf`, secret reads, uploads, and outside-workspace writes remain denied or
  explicitly confirmed.
- `npm run dev`, tests, builds, and formatters do not repeatedly interrupt the
  workflow.
- Every decision remains visible in the Guard Console with a reason and
  timestamp.
- Existing workspace isolation and browser safety behavior remain unchanged.

## Judge-facing explanation

“Jev Guard is not intended to block normal coding. The current prototype is
conservative when it sees an overwrite or package-manager action. Our mitigation
adds operation and path context so reversible edits inside the selected project
flow normally, while irreversible changes, secret access, exfiltration, and
outside-workspace actions remain protected.”
