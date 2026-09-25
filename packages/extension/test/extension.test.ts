import { describe, expect, it, vi } from 'vitest';
vi.mock('vscode', () => ({ commands: {}, window: {} }));
import { activate, deactivate } from '../src/extension';

describe('extension stub', () => {
  it('exports activate and deactivate', () => {
    expect(typeof activate).toBe('function');
    expect(typeof deactivate).toBe('function');
  });
});
