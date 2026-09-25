import { describe, expect, it } from 'vitest';
import { decide } from '../src/policy';
import type { GuardSignals } from '../src/types';

const base: GuardSignals = {
  destructive: 0,
  secrets: 0,
  exfiltration: 0,
  outsideWorkspace: 0,
  risk: 0,
  userExplicit: 0,
  isWildcard: false,
};

describe('decide', () => {
  it.each([
    [0.849, 'ask'],
    [0.85, 'deny'],
  ])('applies noul deny boundary %s', (value, verdict) => {
    expect(decide({ ...base, destructive: value }, 'agy').verdict).toBe(verdict);
  });

  it.each([
    [1.49, 'allow'],
    [1.5, 'ask'],
    [2.49, 'ask'],
    [2.5, 'deny'],
  ])('applies risk boundary %s', (value, verdict) => {
    expect(decide({ ...base, risk: value }, 'agy').verdict).toBe(verdict);
  });

  it('selects the highest noul as trigger', () => {
    const result = decide({ ...base, secrets: 0.6, exfiltration: 0.7 }, 'agy');
    expect(result.trigger).toBe('exfiltration');
    expect(result.reason).toContain('exfiltration');
  });
});
