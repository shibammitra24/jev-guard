const SECRET_VALUE = /(sk-|ghp_|AKIA|-----BEGIN [A-Z ]*PRIVATE KEY)/i;
const SECRET_KEY = /^(?:password|token|secret|key|authorization|api[_-]?key)$/i;

function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let result = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    result -= p * Math.log2(p);
  }
  return result;
}

function redactValue(value: unknown, key?: string): unknown {
  if (key && SECRET_KEY.test(key)) return '<redacted>';
  if (typeof value === 'string') {
    if (SECRET_VALUE.test(value)) return '<redacted>';
    if (value.length > 40 && entropy(value) > 4) return '<redacted:high-entropy>';
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([childKey, child]) => [childKey, redactValue(child, childKey)]),
    );
  }
  return value;
}

export function redact(args: Record<string, unknown>): Record<string, unknown> {
  return redactValue(args) as Record<string, unknown>;
}
