import type { NormalizedToolCall } from './types';

export type PrefilterResult = 'allow' | 'check';

export const READ_ONLY_TOOLS = [
  'list_dir',
  'view_file',
  'read_file',
  'Read',
  'Glob',
  'Grep',
  'codebase_search',
  'view_code_item',
  'read_url_content',
] as const;

const SUSPICIOUS = /\.env|credential|secret|api[_-]?key|token|password|id_rsa|\.pem|\.ssh/i;

/**
 * Matches URLs that could be used for Server-Side Request Forgery (SSRF):
 * - file:// protocol (local file read via URL)
 * - Cloud metadata endpoints: AWS/Azure 169.254.169.254, GCP metadata.google.internal
 * - Loopback addresses (localhost, 127.x.x.x, ::1)
 * - RFC-1918 private ranges (10.x, 172.16-31.x, 192.168.x)
 */
// eslint-disable-next-line no-useless-escape
const SSRF_URL = /^file:|(?:https?:\/\/)(169\.254\.|127\.|10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.|\[?::1\]?|localhost[:/])/i;

/**
 * Matches paths that could be used to tamper with the guard itself:
 * - .agents/hooks.json (PreToolUse hook — replacing this disables the guard)
 * - The compiled guard bundle (guard.js / jev-guard)
 */
const GUARD_TAMPERING = /\.agents[/\\]hooks\.json|jev-guard|\bguard\.js\b/i;

/**
 * Matches destructive shell patterns that are wildcards or recursive,
 * meaning they could wipe large sections of the filesystem.
 * Examples: rm -rf, rm -fr, del /s /q, Remove-Item -Recurse, git clean -fd
 */
const WILDCARD_DESTRUCT = /rm\s+-[a-z]*[rf][a-z]*|del\s+(\/[sq]\s+)+|Remove-Item\s+.*-Recurse|git\s+clean\s+-[a-z]*f/i;

// A command that starts with a delete verb is a candidate for targeted deletion.
// isTargetedDelete() additionally requires !WILDCARD_DESTRUCT and no wildcards.
const TARGETED_DESTRUCT = /^(rm|del|Remove-Item|unlink|shred)\s+[^\n]+$/im;

function hasSuspiciousValue(value: unknown): boolean {
  if (typeof value === 'string') return SUSPICIOUS.test(value);
  if (Array.isArray(value)) return value.some(hasSuspiciousValue);
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).some(
      ([key, item]) => SUSPICIOUS.test(key) || hasSuspiciousValue(item),
    );
  }
  return false;
}

function hasDangerousUrl(value: unknown): boolean {
  if (typeof value === 'string') return SSRF_URL.test(value);
  if (Array.isArray(value)) return value.some(hasDangerousUrl);
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(hasDangerousUrl);
  }
  return false;
}

function hasGuardTamperingPath(value: unknown): boolean {
  if (typeof value === 'string') return GUARD_TAMPERING.test(value);
  if (Array.isArray(value)) return value.some(hasGuardTamperingPath);
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(hasGuardTamperingPath);
  }
  return false;
}

/**
 * Returns true if the tool call looks like a wildcard or recursive
 * destructive command (rm -rf, del /s /q, Remove-Item -Recurse, etc.).
 * Used by policy.ts to prevent the ask-downgrade for wildcard deletes.
 */
export function isWildcardDelete(call: NormalizedToolCall): boolean {
  const line = typeof call.args.CommandLine === 'string' ? call.args.CommandLine : '';
  return WILDCARD_DESTRUCT.test(line);
}

/**
 * Returns true if the tool call looks like a targeted (single-file)
 * destructive command that a user likely requested explicitly.
 * Used by policy.ts to downgrade deny → ask for these cases.
 *
 * Returns false if:
 * - No CommandLine arg (not a shell command)
 * - Command matches wildcard/recursive patterns (rm -rf, del /s, etc.)
 * - Command contains shell wildcard characters (* ?)
 */
export function isTargetedDelete(call: NormalizedToolCall): boolean {
  const line = typeof call.args.CommandLine === 'string' ? call.args.CommandLine : '';
  if (!line) return false;
  if (WILDCARD_DESTRUCT.test(line)) return false;
  if (/[*?]/.test(line)) return false;
  return TARGETED_DESTRUCT.test(line);
}

export function prefilter(call: NormalizedToolCall, readonlyTools: readonly string[] = READ_ONLY_TOOLS): PrefilterResult {
  // Guard-tampering writes always go to Jev regardless of tool type
  if (hasGuardTamperingPath(call.args)) return 'check';

  if (!readonlyTools.includes(call.tool)) return 'check';

  // SSRF / local-file URLs — bypass the allow-list for read_url_content
  if (hasDangerousUrl(call.args)) return 'check';

  return hasSuspiciousValue(call.args) ? 'check' : 'allow';
}
