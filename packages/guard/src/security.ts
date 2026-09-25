/**
 * Phase 5 — Workspace and daemon security helpers.
 *
 * All functions in this module are pure and side-effect-free; they can be
 * called from both the guard daemon and the extension installer.
 */
import { normalize, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Hook scope validation
// ---------------------------------------------------------------------------

/**
 * The only safe installation path for the PreToolUse hook.
 *
 * Phase 5 security requirement: the Jev Guard hook must be installed in the
 * workspace-local `.agents/hooks.json` ONLY.  A global hook
 * (`~/.gemini/config/hooks.json`) intercepts tool calls from every workspace
 * regardless of whether jev-guard was intentionally installed there.
 *
 * Note: this is a deliberate change from the Phase 0 observation (which noted
 * that the Antigravity runtime loads both the global and workspace hooks and
 * warned against duplication).  Phase 5 resolves the tension by prohibiting
 * global installation entirely: one workspace-local hook, no global copy.
 *
 * If the runtime loads both, the global copy must be removed; only the
 * workspace-local copy should remain.
 */
export const WORKSPACE_HOOK_FILENAME = '.agents/hooks.json';
export const FORBIDDEN_GLOBAL_PATHS = [
  '/.gemini/config/hooks.json',
  '\\.gemini\\config\\hooks.json', // Windows variant
  '/antigravity-ide/hooks.json',
  '\\antigravity-ide\\hooks.json',
];

/**
 * Returns true when `hookPath` is a valid workspace-scoped hook installation.
 *
 * Valid:   `<workspaceRoot>/.agents/hooks.json`
 * Invalid: `~/.gemini/config/hooks.json` (global)
 * Invalid: any path that does not end with `.agents/hooks.json` within
 *          the workspace tree
 *
 * @param hookPath      Absolute path to the hooks.json being validated.
 * @param workspaceRoot Absolute path to the workspace root.
 */
export function validateHookScope(hookPath: string, workspaceRoot: string): { valid: boolean; reason?: string } {
  const normalized = normalize(hookPath).replace(/\\/g, '/');
  const normalizedWs = normalize(workspaceRoot).replace(/\\/g, '/');

  // Must be inside the workspace
  const wsPrefix = normalizedWs.endsWith('/') ? normalizedWs : normalizedWs + '/';
  if (!normalized.startsWith(wsPrefix) && normalized !== normalizedWs) {
    return {
      valid: false,
      reason:
        `Hook path "${hookPath}" is outside the workspace root "${workspaceRoot}". ` +
        'Jev Guard must be installed in <workspace>/.agents/hooks.json only.',
    };
  }

  // Must end with .agents/hooks.json (the platform-canonical location)
  if (!normalized.endsWith('/.agents/hooks.json')) {
    return {
      valid: false,
      reason:
        `Hook path "${hookPath}" does not end with ".agents/hooks.json". ` +
        'Jev Guard must be installed in <workspace>/.agents/hooks.json only.',
    };
  }

  // Must not resolve to a global config path
  const resolvedHook = resolve(hookPath).replace(/\\/g, '/');
  for (const forbidden of FORBIDDEN_GLOBAL_PATHS) {
    if (resolvedHook.includes(forbidden.replace(/\\/g, '/'))) {
      return {
        valid: false,
        reason:
          `Hook path "${hookPath}" resolves to a global configuration path. ` +
          'Global hook installation is prohibited — install only in <workspace>/.agents/hooks.json.',
      };
    }
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// Log redaction for browser decision entries
// ---------------------------------------------------------------------------

/** Maximum characters of page text preserved in a log entry. */
const LOG_TEXT_CAP = 120;
/** Maximum characters of any single field value preserved in a log entry. */
const LOG_FIELD_CAP = 200;

/**
 * Redact / truncate a browser decision log entry before it is written.
 *
 * Guarantees:
 *   - `page.visibleText` is not present in the output (too long, too sensitive).
 *   - `argsRedacted.page.visibleText` is capped at LOG_TEXT_CAP characters.
 *   - `argsRedacted.action.label` is capped at LOG_FIELD_CAP characters.
 *   - No field value longer than LOG_FIELD_CAP is preserved verbatim.
 *   - The Typesafe API key (TYPESAFE_API_KEY) is never present — the server
 *     never receives it; this function adds an assertion as a belt-and-suspenders
 *     check.
 *
 * @param entry  Raw log record produced by the guard server before writing.
 */
export function redactBrowserLogEntry(entry: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(entry)) {
    if (key === 'argsRedacted' && value && typeof value === 'object' && !Array.isArray(value)) {
      const args = value as Record<string, unknown>;
      const redactedArgs: Record<string, unknown> = {};

      for (const [argKey, argValue] of Object.entries(args)) {
        if (argKey === 'page' && argValue && typeof argValue === 'object' && !Array.isArray(argValue)) {
          const page = argValue as Record<string, unknown>;
          // Strip visibleText entirely — can be thousands of characters of untrusted content
          const { visibleText: _dropped, ...safePageFields } = page;
          redactedArgs['page'] = capStrings(safePageFields, LOG_FIELD_CAP);
        } else if (argKey === 'action' && argValue && typeof argValue === 'object' && !Array.isArray(argValue)) {
          const action = argValue as Record<string, unknown>;
          redactedArgs['action'] = capStrings(action, LOG_FIELD_CAP);
        } else {
          redactedArgs[argKey] = typeof argValue === 'string' && argValue.length > LOG_TEXT_CAP
            ? argValue.slice(0, LOG_TEXT_CAP) + '…'
            : argValue;
        }
      }
      out[key] = redactedArgs;
    } else if (typeof value === 'string' && value.length > LOG_FIELD_CAP) {
      out[key] = value.slice(0, LOG_FIELD_CAP) + '…';
    } else {
      out[key] = value;
    }
  }

  // Belt-and-suspenders: the API key must never appear in a log entry.
  // The server never receives the key, but assert defensively.
  const serialized = JSON.stringify(out);
  const activeKey = process.env.TYPESAFE_API_KEY?.trim();
  if (
    serialized.includes('TYPESAFE_API_KEY') ||
    Boolean(activeKey && activeKey.length > 0 && serialized.includes(activeKey))
  ) {
    const { argsRedacted: _dropped, ...safe } = out;
    return { ...safe, argsRedactedDropped: true };
  }

  return out;
}

function capStrings(obj: Record<string, unknown>, cap: number): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    result[k] = typeof v === 'string' && v.length > cap ? v.slice(0, cap) + '…' : v;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Workspace change detection
// ---------------------------------------------------------------------------

/**
 * Returns true when the resolved canonical path of `candidate` matches
 * `registered`, using case-insensitive comparison on Windows.
 *
 * Used by the guard server to validate that each incoming request's workspace
 * field still matches the workspace the daemon was started for.
 */
export function isSameWorkspace(candidate: string, registered: string): boolean {
  const a = normalize(candidate);
  const b = normalize(registered);
  // Windows paths are case-insensitive
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
