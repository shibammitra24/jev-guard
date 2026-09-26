import { describe, expect, it } from 'vitest';
import { classifyWorkflowPrompt, extractPromptUrl } from '../src/workflow.js';

describe('unified workflow routing', () => {
  it('routes browser goals and URLs to the fast browser', () => {
    expect(classifyWorkflowPrompt('Open https://example.com and click More information')).toBe('browser');
    expect(classifyWorkflowPrompt('Browse the website and fill the form')).toBe('browser');
    expect(extractPromptUrl('visit https://example.com/docs now')).toBe('https://example.com/docs');
    expect(extractPromptUrl('Open https://www.district.in/movies/mirzapur-MV181196.')).toBe('https://www.district.in/movies/mirzapur-MV181196');
    expect(extractPromptUrl('Go to https://www.district.in/movies/mirzapur-MV181196: list prices')).toBe('https://www.district.in/movies/mirzapur-MV181196');
    expect(extractPromptUrl('see [docs](https://example.com/a_(b)) and more')).toBe('https://example.com/a_(b)');
    expect(extractPromptUrl('(https://example.com/x?q=1&y=2).')).toBe('https://example.com/x?q=1&y=2');
  });

  it('routes command and filesystem prompts through the command guard', () => {
    expect(classifyWorkflowPrompt('rm -rf src')).toBe('command');
    expect(classifyWorkflowPrompt('list files in this folder')).toBe('command');
  });
});
