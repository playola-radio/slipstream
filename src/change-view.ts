// Renders a `file.changed` event as the file's *current* content, line-numbered,
// with an `x` beside each changed line and a blank beside unchanged ones — the
// after-state, not a diff. Unchanged lines far from any change are elided, with
// a `⋯` marking each gap.

const sanitize = (s: string): string => s.replace(/[\x00-\x1f\x7f]/g, '�');

/** Split file text into display lines. A trailing newline is a line terminator,
 *  not an extra blank line; empty text is zero lines. */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/** For each after-line, true if it is NOT part of the longest common subsequence
 *  with the before-lines — i.e. it is new or replaced rather than carried over. */
export function markChanges(before: string[], after: string[]): boolean[] {
  const n = before.length;
  const m = after.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = before[i] === after[j]
        ? dp[i + 1]![j + 1]! + 1
        : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const changed = new Array<boolean>(m).fill(true);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) { changed[j] = false; i++; j++; }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++;
    else j++;
  }
  return changed;
}

/** Render after-content as numbered, marked display lines with `context` lines of
 *  unchanged context around each changed run and `⋯` between elided gaps. Returns
 *  [] when nothing changed. */
export function renderMarkedLines(before: string[], after: string[], context: number): string[] {
  const changed = markChanges(before, after);
  const m = after.length;
  const visible = new Array<boolean>(m).fill(false);
  let any = false;
  for (let k = 0; k < m; k++) {
    if (!changed[k]) continue;
    any = true;
    const lo = Math.max(0, k - context);
    const hi = Math.min(m - 1, k + context);
    for (let v = lo; v <= hi; v++) visible[v] = true;
  }
  if (!any) return [];
  const width = String(m).length;
  const out: string[] = [];
  let prev = -1;
  for (let k = 0; k < m; k++) {
    if (!visible[k]) continue;
    if (prev !== -1 && k > prev + 1) out.push('⋯');
    const mark = changed[k] ? 'x' : ' ';
    out.push(`${mark} ${String(k + 1).padStart(width)} ${sanitize(after[k]!)}`);
    prev = k;
  }
  return out;
}
