import type { GuardDecision, NormalizedToolCall } from 'jev-core';

export interface HostAdapter {
  parse(payload: unknown): NormalizedToolCall;
  render(decision: GuardDecision): string;
}

// ---------------------------------------------------------------------------
// Browser tool classification
// ---------------------------------------------------------------------------

/**
 * The exact tool name Antigravity exposes to the model for all browser actions.
 * Verified from the live agent system prompt, Sep 2026 (see docs/host-behaviour.md).
 */
export const BROWSER_TOOL_NAME = 'browser_subagent';

/**
 * Returns true if the parsed tool call should be routed through the
 * deny-and-retry browser bridge instead of the normal Jev Guard path.
 *
 * All seven browser action kinds (navigate, click, type/fill, select, scroll,
 * wait, submit) arrive through this single tool name.
 */
export function isBrowserTool(call: NormalizedToolCall): boolean {
  return call.tool === BROWSER_TOOL_NAME;
}

// ---------------------------------------------------------------------------
// Payload parser
// ---------------------------------------------------------------------------

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(label + ' must be an object');
  }
  return value as Record<string, unknown>;
}

export const agyAdapter: HostAdapter = {
  parse(payload) {
    const root = object(payload, 'payload');
    const toolCall = object(root.toolCall, 'toolCall');
    if (typeof toolCall.name !== 'string' || !toolCall.name) {
      throw new Error('toolCall.name is required');
    }
    const args = toolCall.args === undefined ? {} : object(toolCall.args, 'toolCall.args');
    const paths = Array.isArray(root.workspacePaths) ? root.workspacePaths : [];
    return {
      agent: 'agy',
      tool: toolCall.name,
      args,
      workspace: typeof paths[0] === 'string' ? paths[0] : undefined,
      conversationId: typeof root.conversationId === 'string' ? root.conversationId : undefined,
      raw: payload,
    };
  },

  render(decision) {
    if (decision.verdict === 'allow') return JSON.stringify({ decision: 'allow' });
    if (decision.verdict === 'deny') return JSON.stringify({ decision: 'deny', reason: decision.reason });
    return JSON.stringify({
      decision: decision.source === 'fallback' ? 'deny' : 'ask',
      reason: decision.reason,
    });
  },
};
