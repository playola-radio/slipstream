/**
 * URL of a sibling module (given without extension) that a worker or child
 * process will load. Source runs as `.ts`; the published package ships compiled
 * `.js`, and `tsc` does not rewrite extensions inside `new URL(...)`, so the
 * extension is taken from the calling module's own URL.
 */
export function siblingModuleUrl(name: string, callerUrl: string): URL {
  const ext = callerUrl.endsWith('.ts') ? '.ts' : '.js';
  return new URL(`./${name}${ext}`, callerUrl);
}
