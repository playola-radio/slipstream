import { extname } from 'node:path';

export type ClipLanguage = 'javascript' | 'jsx' | 'typescript' | 'tsx' | 'unsupported';

/** Filename selection is public input, never an inference from captured bytes. */
export function languageForPath(path: string): ClipLanguage {
  switch (extname(path).toLowerCase()) {
    case '.js': case '.mjs': case '.cjs': return 'javascript';
    case '.jsx': return 'jsx';
    case '.ts': case '.mts': case '.cts': return 'typescript';
    case '.tsx': return 'tsx';
    default: return 'unsupported';
  }
}
