import Parser from 'tree-sitter';
import JavaScript from 'tree-sitter-javascript';
import TypeScript from 'tree-sitter-typescript';
import type { ClipLanguage } from './clip-language.ts';

export interface FunctionRange { s0: number; e0: number }
export interface FunctionIndex {
  functions: FunctionRange[];
  errors: FunctionRange[];
  reason?: string;
}

const FUNCTION_TYPES = new Set([
  'function_declaration', 'function_expression', 'generator_function_declaration',
  'generator_function', 'arrow_function', 'method_definition',
]);
const MAX_NODES = 20_000;
// Two sides may each spend 20ms in native parsing. The service's existing
// 100ms deadline still bounds the entire job. Timing fallbacks are never cached.
const PARSE_TIMEOUT_US = 20_000;

/** Parse each immutable side once. Positions are converted by ROW, never by
 * native startIndex (which is UTF-16 here, not a raw-blob byte offset).
 * Trees/nodes are local to this call; no retained parse state or incremental edits.
 */
export function indexFunctions(text: string, language: ClipLanguage): FunctionIndex {
  const empty = (reason: string): FunctionIndex => ({ functions: [], errors: [], reason });
  if (language === 'unsupported') return empty('unsupported-language');
  const parser = new Parser();
  parser.setLanguage(language === 'typescript' ? TypeScript.typescript
    : language === 'tsx' ? TypeScript.tsx : JavaScript);
  parser.setTimeoutMicros(PARSE_TIMEOUT_US);
  // Native 0.21 needs an explicit input buffer for strings above 32Ki code units.
  const tree = parser.parse(text, undefined, { bufferSize: 2 * 1024 * 1024 });
  if (!tree) return empty('timeout');
  const result: FunctionIndex = { functions: [], errors: [] };
  const stack: { node: Parser.SyntaxNode; unreliable: boolean }[] = [
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
}
