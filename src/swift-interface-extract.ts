/** Swift syntax extraction. Call only in the pinned --liftoff-only child. */
import { Parser, type Language, type Node } from 'web-tree-sitter';
import { buildUtf16ToByteTable, utf16RangeToByteRange } from './swift-spans.ts';
import type { V2Declaration, V2Header, V2Parameter, V2Result, V2Throws } from './interface-v2-core.ts';

export const SWIFT_V1 = {
  language: 'swift', languageVersion: 'swift.v1', extensions: ['.swift'],
  exclusions: [
    'anonymous closures', 'local functions', 'nested functions', 'accessors', 'subscripts',
    'macro-generated declarations', 'deinitializers', 'shared type propagation', 'effects', 'behavior',
    'typed throws (pinned grammar reports ERROR)',
  ],
} as const;

export interface SwiftLimits { inputBytes?: number; declarations?: number; syntaxVisits?: number }
export type SwiftSide =
  | { status: 'complete'; declarations: V2Declaration[]; stats: { declarations: number; syntaxVisits: number } }
  | { status: 'incomplete'; reason: 'parse-error' | 'unsupported-construct' }
  | { status: 'tooLarge'; limit: 'inputBytes' | 'declarations' | 'syntaxVisits' };

class Unsupported extends Error {}
class TooLarge extends Error {
  readonly limit: 'inputBytes' | 'declarations' | 'syntaxVisits';
  constructor(limit: 'inputBytes' | 'declarations' | 'syntaxVisits') { super(limit); this.limit = limit; }
}

function children(node: Node): Node[] { return node.children.filter((child): child is Node => child !== null); }
function named(node: Node): Node[] { return node.namedChildren.filter((child): child is Node => child !== null); }
function field(node: Node, child: Node): string | null {
  for (let i = 0; i < node.childCount; i++) if (node.child(i)?.id === child.id) return node.fieldNameForChild(i);
  return null;
}
function direct(node: Node, type: string): Node | undefined { return children(node).find((child) => child.type === type); }
function tokens(node: Node, source: string): string[] {
  if (node.type === 'comment' || node.type === 'multiline_comment') return [];
  if (node.type.includes('string_literal') || node.type === 'regex_literal') return [source.slice(node.startIndex, node.endIndex)];
  if (node.childCount === 0) return [source.slice(node.startIndex, node.endIndex)];
  return children(node).flatMap((child) => tokens(child, source));
}
/** Canonical token rendering: trivia is discarded, literal contents are atomic. */
function normalized(node: Node, source: string): string {
  const ts = tokens(node, source);
  let result = '';
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i]!;
    const previous = ts[i - 1];
    const word = (s: string): boolean => /[\p{L}\p{N}_$]$/u.test(s);
    const startsWord = (s: string): boolean => /^[\p{L}\p{N}_$]/u.test(s);
    const gap = previous !== undefined && ((word(previous) && startsWord(t)) || previous === ':' || previous === ',' ||
      previous === '->' || t === '->' || previous === '==' || t === '==');
    if (gap) result += ' ';
    result += t;
  }
  return result;
}

function parameter(node: Node, source: string, position: number, defaultNode?: Node): V2Parameter {
  const names = children(node).filter((c) => c.type === 'simple_identifier');
  const external = children(node).find((c) => field(node, c) === 'external_name');
  const local = names.find((c) => c !== external);
  if (!local) throw new Unsupported('parameter without local name');
  const colon = children(node).findIndex((c) => c.type === ':');
  const typeNode = colon < 0 ? undefined : children(node).slice(colon + 1).find((c) =>
    c.isNamed && c.type !== 'parameter_modifiers');
  if (!typeNode) throw new Unsupported('parameter without type');
  const modifierNode = direct(node, 'parameter_modifiers');
  const modifiers = modifierNode ? named(modifierNode).map((c) => normalized(c, source)) : [];
  const name = normalized(local, source);
  return {
    position, label: external ? normalized(external, source) : null, name,
    binding: name === '_' ? 'wildcard' : 'identifier',
    type: { state: 'written', text: normalized(typeNode, source) },
    optional: false, variadic: Boolean(direct(node, '...')),
    default: defaultNode ? normalized(defaultNode, source) : null,
    modifiers,
  };
}

function scopeKind(node: Node): string {
  if (node.type === 'protocol_declaration') return 'protocol';
  const kind = children(node).find((c) => ['class', 'struct', 'enum', 'extension', 'actor'].includes(c.type));
  if (!kind) throw new Unsupported('unknown type scope');
  return kind.type;
}
function declaration(node: Node, source: string, table: ReturnType<typeof buildUtf16ToByteTable>,
  scope: V2Declaration['identity']['scope'], guards: string[]): V2Declaration {
  const isInit = node.type === 'init_declaration';
  const nameNode = children(node).find((c) => field(node, c) === 'name' &&
    (c.type === 'simple_identifier' || c.type === 'init'));
  if (!nameNode && !isInit) throw new Unsupported('function without representable name');
  const name = isInit ? 'init' : normalized(nameNode!, source);
  const params: V2Parameter[] = [];
  for (let i = 0; i < children(node).length; i++) {
    const child = children(node)[i]!;
    if (child.type === 'parameter') {
      const next = children(node)[i + 1];
      const defaultNode = next?.type === '=' ? children(node)[i + 2] : undefined;
      params.push(parameter(child, source, params.length, defaultNode));
    }
  }
  const arrow = children(node).findIndex((c) => c.type === '->');
  const returnNode = arrow < 0 ? undefined : children(node).slice(arrow + 1).find((c) => c.isNamed);
  if (arrow >= 0 && (!returnNode || returnNode.type === 'type_constraints' || returnNode.type === 'function_body')) {
    throw new Unsupported('return type missing');
  }
  const failableNode = isInit ? children(node).find((c) => c.type === '?' || c.type === '!' || c.type === 'bang') : undefined;
  const failable = failableNode?.type === 'bang' ? '!' : failableNode?.type as '?' | '!' | undefined;
  const result: V2Result = isInit ? { kind: 'initializer', failable: failable ?? null } :
    { kind: 'return', type: returnNode ? { state: 'written', text: normalized(returnNode, source) } :
      { state: 'implicit', text: 'Void' } };
  const throwsNode = direct(node, 'throws');
  const throws: V2Throws = { mode: throwsNode?.text === 'rethrows' ? 'rethrows' : throwsNode ? 'throws' : 'none' };
  const modifierNode = direct(node, 'modifiers');
  const genericNode = direct(node, 'type_parameters');
  const constraintNode = direct(node, 'type_constraints');
  const header: V2Header = {
    modifiers: [
      ...(modifierNode ? named(modifierNode).map((c) => normalized(c, source)) : []),
      ...children(node).filter((c) => c.type === 'async').map((c) => normalized(c, source)),
    ],
    generic_parameters: genericNode ? named(genericNode).filter((c) => c.type === 'type_parameter').map((c) => normalized(c, source)) : [],
    constraints: constraintNode ? named(constraintNode).filter((c) => c.type === 'type_constraint').map((c) => normalized(c, source)) : [],
  };
  const labels = params.map((p) => `${p.label ?? p.name}:`).join('');
  const displayName = `${scope.length ? `${scope.map((s) => s.name).join('.')}.` : ''}${name}(${labels})`;
  const identity = { kind: isInit ? 'initializer' : scope.length ? 'method' : 'function', scope, name, guards };
  // The grammar omits an optional protocol requirement semicolon from the node.
  // It is still part of the written declaration's source reference.
  const trailing = /^[ \t]*;/.exec(source.slice(node.endIndex));
  const span = utf16RangeToByteRange(table, node.startIndex, node.endIndex + (trailing?.[0].length ?? 0));
  return {
    identity, displayName, span,
    signature: JSON.stringify([params.map(({ position: _position, ...p }) => p), result, throws, header]),
    parameters: params, result, throws, header,
  };
}

/** One whole-file parse; any ERROR/MISSING or eligible unsupported syntax refuses all rows. */
export function extractSwiftSource(language: Language, source: string, limits: SwiftLimits = {}): SwiftSide {
  const table = buildUtf16ToByteTable(source);
  if (limits.inputBytes !== undefined && table.bytes[table.length]! > limits.inputBytes) return { status: 'tooLarge', limit: 'inputBytes' };
  const parser = new Parser();
  let tree: ReturnType<Parser['parse']> = null;
  try {
    parser.setLanguage(language);
    tree = parser.parse(source);
    if (!tree) throw new Error('Swift parser returned no tree');
    if (tree.rootNode.hasError) return { status: 'incomplete', reason: 'parse-error' };
    let syntaxVisits = 0;
    const stack = [tree.rootNode];
    let malformed = false;
    while (stack.length) {
      const node = stack.pop()!;
      syntaxVisits++;
      if (limits.syntaxVisits !== undefined && syntaxVisits > limits.syntaxVisits) throw new TooLarge('syntaxVisits');
      if (node.isError || node.isMissing) malformed = true;
      for (let i = node.childCount - 1; i >= 0; i--) { const child = node.child(i); if (child) stack.push(child); }
    }
    if (malformed || tree.rootNode.hasError) return { status: 'incomplete', reason: 'parse-error' };
    const declarations: V2Declaration[] = [];
    const visit = (container: Node, scope: V2Declaration['identity']['scope'], guards: string[]): void => {
      const frames: { prior: string[]; active: string }[] = [];
      for (const child of named(container)) {
        if (child.type === 'directive') {
          const text = child.text.trim();
          const match = /^#(if|elseif|else|endif)\b(?:\s+([\s\S]*))?$/.exec(text);
          if (!match) continue; // Nonconditional directives do not change identity.
          const condition = match[2]?.trim();
          if (match[1] === 'if') { if (!condition) throw new Unsupported('empty if'); frames.push({ prior: [condition], active: condition }); }
          else if (match[1] === 'endif') { if (!frames.pop()) throw new Unsupported('unmatched endif'); }
          else {
            const frame = frames.at(-1);
            if (!frame) throw new Unsupported('unmatched conditional');
            const prior = frame.prior.map((c) => `!(${c})`).join(' && ');
            frame.active = match[1] === 'else' ? prior : `${prior} && ${condition}`;
            if (match[1] === 'elseif' && condition) frame.prior.push(condition);
          }
          continue;
        }
        const activeGuards = [...guards, ...frames.map((f) => f.active)];
        if (['function_declaration', 'protocol_function_declaration', 'init_declaration'].includes(child.type)) {
          declarations.push(declaration(child, source, table, scope, activeGuards));
          if (limits.declarations !== undefined && declarations.length > limits.declarations) throw new TooLarge('declarations');
        } else if (child.type === 'class_declaration' || child.type === 'protocol_declaration') {
          const kind = scopeKind(child);
          if (direct(child, 'type_constraints')) throw new Unsupported('constrained extension scope');
          const nameNode = children(child).find((c) => field(child, c) === 'name');
          const body = children(child).find((c) => field(child, c) === 'body');
          if (!nameNode || !body) throw new Unsupported('type scope without name or body');
          visit(body, [...scope, { kind, name: normalized(nameNode, source) }], activeGuards);
        } else if (child.type === 'operator_declaration') throw new Unsupported('operator declaration');
      }
      if (frames.length) throw new Unsupported('unclosed if');
    };
    visit(tree.rootNode, [], []);
    return { status: 'complete', declarations, stats: { declarations: declarations.length, syntaxVisits } };
  } catch (error) {
    if (error instanceof TooLarge) return { status: 'tooLarge', limit: error.limit };
    if (error instanceof Unsupported) return { status: 'incomplete', reason: 'unsupported-construct' };
    throw error;
  } finally { tree?.delete(); parser.delete(); }
}
