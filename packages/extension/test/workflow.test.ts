import { describe, expect, it } from 'vitest';
import { classifyWorkflowPrompt, extractPromptUrl } from '../src/workflow.js';

describe('unified workflow routing', () => {
  it('routes browser goals and URLs to the fast browser', () => {
    expect(classifyWorkflowPrompt('Open https://example.com and click More information')).toBe('browser');
    expect(classifyWorkflowPrompt('Browse the website and fill the form')).toBe('browser');
    expect(extractPromptUrl('visit https://example.com/docs now')).toBe('https://example.com/docs');
  });

  it('routes command and filesystem prompts through the command guard', () => {
    expect(classifyWorkflowPrompt('rm -rf src')).toBe('command');
    expect(classifyWorkflowPrompt('list files in this folder')).toBe('command');
  });
});
