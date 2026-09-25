import { describe, expect, it } from 'vitest';
import { redact } from '../src/redact';

describe('redact', () => {
  it('redacts secret keys and known token formats', () => {
    const input = {
      apiKey: 'do-not-log',
      nested: { authorization: 'Bearer secret' },
      text: 'ghp_123456789',
    };
    const output = redact(input);
    expect(output).toEqual({
      apiKey: '<redacted>',
      nested: { authorization: '<redacted>' },
      text: '<redacted>',
    });
    expect(input.nested.authorization).toBe('Bearer secret');
  });

  it('redacts high entropy strings without mutating input', () => {
    const value = 'aB9$kL2!pQ7#xZ4@mN8%rT1^vC6&yU3*eI5^qW8!sR2@dF7#hJ4%';
    const input = { value };
    expect(redact(input).value).toBe('<redacted:high-entropy>');
    expect(input.value).toBe(value);
  });

  it('keeps ordinary nested values', () => {
    expect(redact({ a: { b: ['hello', 2] } })).toEqual({ a: { b: ['hello', 2] } });
  });
});
