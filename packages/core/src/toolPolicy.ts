import { READ_ONLY_TOOLS } from './prefilter';

export type ToolPolicyRuleKind = 'tool' | 'browser' | 'operation';

export interface ToolPolicyRule {
  id: string;
  label: string;
  description: string;
  kind: ToolPolicyRuleKind;
  /**
   * Tool names (kind: 'tool'), browser action kinds (kind: 'browser'), or
   * OperationClass values (kind: 'operation') this rule matches.
   */
  match: readonly string[];
  defaultEnabled: boolean;
  /** Appended to the denial reason when a 'tool' rule is off, to steer the agent. */
  offHint?: string;
}

const FETCH_TOOLS = ['read_url_content', 'WebFetch'] as const;

/** Per-action tool names the fast-browser sidecar sends to the guard daemon. */
export const BROWSER_ACTION_TOOLS = [
  'browser_click', 'browser_fill', 'browser_select', 'browser_submit',
  'browser_navigate', 'browser_scroll', 'browser_wait',
] as const;

/**
 * The full catalog shown as the allow/deny list in the Guard Console.
 *
 * 'tool' rules gate a whole tool: turning one off makes the guard deny every
 * call to that tool, before Jev is ever asked. They default to enabled so
 * normal work is unaffected.
 *
 * 'browser' rules decide how autonomously the fast browser acts. They only
 * decide whether a low-risk step may proceed without a human; a Jev deny, or
 * any destructive/secret/exfiltration signal, still stops the browser.
 *
 * 'operation' rules gate one of the deterministic OperationClass categories
 * from operation.ts (destructive, exfiltration, secret access, writes
 * outside the workspace, guard tampering). They default to DISABLED, which
 * hard-blocks these classes without ever calling Jev. Toggling one on is the
 * user's explicit permission: calls in that category are allowed without a
 * Jev check. A tool toggled off still wins over a category toggled on.
 */
export const TOOL_POLICY_CATALOG: readonly ToolPolicyRule[] = [
  {
    id: 'tool_read',
    label: 'Read files & search code',
    description: 'list_dir, view_file, grep_search, codebase_search, view_code_item, Read, Glob, Grep',
    kind: 'tool',
    // Fetch tools are READ_ONLY_TOOLS for the prefilter but have their own toggle.
    match: [...READ_ONLY_TOOLS.filter(tool => !(FETCH_TOOLS as readonly string[]).includes(tool)), 'grep_search'],
    defaultEnabled: true,
  },
  {
    id: 'tool_write',
    label: 'Edit & write files',
    description: 'write_to_file, write_file, create_file, edit_file, replace_file_content, apply_patch, save_file, Write, Edit, MultiEdit',
    kind: 'tool',
    match: ['write_to_file', 'write_file', 'create_file', 'edit_file', 'replace_file_content', 'apply_patch', 'save_file', 'create_or_replace_file', 'Write', 'Edit', 'MultiEdit'],
    defaultEnabled: true,
  },
  {
    id: 'tool_run_command',
    label: 'Run shell commands',
    description: 'run_command, Bash',
    kind: 'tool',
    match: ['run_command', 'Bash'],
    defaultEnabled: true,
  },
  {
    id: 'tool_fetch_url',
    label: 'Fetch URLs',
    description: 'read_url_content, WebFetch',
    kind: 'tool',
    match: FETCH_TOOLS,
    defaultEnabled: true,
  },
  {
    id: 'tool_web_search',
    label: 'Web search',
    description: 'search_web, WebSearch — turn off to make the agent use the browser on the site you name instead of searching the web',
    kind: 'tool',
    match: ['search_web', 'WebSearch'],
    defaultEnabled: true,
    offHint: 'Do not search the web. Use browser_subagent with the exact site URL from the user request instead.',
  },
  {
    id: 'tool_browser',
    label: 'Browser automation',
    description: 'browser_subagent and every Jev Fast Browser action',
    kind: 'tool',
    match: ['browser_subagent', ...BROWSER_ACTION_TOOLS],
    defaultEnabled: true,
  },
  {
    id: 'browser_auto_actions',
    label: 'Act without confirmation',
    description: 'Clicks, selections, scrolling and waiting proceed automatically, including uncertain picks, as long as Jev sees no destructive, secret or exfiltration risk',
    kind: 'browser',
    match: ['click', 'select', 'scroll', 'wait'],
    defaultEnabled: true,
  },
  {
    id: 'browser_type_text',
    label: 'Type text from the task',
    description: 'Fills fields with text taken word-for-word from the task (quoted text, or the phrase after "search for"). Jev never invents text',
    kind: 'browser',
    match: ['fill'],
    defaultEnabled: true,
  },
  {
    id: 'browser_submit',
    label: 'Submit forms & searches',
    description: 'Submits forms and search boxes automatically. Off: every submit needs confirmation',
    kind: 'browser',
    match: ['submit'],
    defaultEnabled: true,
  },
  {
    id: 'op_destructive',
    label: 'Destructive file/git operations',
    description: 'Recursive or forced deletes: rm -rf, del /s, Remove-Item -Recurse, git clean, rmdir /s',
    kind: 'operation',
    match: ['destructive'],
    defaultEnabled: false,
  },
  {
    id: 'op_exfiltration',
    label: 'Exfiltration commands',
    description: 'Network commands (curl / wget / Invoke-WebRequest) that reference local secrets',
    kind: 'operation',
    match: ['exfiltration'],
    defaultEnabled: false,
  },
  {
    id: 'op_secret_access',
    label: 'Secret & credential access',
    description: 'Reads or writes .env files, credentials, tokens, or private keys',
    kind: 'operation',
    match: ['secret_access'],
    defaultEnabled: false,
  },
  {
    id: 'op_outside_workspace',
    label: 'Writes outside the workspace',
    description: 'File writes that target a path outside the selected workspace',
    kind: 'operation',
    match: ['outside_workspace'],
    defaultEnabled: false,
  },
  {
    id: 'op_guard_tampering',
    label: 'Jev Guard tampering',
    description: 'Edits to the guard hook configuration or the bundled guard script',
    kind: 'operation',
    match: ['guard_tampering'],
    defaultEnabled: false,
  },
] as const;

/** ruleId -> enabled. Missing entries fall back to the catalog's defaultEnabled. */
export type ToolPolicyState = Record<string, boolean>;

export function defaultToolPolicyState(): ToolPolicyState {
  const state: ToolPolicyState = {};
  for (const rule of TOOL_POLICY_CATALOG) state[rule.id] = rule.defaultEnabled;
  return state;
}

/** Merges a saved (possibly partial or stale) state with the current catalog defaults. */
export function mergeToolPolicyState(saved: Partial<ToolPolicyState> | undefined | null): ToolPolicyState {
  const state = defaultToolPolicyState();
  if (!saved) return state;
  for (const rule of TOOL_POLICY_CATALOG) {
    if (typeof saved[rule.id] === 'boolean') state[rule.id] = saved[rule.id] as boolean;
  }
  return state;
}

export interface ToolPolicyMatch {
  rule: ToolPolicyRule;
  enabled: boolean;
}

function findRule(kind: ToolPolicyRuleKind, value: string): ToolPolicyRule | undefined {
  return TOOL_POLICY_CATALOG.find(rule => rule.kind === kind && rule.match.includes(value));
}

export function resolveToolRule(tool: string, state: ToolPolicyState): ToolPolicyMatch | undefined {
  const rule = findRule('tool', tool);
  if (!rule) return undefined;
  return { rule, enabled: state[rule.id] ?? rule.defaultEnabled };
}

/** Whether the fast browser may perform this action kind without a human. */
export function isBrowserActionAutonomous(kind: string, state: ToolPolicyState): boolean {
  const rule = findRule('browser', kind);
  return rule ? (state[rule.id] ?? rule.defaultEnabled) : false;
}

export function resolveOperationRule(operationClass: string, state: ToolPolicyState): ToolPolicyMatch | undefined {
  const rule = findRule('operation', operationClass);
  if (!rule) return undefined;
  return { rule, enabled: state[rule.id] ?? rule.defaultEnabled };
}
