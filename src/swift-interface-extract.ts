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
  | { status: 'complete'; declarations: V2Declaration[] }
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
  const result: string[] = [];
  const pending = [node];
  while (pending.length) {
    const current = pending.pop()!;
    if (current.type === 'comment' || current.type === 'multiline_comment') continue;
    if (current.type.includes('string_literal') || current.type === 'regex_literal' || current.childCount === 0) {
      result.push(source.slice(current.startIndex, current.endIndex));
      continue;
    }
    const parts = children(current);
    for (let i = parts.length - 1; i >= 0; i--) pending.push(parts[i]!);
  }
  return result;
}
/** Canonical token rendering: trivia is discarded, literal contents are atomic. */
function renderTokens(ts: string[]): string {
  let result = '';
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i]!;
    const previous = ts[i - 1];
    const word = (s: string): boolean => /[\p{L}\p{N}_$]$/u.test(s);
    const startsWord = (s: string): boolean => /^[\p{L}\p{N}_$]/u.test(s);
    const operator = (s: string): boolean => /^[&|+*/%=~^-]+$/.test(s);
    const punctuation = (s: string): boolean => /^[!$%&*+./:<=>?@^|~-]+$/.test(s);
    const gap = previous !== undefined && ((word(previous) && startsWord(t)) || previous === ':' || previous === ',' ||
      previous === '->' || t === '->' || operator(previous) || operator(t) ||
      (punctuation(previous) && punctuation(t)));
    if (gap) result += ' ';
    result += t;
  }
  return result;
}
function normalized(node: Node, source: string): string { return renderTokens(tokens(node, source)); }
function identifier(node: Node, source: string): string {
  const written = normalized(node, source);
  return written.startsWith('`') && written.endsWith('`') ? written.slice(1, -1) : written;
}

function writtenType(parts: Node[], source: string, parameter: boolean): string {
  const syntax = parts.filter((c) => c.type !== 'comment' && c.type !== 'multiline_comment' &&
    !(parameter && (c.type === 'parameter_modifiers' || c.type === '...')));
  const types = syntax.filter((c) => c.isNamed);
  if (types.length < 1 || types.length > 2 ||
    (types.length === 2 && types[0]!.type !== 'type_modifiers') ||
    types.at(-1)!.type === 'type_modifiers') throw new Unsupported('type without representable syntax');
  const suffix = syntax.filter((c) => !c.isNamed);
  if (suffix.length > 1 || (suffix.length === 1 &&
    (suffix[0]!.type !== '!' || syntax.at(-1) !== suffix[0]))) throw new Unsupported('unrepresented type suffix');
  return types.map((c) => normalized(c, source)).join(' ') + (suffix.length ? '!' : '');
}

/** The pinned grammar exposes a #if directive as one opaque leaf, so scan its
 * condition into tokens without treating comments or spacing as identity. */
function guardCondition(raw: string): string {
  const result: string[] = [];
  let i = 0;
  while (i < raw.length) {
    if (/\s/u.test(raw[i]!)) { i++; continue; }
    if (raw.startsWith('//', i)) break;
    if (raw.startsWith('/*', i)) {
      let depth = 1;
      i += 2;
      while (i < raw.length && depth) {
        if (raw.startsWith('/*', i)) { depth++; i += 2; }
        else if (raw.startsWith('*/', i)) { depth--; i += 2; }
        else i++;
      }
      if (depth) throw new Unsupported('unclosed directive comment');
      continue;
    }
    const start = i;
    const c = raw[i]!;
    if (c === '"') {
      i++;
      while (i < raw.length) {
        if (raw[i] === '\\') { i += 2; continue; }
        if (raw[i++] === '"') break;
      }
    } else if (/[\p{L}\p{N}_]/u.test(c)) {
      i++;
      while (i < raw.length && /[\p{L}\p{N}_]/u.test(raw[i]!)) i++;
    } else if (/[!$%&*+./:<=>?@^|~-]/.test(c)) {
      i++;
      while (i < raw.length && /[!$%&*+./:<=>?@^|~-]/.test(raw[i]!)) i++;
    } else i++;
    result.push(raw.slice(start, i));
  }
  return renderTokens(result);
}

function parameter(node: Node, source: string, position: number, attributes: Node[], defaultNode?: Node): V2Parameter {
  const parts = children(node);
  const names = parts.filter((c) => c.type === 'simple_identifier');
  const external = parts.find((c) => field(node, c) === 'external_name');
  const local = names.find((c) => c !== external);
  if (!local) throw new Unsupported('parameter without local name');
  const colon = parts.findIndex((c) => c.type === ':');
  if (colon < 0) throw new Unsupported('parameter without type');
  const type = writtenType(parts.slice(colon + 1), source, true);
  const modifierNode = direct(node, 'parameter_modifiers');
  const modifiers = [
    ...attributes.map((attribute) => normalized(attribute, source)),
    ...(modifierNode ? named(modifierNode).map((c) => normalized(c, source)) : []),
  ];
  const name = identifier(local, source);
  return {
    position, label: external ? identifier(external, source) : null, name,
    binding: name === '_' ? 'wildcard' : 'identifier',
    type: { state: 'written', text: type },
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
  const parts = children(node);
  const isInit = node.type === 'init_declaration';
  const nameNode = parts.find((c) => field(node, c) === 'name' &&
    (c.type === 'simple_identifier' || c.type === 'init'));
  if (!nameNode && !isInit) throw new Unsupported('function without representable name');
  const name = isInit ? 'init' : identifier(nameNode!, source);
  const params: V2Parameter[] = [];
  const pendingAttributes: Node[] = [];
  let withinParameters = false;
  for (let i = 0; i < parts.length; i++) {
    const child = parts[i]!;
    if (child.type === '(' && !withinParameters) { withinParameters = true; continue; }
    if (child.type === ')' && withinParameters) {
      if (pendingAttributes.length) throw new Unsupported('parameter attribute without parameter');
      withinParameters = false;
      continue;
    }
    if (child.type === 'attribute' && withinParameters) {
      pendingAttributes.push(child);
      continue;
    }
    if (child.type === 'parameter') {
      const next = parts[i + 1];
      const defaultNode = next?.type === '=' ? parts[i + 2] : undefined;
      params.push(parameter(child, source, params.length, pendingAttributes, defaultNode));
      pendingAttributes.length = 0;
    }
  }
  const arrow = parts.findIndex((c) => c.type === '->');
  const endOfReturn = arrow < 0 ? -1 : parts.findIndex((c, i) => i > arrow &&
    (c.type === 'type_constraints' || c.type === 'function_body'));
  const returnType = arrow < 0 ? null : writtenType(
    parts.slice(arrow + 1, endOfReturn < 0 ? undefined : endOfReturn), source, false);
  const failableNode = isInit ? parts.find((c) => c.type === '?' || c.type === '!' || c.type === 'bang') : undefined;
  const failable = failableNode?.type === 'bang' ? '!' : failableNode?.type as '?' | '!' | undefined;
  const result: V2Result = isInit ? { kind: 'initializer', failable: failable ?? null } :
    { kind: 'return', type: returnType !== null ? { state: 'written', text: returnType } :
      { state: 'implicit', text: 'Void' } };
  const throwsNode = direct(node, 'throws');
  const throws: V2Throws = { mode: throwsNode?.text === 'rethrows' ? 'rethrows' : throwsNode ? 'throws' : 'none' };
  const modifierNode = direct(node, 'modifiers');
  const genericNode = direct(node, 'type_parameters');
  const constraintNode = direct(node, 'type_constraints');
  const header: V2Header = {
    modifiers: [
      ...(modifierNode ? children(modifierNode).map((c) => normalized(c, source)) : []),
      ...parts.filter((c) => c.type === 'class' || c.type === 'static').map((c) => normalized(c, source)),
      ...parts.filter((c) => c.type === 'async').map((c) => normalized(c, source)),
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
          const condition = match[2] === undefined ? undefined : guardCondition(match[2]);
          if (match[1] === 'if') { if (!condition) throw new Unsupported('empty if'); frames.push({ prior: [condition], active: condition }); }
          else if (match[1] === 'endif') { if (!frames.pop()) throw new Unsupported('unmatched endif'); }
          else {
            const frame = frames.at(-1);
            if (!frame) throw new Unsupported('unmatched conditional');
            const prior = frame.prior.map((c) => `!(${c})`).join(' && ');
            if (match[1] === 'elseif' && !condition) throw new Unsupported('empty elseif');
            frame.active = match[1] === 'else' ? prior : `${prior} && (${condition})`;
            if (match[1] === 'elseif') frame.prior.push(condition!);
          }
          continue;
        }
        const activeGuards = [...guards, ...frames.map((f) => f.active)];
        if (['function_declaration', 'protocol_function_declaration', 'init_declaration'].includes(child.type)) {
          declarations.push(declaration(child, source, table, scope, activeGuards));
          if (limits.declarations !== undefined && declarations.length > limits.declarations) throw new TooLarge('declarations');
        } else if (child.type === 'class_declaration' || child.type === 'protocol_declaration') {
          const kind = scopeKind(child);
          if (kind === 'extension' && direct(child, 'type_constraints')) throw new Unsupported('constrained extension scope');
          const nameNode = children(child).find((c) => field(child, c) === 'name');
          const body = children(child).find((c) => field(child, c) === 'body');
          if (!nameNode || !body) throw new Unsupported('type scope without name or body');
          visit(body, [...scope, { kind, name: identifier(nameNode, source) }], activeGuards);
        }
      }
      if (frames.length) throw new Unsupported('unclosed if');
    };
    visit(tree.rootNode, [], []);
    return { status: 'complete', declarations };
  } catch (error) {
    if (error instanceof TooLarge) return { status: 'tooLarge', limit: error.limit };
    if (error instanceof Unsupported) return { status: 'incomplete', reason: 'unsupported-construct' };
    throw error;
  } finally { tree?.delete(); parser.delete(); }
}
