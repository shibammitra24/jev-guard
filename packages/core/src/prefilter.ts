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

export function prefilter(call: NormalizedToolCall, readonlyTools: readonly string[] = READ_ONLY_TOOLS): PrefilterResult {
  if (!readonlyTools.includes(call.tool)) return 'check';
  return hasSuspiciousValue(call.args) ? 'check' : 'allow';
}
