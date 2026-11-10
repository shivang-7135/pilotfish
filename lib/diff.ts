/**
 * Page outlines are large and mostly unchanged between steps, so after the
 * first one we send only what changed. Element refs are stable across
 * snapshots, which makes a line-level diff readable for the model:
 *
 *   ~ [5] input "Email" value="a@b.c"    element changed (new version shown)
 *   + [9] button "Continue"              new line
 *   - Please enter your email            text that disappeared
 *   Removed elements: [3] [4]
 *
 * Returns null when a full outline is the better choice (new URL or a big change).
 */
export function diffState(prev: string, next: string): string | null {
  const a = prev.split('\n');
  const b = next.split('\n');
  if (a[0] !== b[0]) return null; // different URL
  const inA = new Set(a);
  const inB = new Set(b);
  const added = b.filter((l) => l && !inA.has(l));
  const removed = a.filter((l) => l && !inB.has(l));
  if (!added.length && !removed.length) return 'No visible change on the page.';

  const refOf = (l: string) => l.match(/^\[(\d+)\]/)?.[1];
  const before = new Set(removed.map(refOf).filter(Boolean));
  const after = new Set(added.map(refOf).filter(Boolean));
  const out: string[] = [];
  const gone: string[] = [];
  for (const l of removed) {
    const r = refOf(l);
    if (!r) out.push(`- ${l}`);
    else if (!after.has(r)) gone.push(`[${r}]`);
  }
  for (const l of added) {
    const r = refOf(l);
    out.push(`${r && before.has(r) ? '~' : '+'} ${l}`);
  }
  if (gone.length) out.push(`Removed elements: ${gone.join(' ')}`);
  const text = out.join('\n');
  return text.length > 3000 || text.length > next.length * 0.6 ? null : text;
}
