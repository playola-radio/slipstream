/**
 * Read and edit the `[scripts] setup` / `archive` entries of a Conductor
 * settings file, keeping every other line as written. Only the plain forms are
 * handled: a plainly written `[scripts]` table with single-line string values.
 * Anything else (dotted keys, inline tables, a quoted `["scripts"]` header, a
 * multi-line string anywhere in the file) is refused, so a file is never
 * rewritten on a guess.
 */

export type ScriptKind = 'setup' | 'archive';
export type Scripts = Partial<Record<ScriptKind, string>>;
export const SCRIPT_KINDS: readonly ScriptKind[] = ['setup', 'archive'];

export class SettingsError extends Error {}

const HEADER = /^\s*\[\s*([^\[\]]+?)\s*\]\s*(?:#.*)?$/;
const ARRAY_HEADER = /^\s*\[\[/;
const KEY = /^\s*(setup|archive)\s*=\s*(.*)$/;

function unsupported(path: string, line: number, why: string): SettingsError {
  return new SettingsError(`${path}:${line} ${why}; Slipstream edits only a [scripts] table with single-line string values. `
    + 'Nothing was changed.');
}

function parseValue(raw: string, path: string, line: number): string {
  const text = raw.trim();
  let value: string;
  let rest: string;
  if (text.startsWith('"')) {
    let end = 1;
    while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
    if (end >= text.length) throw unsupported(path, line, 'has an unterminated string');
    try { value = JSON.parse(text.slice(0, end + 1)) as string; } catch {
      throw unsupported(path, line, 'has a string escape Slipstream does not read');
    }
    rest = text.slice(end + 1);
  } else if (text.startsWith("'")) {
    const end = text.indexOf("'", 1);
    if (end < 0) throw unsupported(path, line, 'has an unterminated string');
    value = text.slice(1, end);
    rest = text.slice(end + 1);
  } else {
    throw unsupported(path, line, 'sets a script to something other than a string');
  }
  if (rest.trim() !== '' && !rest.trim().startsWith('#')) throw unsupported(path, line, 'has text after the string');
  return value;
}

interface Located { scripts: Scripts; lines: string[]; header?: number; at: Partial<Record<ScriptKind, number>> }

function opensMultilineString(line: string): boolean {
  return /^\s*[^#=]+\s*=\s*(?:"""|''')/.test(line);
}

function locate(text: string, path: string): Located {
  const lines = text.split('\n');
  const scripts: Scripts = {};
  const at: Partial<Record<ScriptKind, number>> = {};
  let table: string | null = '';
  let found: number | undefined;
  for (const [i, line] of lines.entries()) {
    if (opensMultilineString(line)) throw unsupported(path, i + 1, 'uses a multi-line string');
    if (ARRAY_HEADER.test(line)) { table = null; continue; }
    const header = HEADER.exec(line);
    if (header) {
      table = header[1]!;
      if (/^["']/.test(table)) throw unsupported(path, i + 1, 'quotes a table name');
      if (table === 'scripts') {
        if (found !== undefined) throw unsupported(path, i + 1, 'repeats the [scripts] table');
        found = i;
      }
      continue;
    }
    if (table === '' && /^\s*["']/.test(line)) throw unsupported(path, i + 1, 'quotes a top-level key');
    if (table === '' && /^\s*scripts\s*[.=]/.test(line)) throw unsupported(path, i + 1, 'sets scripts outside a [scripts] table');
    if (table !== 'scripts') continue;
    if (/^\s*["']/.test(line)) throw unsupported(path, i + 1, 'quotes a script key');
    const key = KEY.exec(line);
    if (!key) continue;
    const kind = key[1] as ScriptKind;
    scripts[kind] = parseValue(key[2]!, path, i + 1);
    at[kind] = i;
  }
  return { scripts, lines, header: found, at };
}

export function readTomlScripts(text: string, path: string): Scripts {
  return locate(text, path).scripts;
}

/** `text` with these scripts set, every other line kept. */
export function writeTomlScripts(text: string, scripts: Scripts, path: string): string {
  const { lines, header, at } = locate(text, path);
  const entries = SCRIPT_KINDS.filter((k) => scripts[k] !== undefined).map((k) => [k, `${k} = ${JSON.stringify(scripts[k])}`] as const);
  const missing: string[] = [];
  for (const [kind, line] of entries) {
    if (at[kind] !== undefined) lines[at[kind]] = line;
    else missing.push(line);
  }
  if (missing.length === 0) return lines.join('\n');
  if (header !== undefined) {
    lines.splice(header + 1, 0, ...missing);
    return lines.join('\n');
  }
  const body = lines.join('\n');
  const sep = body === '' ? '' : body.endsWith('\n\n') ? '' : body.endsWith('\n') ? '\n' : '\n\n';
  return `${body}${sep}[scripts]\n${missing.join('\n')}\n`;
}

/** `text` with generated script entries removed, retaining all other text. */
export function removeTomlScripts(text: string, kinds: readonly ScriptKind[], path: string): string {
  const { lines, at } = locate(text, path);
  const remove = kinds.map((kind) => at[kind]).filter((line): line is number => line !== undefined).sort((a, b) => b - a);
  for (const line of remove) lines.splice(line, 1);
  return lines.join('\n');
}

/** The scripts of a legacy `conductor.json`. */
export function readLegacyScripts(text: string, path: string): Scripts {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new SettingsError(`${path} is not valid JSON. Nothing was changed.`); }
  const scripts = (parsed as { scripts?: Record<string, unknown> } | null)?.scripts;
  const out: Scripts = {};
  for (const kind of SCRIPT_KINDS) if (typeof scripts?.[kind] === 'string') out[kind] = scripts[kind];
  return out;
}
