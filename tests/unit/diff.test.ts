import { describe, expect, it } from 'vitest';
import { diffState } from '../../lib/diff';

const filler = Array.from({ length: 30 }, (_, i) => `[${i + 20}] link "Item ${i}" -> /item/${i}`);
const page = (lines: string[], url = 'https://x.test/form') =>
  [`URL: ${url}`, 'Title: Form', 'Scroll: more content below', '', ...lines, ...filler].join('\n');

const before = page(['# Sign up', '[1] input[type=text] "Name" (required)', '[2] input[type=email] "Email"', '[3] button "Next"']);

describe('diffState', () => {
  it('reports a changed element once, with its new version', () => {
    const after = before.replace('"Name" (required)', '"Name" value="Ada" (required)');
    expect(diffState(before, after)).toBe('~ [1] input[type=text] "Name" value="Ada" (required)');
  });

  it('reports new lines, removed text and removed elements', () => {
    const after = page(['# Sign up', 'Email is required', '[1] input[type=text] "Name" (required)', '[2] input[type=email] "Email" (invalid)', '[9] button "Retry"']);
    expect(diffState(before, after)!.split('\n')).toEqual([
      '+ Email is required',
      '~ [2] input[type=email] "Email" (invalid)',
      '+ [9] button "Retry"',
      'Removed elements: [3]',
    ]);
  });

  it('says so when nothing changed', () => {
    expect(diffState(before, before)).toMatch(/No visible change/);
  });

  it('falls back to a full state on a new URL or a large change', () => {
    expect(diffState(before, page(['# Done'], 'https://x.test/thanks'))).toBeNull();
    const rewritten = page(Array.from({ length: 60 }, (_, i) => `[${i + 100}] button "New ${i}"`));
    expect(diffState(before, rewritten)).toBeNull();
  });
});
