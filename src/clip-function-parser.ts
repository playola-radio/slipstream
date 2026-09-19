import { createRequire } from 'node:module';
import { Parser, Language, type Node, type Tree } from 'web-tree-sitter';
import type { ClipLanguage } from './clip-language.ts';

export interface FunctionRange {
  s0: number;
  e0: number;
  c0: number;
  c1: number;
}
export interface FunctionIndex {
  functions: FunctionRange[];
  errors: FunctionRange[];
  reason?: string;
}

// This module is dynamically imported by computing callers only. Initialization
// stays inside the existing worker job and its 100ms deadline, never HTTP startup.
const require = createRequire(import.meta.url);
await Parser.init();
const [javascript, typescript, tsx] = await Promise.all(
  ['javascript', 'typescript', 'tsx'].map(name =>
    Language.load(require.resolve(`tree-sitter-wasms/out/tree-sitter-${name}.wasm`))),
);
const FUNCTION_TYPES = new Set([
  'function_declaration', 'function_expression', 'generator_function_declaration',
  'generator_function', 'arrow_function', 'method_definition',
]);
const MAX_NODES = 20_000;
// Cooperative per-side parse limit; the existing worker deadline bounds the
// whole job, including startup, syntax indexing and diffing.
const PARSE_TIMEOUT_MS = 20;

/** Parse each immutable side once. Positions are converted by ROW, never by
 * parser startIndex (UTF-16, not a raw-blob byte offset). Trees/nodes are local
 * to this call; no retained parse state or incremental edits.
 */
export function indexFunctions(text: string, language: ClipLanguage): FunctionIndex {
  const empty = (reason: string): FunctionIndex => ({ functions: [], errors: [], reason });
  if (language === 'unsupported') return empty('unsupported-language');
  const parser = new Parser();
  let tree: Tree | null = null;
  try {
    parser.setLanguage(language === 'typescript' ? typescript!
      : language === 'tsx' ? tsx! : javascript!);
    const deadline = performance.now() + PARSE_TIMEOUT_MS;
    tree = parser.parse(text, null, { progressCallback: () => performance.now() > deadline });
    if (!tree) return empty('timeout');
    const result: FunctionIndex = { functions: [], errors: [] };
    const stack: { node: Node; unreliable: boolean }[] = [
      { node: tree.rootNode, unreliable: false },
    ];
    let visited = 0;
    while (stack.length) {
      if (++visited > MAX_NODES) return empty('extraction-budget-exhausted');
      const { node, unreliable } = stack.pop()!;
      const damaged = unreliable || node.isError || node.isMissing;
      const range = {
        s0: node.startPosition.row,
        e0: node.endPosition.row + (node.endPosition.column > 0 ? 1 : 0),
        c0: node.startPosition.column,
        c1: node.endPosition.column,
      };
      if (node.isError || node.isMissing) {
        result.errors.push({ ...range, e0: Math.max(range.e0, range.s0 + 1) });
      }
      if (FUNCTION_TYPES.has(node.type) && !damaged && !node.hasError) {
        result.functions.push(range);
      }
      // Include anonymous missing tokens as well: namedChildren would miss them.
      for (let i = node.childCount - 1; i >= 0; i--) {
        const child = node.child(i);
        if (child) stack.push({ node: child, unreliable: damaged });
      }
    }
    return result;
  } finally {
    tree?.delete();
    parser.delete();
  }
}
