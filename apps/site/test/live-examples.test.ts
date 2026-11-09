import { describe, expect, it } from 'vitest';
import { checkLiveExample, liveExamples, renderLiveCarousel, type LiveExample } from '../src/live-examples';
import { DAY, clock, pairs, phaseAt, planFor, pricePerPerson, versionAt } from '../src/explainer-math';

const example: LiveExample = {
  id: 'test', persona: 'Testers', summary: 'A test.', title: 'Board', kind: 'Spreadsheet', keeper: 'Keeper', people: ['maya'], version: 3,
  signals: [{ source: 'Gmail', text: 'One' }, { source: 'GitHub', text: 'Two' }],
  columns: ['A', 'B'],
  rows: [{ cells: ['x', { from: 'old', to: 'new', at: 1 }] }, { cells: ['y', 'z'], at: 2 }],
  payoff: { noticed: 'Something useful.', did: 'Did a thing', row: 1 },
};

describe('hero carousel', () => {
  it('renders one tab and one panel per example, with only the first shown', () => {
    const html = renderLiveCarousel();
    expect([...html.matchAll(/role="tab" id="lc-tab-([a-z]+)"/gu)].map(([, id]) => id))
      .toEqual(['solo', 'engineering', 'parents', 'product', 'developer', 'founder', 'recruiter']);
    expect([...html.matchAll(/<div class="lc-slide" id="lc-[a-z]+"[^>]*>/gu)].map(([tag]) => tag.includes(' hidden')))
      .toEqual([false, true, true, true, true, true, true]);
  });

  it('lands each signal on an odd step, its version and changes on the next, and the payoff last', () => {
    const html = renderLiveCarousel([example]);
    expect(html).toContain('data-steps="5"');
    expect(html).toContain('<div class="ev" data-at="1"><span class="src">Gmail</span><div><b>One</b><i class="ver" data-at="2">v4 · Keeper</i>');
    expect(html).toContain('<div class="ev" data-at="3"><span class="src">GitHub</span><div><b>Two</b><i class="ver" data-at="4">v5 · Keeper</i>');
    expect(html).toContain('<span class="changes"><i class="old" data-until="2">old</i><i class="new" data-at="2">new</i></span>');
    expect(html).toContain('<span data-until="2">Version 3</span><span data-at="2" data-until="4">Version 4</span><span data-at="4">Version 5</span>');
    expect(html).toContain('<div class="row" data-at="4" data-mark="5">');
    expect(html).toContain('<div class="payoff" data-at="5"><span class="payoff-label">Rally noticed</span><p>Something useful.</p></div>');
    expect(html).toContain('<div class="ev ev-did" data-at="5">');
  });

  it('refuses an example whose change, row or payoff names something it does not have', () => {
    expect(() => checkLiveExample({ ...example, rows: [{ cells: ['x', { from: 'a', to: 'b', at: 3 }] }], payoff: { ...example.payoff, row: 0 } }))
      .toThrow('test: row 1 names signal 3, but there are 2');
    expect(() => checkLiveExample({ ...example, payoff: { ...example.payoff, row: 2 } })).toThrow('test: the payoff names row 3, but there are 2');
    expect(() => checkLiveExample({ ...example, rows: [{ cells: ['x'] }], payoff: { ...example.payoff, row: 0 } }))
      .toThrow('test: row 1 has 1 cells for 2 columns');
    for (const shipped of liveExamples) expect(() => checkLiveExample(shipped)).not.toThrow();
  });
});

describe('explainer arithmetic', () => {
  it('moves a signal in, then on to the Canvas or out through the condition', () => {
    const match = { minute: 600, source: 'Gmail' as const, text: 'x', matches: true };
    const noise = { ...match, matches: false };
    expect(phaseAt(match, 599, true)).toEqual({ kind: 'waiting' });
    expect(phaseAt(match, 615, true)).toEqual({ kind: 'inbound', progress: 0.5 });
    expect(phaseAt(match, 645, true)).toEqual({ kind: 'outbound', progress: 0.5 });
    expect(phaseAt(match, 660, true)).toEqual({ kind: 'done' });
    expect(phaseAt(noise, 637.5, true)).toEqual({ kind: 'dropped', progress: 0.5 });
    expect(phaseAt(noise, 645, false)).toEqual({ kind: 'outbound', progress: 0.5 });
  });

  it('counts a version for each signal that has finished publishing', () => {
    expect(versionAt(0, true)).toBe(1);
    expect(versionAt(1439, true)).toBe(6);
    expect(versionAt(1439, false)).toBe(1 + DAY.length);
    expect(clock(545)).toBe('09:05');
  });

  it('shares the plan price across the team and counts one hand-off per pair', () => {
    expect([1, 4, 5, 10, 15].map(pricePerPerson)).toEqual([100, 25, 50, 25, null]);
    expect(planFor(14).name).toBe('Grow');
    expect([1, 2, 6, 20].map(pairs)).toEqual([0, 1, 15, 190]);
  });
});
