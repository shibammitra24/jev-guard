import { describe, expect, it } from 'vitest';
import {
  TOOL_POLICY_CATALOG,
  defaultToolPolicyState,
  isBrowserActionAutonomous,
  mergeToolPolicyState,
  resolveOperationRule,
  resolveToolRule,
} from '../src/toolPolicy';

describe('TOOL_POLICY_CATALOG', () => {
  it('has a unique id for every rule', () => {
    const ids = TOOL_POLICY_CATALOG.map(rule => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('defaults every tool-kind rule to enabled', () => {
    for (const rule of TOOL_POLICY_CATALOG.filter(r => r.kind === 'tool')) {
      expect(rule.defaultEnabled).toBe(true);
    }
  });

  it('defaults every operation-kind (dangerous) rule to disabled', () => {
    for (const rule of TOOL_POLICY_CATALOG.filter(r => r.kind === 'operation')) {
      expect(rule.defaultEnabled).toBe(false);
    }
  });

  it('covers all five deterministic dangerous operation classes', () => {
    const covered = TOOL_POLICY_CATALOG.filter(r => r.kind === 'operation').flatMap(r => r.match);
    expect(covered.sort()).toEqual(
      ['destructive', 'exfiltration', 'guard_tampering', 'outside_workspace', 'secret_access'].sort(),
    );
  });
});

describe('defaultToolPolicyState', () => {
  it('matches each rule to its catalog default', () => {
    const state = defaultToolPolicyState();
    for (const rule of TOOL_POLICY_CATALOG) expect(state[rule.id]).toBe(rule.defaultEnabled);
  });
});

describe('mergeToolPolicyState', () => {
  it('returns defaults when nothing is saved', () => {
    expect(mergeToolPolicyState(undefined)).toEqual(defaultToolPolicyState());
  });

  it('applies a saved override on top of defaults', () => {
    const state = mergeToolPolicyState({ op_destructive: true });
    expect(state.op_destructive).toBe(true);
    expect(state.tool_read).toBe(true);
  });

  it('ignores unknown saved keys and non-boolean values', () => {
    const state = mergeToolPolicyState({ not_a_rule: true, tool_write: 'yes' as unknown as boolean });
    expect(state).not.toHaveProperty('not_a_rule');
    expect(state.tool_write).toBe(true); // catalog default, since the saved value wasn't a boolean
  });
});

describe('resolveToolRule', () => {
  it('matches a known tool name across agent aliases', () => {
    const state = defaultToolPolicyState();
    expect(resolveToolRule('run_command', state)?.rule.id).toBe('tool_run_command');
    expect(resolveToolRule('Bash', state)?.rule.id).toBe('tool_run_command');
    expect(resolveToolRule('Read', state)?.rule.id).toBe('tool_read');
  });

  it('matches every tool name to exactly one tool rule', () => {
    const names = TOOL_POLICY_CATALOG.filter(r => r.kind === 'tool').flatMap(r => r.match);
    expect(new Set(names).size).toBe(names.length);
  });

  it('classifies fetch, web search, code search and browser actions to their own toggles', () => {
    const state = defaultToolPolicyState();
    expect(resolveToolRule('read_url_content', state)?.rule.id).toBe('tool_fetch_url');
    expect(resolveToolRule('search_web', state)?.rule.id).toBe('tool_web_search');
    expect(resolveToolRule('grep_search', state)?.rule.id).toBe('tool_read');
    expect(resolveToolRule('browser_subagent', state)?.rule.id).toBe('tool_browser');
    expect(resolveToolRule('browser_click', state)?.rule.id).toBe('tool_browser');
    expect(resolveToolRule('browser_submit', state)?.rule.id).toBe('tool_browser');
  });

  it('turning Fetch URLs off actually disables read_url_content', () => {
    const state = mergeToolPolicyState({ tool_fetch_url: false });
    expect(resolveToolRule('read_url_content', state)).toMatchObject({ enabled: false });
    expect(resolveToolRule('view_file', state)).toMatchObject({ enabled: true });
  });

  it('web search off carries a hint steering the agent to the browser', () => {
    const match = resolveToolRule('search_web', mergeToolPolicyState({ tool_web_search: false }));
    expect(match).toMatchObject({ enabled: false });
    expect(match?.rule.offHint).toMatch(/browser_subagent/);
  });

  it('returns undefined for an unrecognized tool', () => {
    expect(resolveToolRule('some_future_tool', defaultToolPolicyState())).toBeUndefined();
  });

  it('reflects a toggled-off state', () => {
    const state = mergeToolPolicyState({ tool_run_command: false });
    expect(resolveToolRule('run_command', state)).toMatchObject({ enabled: false });
  });
});

describe('isBrowserActionAutonomous', () => {
  it('is on by default for every browser action kind', () => {
    const state = defaultToolPolicyState();
    for (const kind of ['click', 'select', 'scroll', 'wait', 'fill', 'submit']) {
      expect(isBrowserActionAutonomous(kind, state)).toBe(true);
    }
  });

  it('follows each browser toggle independently', () => {
    const state = mergeToolPolicyState({ browser_type_text: false, browser_submit: false });
    expect(isBrowserActionAutonomous('fill', state)).toBe(false);
    expect(isBrowserActionAutonomous('submit', state)).toBe(false);
    expect(isBrowserActionAutonomous('click', state)).toBe(true);
  });

  it('never treats an unknown kind (e.g. navigate) as autonomous', () => {
    expect(isBrowserActionAutonomous('navigate', defaultToolPolicyState())).toBe(false);
  });
});

describe('resolveOperationRule', () => {
  it('matches destructive to op_destructive, off by default', () => {
    const state = defaultToolPolicyState();
    expect(resolveOperationRule('destructive', state)).toMatchObject({ enabled: false });
  });

  it('reflects toggling a dangerous category on', () => {
    const state = mergeToolPolicyState({ op_destructive: true });
    expect(resolveOperationRule('destructive', state)).toMatchObject({ enabled: true });
  });

  it('returns undefined for benign operation classes', () => {
    const state = defaultToolPolicyState();
    expect(resolveOperationRule('read', state)).toBeUndefined();
    expect(resolveOperationRule('workspace_edit', state)).toBeUndefined();
  });
});
