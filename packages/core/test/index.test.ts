import { describe, expect, it } from 'vitest';
import { CORE_VERSION } from '../src/index';

describe('jev-core stub', () => {
  it('exports a version string', () => {
    expect(CORE_VERSION).toBe('0.2.0');
  });
});
