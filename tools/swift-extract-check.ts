/** Standalone FD2 checker over captured CAS blobs in an explicitly selected disposable store. */
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { isMainModule } from '../src/entrypoint.ts';
import { blobPath, isValidHex } from '../src/store-reader.ts';
import { compareV2 } from '../src/interface-v2-core.ts';
import { extractSwiftSides, type SwiftSide } from '../src/swift-interface.ts';
import { checkRootAgainstRealStore } from './qa/safety.ts';

export interface CheckIO { argv: string[]; stdout: (line: string) => void; stderr: (line: string) => void }

/** Prints only structured results, never source or credentials. 0 ready, 1 refusal, 2 input/host error. */
export async function runSwiftExtractCheck(io: CheckIO): Promise<number> {
  try {
    const values = new Map<string, string>();
    for (let i = 0; i < io.argv.length; i += 2) {
      const key = io.argv[i], value = io.argv[i + 1];
      if (!key || !['--store', '--before', '--after'].includes(key) || value === undefined || values.has(key)) {
        throw new Error('usage: swift-extract-check --store <disposable-store> --before <sha256|absent> --after <sha256|absent>');
      }
      values.set(key, value);
    }
    const store = values.get('--store');
    const before = values.get('--before'), after = values.get('--after');
    if (!store || !before || !after) throw new Error('store, before and after are required');
    const storePath = resolve(store);
    const refusal = await checkRootAgainstRealStore(storePath);
    if (refusal) throw new Error(refusal.message);
    for (const sha of [before, after]) if (sha !== 'absent' && !isValidHex(sha)) throw new Error('blob references must be sha256 or absent');
    const sides: { id: string; bytes: Uint8Array }[] = [];
    for (const [id, sha] of [['before', before], ['after', after]] as const) {
      if (sha === 'absent') continue;
      const bytes = await readFile(blobPath(storePath, sha));
      if (createHash('sha256').update(bytes).digest('hex') !== sha) throw new Error(`${id} blob hash mismatch`);
      sides.push({ id, bytes });
    }
    const extracted = await extractSwiftSides(sides);
    const left = extracted.get('before') ?? { status: 'complete', declarations: [] };
    const right = extracted.get('after') ?? { status: 'complete', declarations: [] };
    const incomplete = (side: SwiftSide, prefix: string): string | null =>
      side.status === 'incomplete' ? `${prefix}-${side.reason}` : side.status === 'tooLarge' ? 'too-large' : null;
    const reason = incomplete(left, 'before') ?? incomplete(right, 'after');
    if (reason) { io.stdout(JSON.stringify({ status: reason === 'too-large' ? 'skipped' : 'incomplete', fallback_reason: reason, changes: [] })); return 1; }
    if (left.status !== 'complete' || right.status !== 'complete') throw new Error('unreachable extraction state');
    const result = compareV2(left.declarations, right.declarations);
    if (result.status === 'incomplete') {
      io.stdout(JSON.stringify({ status: 'incomplete', fallback_reason: result.reason, changes: [] }));
      return 1;
    }
    io.stdout(JSON.stringify({ status: 'ready', changes: result.changes }));
    return 0;
  } catch (error) {
    io.stderr(`swift-extract-check: ${(error as Error).message}`);
    return 2;
  }
}

if (isMainModule(import.meta.url, process.argv[1] ?? '')) {
  runSwiftExtractCheck({ argv: process.argv.slice(2), stdout: (line) => process.stdout.write(line + '\n'),
    stderr: (line) => process.stderr.write(line + '\n') }).then((code) => { process.exitCode = code; });
}
