import { describe, expect, it, vi } from 'vitest';
import { chooseFillText, fillCandidates, type AskFn } from '../src/fillText.js';

describe('fillCandidates — text the browser may type comes only from the task', () => {
  it('never offers a URL, domain or e-mail, even when quoted', () => {
    const task = 'Open "https://www.google.com/travel/flights" and enter https://www.google.com/travel/flights, then type "www.example.com" or "me@mail.com"';
    expect(fillCandidates(task)).toEqual([]);
  });

  it('takes quoted phrases (double, curly, and single at word boundaries)', () => {
    expect(fillCandidates('Search for "Hanuman Ansh" on https://in.bookmyshow.com')).toEqual(['Hanuman Ansh']);
    expect(fillCandidates('Type “wireless mouse” into the box')).toEqual(['wireless mouse']);
    expect(fillCandidates("Search for 'Hanuman Ansh' and check the user's tickets")).toContain('Hanuman Ansh');
    expect(fillCandidates("Check the user's tickets and don't pay")).toEqual([]);
  });

  it('takes the phrase after a search verb once URLs are removed', () => {
    expect(fillCandidates('Go to https://www.google.com/travel/flights and search for cheapest flights.')).toEqual(['cheapest flights']);
  });

  it('splits "from X to Y" into separate origin and destination candidates', () => {
    const candidates = fillCandidates('On https://www.google.com/travel/flights find flights from Kolkata to Paris for next Friday');
    expect(candidates).toContain('Kolkata');
    expect(candidates).toContain('Paris');
  });
});

describe('chooseFillText — Jev picks which candidate fits a field, or none', () => {
  const task = 'On https://www.google.com/travel/flights find flights from Kolkata to Paris';
  const field = { id: 'e3', node: 3, kind: 'fill' as const, label: 'Where to?', role: 'combobox' };
  const page = { url: 'https://www.google.com/travel/flights', title: 'Google Flights' };
  const answer = (choice: string, confidence = 0.9): AskFn => vi.fn(async () => ({
    answers: { fill_text: { type: 'choice' as const, choice, confidence, probabilities: {} } },
  }));

  it('returns the candidate Jev chose for this field', async () => {
    const candidates = fillCandidates(task);
    const ask = answer(`t${candidates.indexOf('Paris') + 1}`);
    expect(await chooseFillText(task, field, page, 'key', ask)).toBe('Paris');
    const [, questions] = (ask as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(Object.values((questions as { fill_text: { criteria: Record<string, string> } }).fill_text.criteria).join(' ')).not.toMatch(/https?:/);
  });

  it('types nothing when Jev says no text fits, or is unsure', async () => {
    expect(await chooseFillText(task, field, page, 'key', answer('NONE'))).toBeUndefined();
    expect(await chooseFillText(task, field, page, 'key', answer('t1', 0.2))).toBeUndefined();
  });

  it('does not ask Jev when the task has no candidate text', async () => {
    const ask = answer('t1');
    expect(await chooseFillText('Open https://example.com and click More information', field, page, 'key', ask)).toBeUndefined();
    expect(ask).not.toHaveBeenCalled();
  });
});
