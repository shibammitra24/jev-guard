import { describe, expect, it } from 'vitest';
import { run } from '../run';

describe('eval runner stub', () => {
  it('exports a run function', () => {
    expect(typeof run).toBe('function');
  });
});
