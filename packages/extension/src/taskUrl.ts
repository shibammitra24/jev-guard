/** First absolute http(s) URL in a task or prompt, without trailing sentence punctuation. */
export function extractTaskUrl(task: string): string | undefined {
  const match = task.match(/https?:\/\/[^\s'"<>`]+/i)?.[0];
  return match ? trimUrlPunctuation(match) : undefined;
}

/**
 * Drop sentence punctuation that follows a URL in prose ("open https://x.com/a." or
 * "https://x.com/a: then ..."), and a closing bracket that has no opening one in the URL.
 */
export function trimUrlPunctuation(url: string): string {
  let value = url;
  for (;;) {
    const trimmed = value.replace(/[.,:;!?*]+$/, '');
    const last = trimmed[trimmed.length - 1];
    const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
    const open = last ? pairs[last] : undefined;
    const unbalanced = open !== undefined && trimmed.split(last!).length > trimmed.split(open).length;
    const next = unbalanced ? trimmed.slice(0, -1) : trimmed;
    if (next === value) return value;
    value = next;
  }
}
