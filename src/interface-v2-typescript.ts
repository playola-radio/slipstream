/** TypeScript/TSX written function headers for interface.v2. No body inference. */
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Language, Parser, type Node } from 'web-tree-sitter';
import { buildUtf16ToByteTable, utf16RangeToByteRange } from './swift-spans.ts';
import type { Parameter, StructuredDeclaration, StructuredExtraction, TypeRef } from './interface-v2-comparison.ts';

const require = createRequire(import.meta.url);
let initialization: Promise<void> | undefined;
const grammars = new Map<'typescript' | 'tsx', Promise<Language>>();
const GRAMMAR_SHA256 = {
  typescript: '8515404dceed38e1ed86aa34b09fcf3379fff1b4ff9dd3967bcd6d1eb5ac3d8f',
  tsx: '6aa3b2c70e76f5d48eafef1093e9c4de383e13f2fdde2f4e9b98a378f6a8f1b6',
} as const;
const RUNTIME_VERSION = '0.25.10';
const RUNTIME_WASM_SHA256 = 'f38dcc4b43b818f9a0785bc1c6d5611a75ac4cdd428ff3f02757c34ca4e46d7f';

function verifyParserRuntime(): void {
  const root = dirname(require.resolve('web-tree-sitter'));
  const version = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version;
  const actual = createHash('sha256').update(readFileSync(join(root, 'tree-sitter.wasm'))).digest('hex');
  if (version !== RUNTIME_VERSION || actual !== RUNTIME_WASM_SHA256) {
    throw new Error('typescript.v2 parser runtime version or WASM hash mismatch');
  }
}

/** A language_version must never silently select different grammar bytes. */
export function verifyTypeScriptGrammarArtifact(language: 'typescript' | 'tsx',
  expectedSha: string = GRAMMAR_SHA256[language]): Uint8Array {
  const path = require.resolve(`tree-sitter-wasms/out/tree-sitter-${language}.wasm`);
  const bytes = readFileSync(path);
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expectedSha) throw new Error(`${language}.v2 grammar hash mismatch`);
  return bytes;
}

export interface TypeScriptLimits { inputBytes?: number; declarations?: number; syntaxVisits?: number }
export class TypeScriptLimitError extends Error {
  readonly limit: keyof TypeScriptLimits;
  constructor(limit: keyof TypeScriptLimits) { super(`${limit} limit exceeded`); this.limit = limit; }
}
export async function createTypeScriptInterfaceExtractor(language: 'typescript' | 'tsx'):
  Promise<(bytes: Uint8Array, limits?: TypeScriptLimits) => StructuredExtraction> {
  let pending = grammars.get(language);
  if (!pending) {
    pending = (async () => {
      initialization ??= Promise.resolve().then(() => {
        verifyParserRuntime();
        return Parser.init();
      });
      await initialization;
      return Language.load(verifyTypeScriptGrammarArtifact(language));
    })();
    grammars.set(language, pending);
  }
  const grammar = await pending;
  return (bytes, limits) => extract(bytes, grammar, limits);
}

function child(node: Node, type: string): Node | undefined {
  return children(node).find(n => n.type === type);
}

function children(node: Node): Node[] {
  return node.namedChildren.filter((n): n is Node => n !== null && n.type !== 'comment');
}

function field(node: Node, name: string): Node | undefined {
  return node.childForFieldName(name) ?? undefined;
}

/**
 * A wrapped function expression (parenthesized, `as`, `satisfies`, legacy `<T>` angle-bracket
 * assertion) is still an unrepresentable function value. This only unwraps those wrapper shells
 * around a value's own top-level expression — it must not descend into a call's arguments or
 * other nested expressions, or every value that merely contains a callback anywhere inside it
 * would be misclassified as itself an unrepresentable function value.
 */
function containsWrappedFunction(node: Node): boolean {
  let current: Node | undefined = node;
  while (current) {
    if (['arrow_function', 'function_expression', 'generator_function'].includes(current.type)) return true;
    if (!['parenthesized_expression', 'as_expression', 'satisfies_expression', 'type_assertion'].includes(current.type)) return false;
    const kids = children(current);
    // type_assertion is `<T>expr` — the type_arguments come first, so the wrapped expression is last.
    current = current.type === 'type_assertion' ? kids[kids.length - 1] : kids[0];
  }
  return false;
}

/**
 * A unit of pending work for the explicit-stack traversal in `normalizedTokens`. `wrap` marks
 * that once the stack unwinds back to it, every token produced since should be joined (with the
 * normal merge rules) to render one substitution's inner expression, then spliced verbatim
 * (no further spacing) into the enclosing template-literal-type's own raw text — a
 * substitution's internal spacing must never leak into the literal backtick text around it.
 */
type TokenWork =
  | { kind: 'node'; node: Node }
  | { kind: 'literal'; text: string }
  | { kind: 'wrap'; raw: boolean }
  | { kind: 'endWrap' };

/**
 * The grammar omits literal fragments between template type substitutions as nodes; recover
 * them from source gaps. A template-literal substitution can itself contain another template
 * literal type nested arbitrarily deep, so this schedules each substitution's tokenization on
 * the caller's explicit work stack rather than recursing directly — an unbounded recursive
 * depth here would overflow the native call stack. The whole rendered node is pushed back as a
 * single literal token: template-literal-type text is raw source text, not syntax tokens, so it
 * must never pass back through the outer join's spacing rules.
 */
function scheduleTemplateLiteralType(node: Node, stack: TokenWork[]): void {
  const work: TokenWork[] = [{ kind: 'wrap', raw: true }];
  let out = '';
  let cursor = node.startIndex;
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (!c) continue;
    out += node.text.slice(cursor - node.startIndex, c.startIndex - node.startIndex);
    if (c.type === 'template_type') {
      work.push({ kind: 'literal', text: out }, { kind: 'literal', text: '${' },
        { kind: 'wrap', raw: false }, { kind: 'node', node: children(c)[0]! },
        { kind: 'endWrap' }, { kind: 'literal', text: '}' });
      out = '';
    } else {
      out += c.text;
    }
    cursor = c.endIndex;
  }
  out += node.text.slice(cursor - node.startIndex);
  work.push({ kind: 'literal', text: out }, { kind: 'endWrap' });
  for (let i = work.length - 1; i >= 0; i--) stack.push(work[i]!);
}

/**
 * Join syntax leaves, never characters: literals remain intact and identifiers cannot merge.
 * A template-literal substitution's own spacing is resolved eagerly at its `wrap` boundary
 * (see `scheduleTemplateLiteralType`) so it becomes one opaque token before the surrounding
 * join runs — the substitution's internal spacing must never leak into the rules around it.
 */
function normalizedTokens(node: Node): string {
  const tokens: string[] = [];
  const wrapAt: { start: number; raw: boolean }[] = [];
  const stack: TokenWork[] = [{ kind: 'node', node }];
  while (stack.length) {
    const item = stack.pop()!;
    if (item.kind === 'wrap') {
      wrapAt.push({ start: tokens.length, raw: item.raw });
      continue;
    }
    if (item.kind === 'endWrap') {
      const { start, raw } = wrapAt.pop()!;
      const segment = tokens.splice(start, tokens.length - start);
      tokens.push(raw ? segment.join('') : joinTokens(segment));
      continue;
    }
    if (item.kind === 'literal') {
      tokens.push(item.text);
      continue;
    }
    const current = item.node;
    if (current.type === 'comment') continue;
    if (current.type === 'template_literal_type') {
      scheduleTemplateLiteralType(current, stack);
      continue;
    }
    if (current.childCount === 0) {
      tokens.push(current.text);
      continue;
    }
    for (let i = current.childCount - 1; i >= 0; i--) {
      const next = current.child(i);
      if (next) stack.push({ kind: 'node', node: next });
    }
  }
  return joinTokens(tokens);
}

/** Join syntax leaves, never characters: literals remain intact and identifiers cannot merge. */
function joinTokens(tokens: string[]): string {
  let out = '';
  let previous = '';
  const mergeable = new Set(['++', '--', '&&', '||', '??', '==', '!=', '>=', '<=',
    '>>', '<<', '**', '?.', '/*', '//', '=>', '+=', '-=', '*=', '/=',
    '%=', '&=', '|=', '^=']);
  for (const token of tokens) {
    if (!token) continue;
    const word = (value: string): boolean => /[\p{L}\p{N}_$]$/u.test(value);
    const startsWord = (value: string): boolean => /^[\p{L}\p{N}_$]/u.test(value);
    const space = previous === '{' && token !== '}'
      || token === '}' && previous !== '{'
      || previous === ',' || previous === ':'
      || previous === '|' || previous === '&' || previous === '=' || previous === '=>'
      || token === '|' || token === '&' || token === '=' || token === '=>'
      || word(previous) && startsWord(token)
      || mergeable.has(previous.slice(-1) + token[0]);
    if (space && out && !out.endsWith(' ')) out += ' ';
    out += token;
    previous = token;
  }
  return out;
}

function writtenType(annotation: Node | undefined): TypeRef {
  const type = annotation ? children(annotation)[0] : undefined;
  return type ? { state: 'written', text: normalizedTokens(type) }
    : { state: 'unknown', reason: 'inferred-not-computed' };
}

function parseParameters(params: Node | undefined): Parameter[] | null {
  if (!params) return null;
  const result: Parameter[] = [];
  for (const param of children(params)) {
    if (param.type !== 'required_parameter' && param.type !== 'optional_parameter') return null;
    const first = children(param).find(n => n.type !== 'type_annotation' && n.type !== 'accessibility_modifier'
      && n.type !== 'override_modifier'
      && n.type !== 'number' && n.type !== 'string');
    if (!first) return null;
    const rest = first.type === 'rest_pattern';
    const binding = rest ? children(first)[0] : first;
    if (!binding) return null;
    const pattern = binding.type === 'object_pattern' || binding.type === 'array_pattern';
    if (!pattern && binding.type !== 'identifier') return null;
    const modifiers: string[] = [];
    for (let i = 0; i < param.childCount; i++) {
      const token = param.child(i);
      if (token?.type === 'accessibility_modifier' || token?.type === 'readonly'
        || token?.type === 'override_modifier') {
        modifiers.push(normalizedTokens(token));
      }
    }
    const value = field(param, 'value');
    result.push({
      position: result.length, label: null,
      name: pattern ? normalizedTokens(binding) : binding.text,
      binding: pattern ? 'pattern' : 'identifier',
      type: writtenType(field(param, 'type')),
      optional: param.type === 'optional_parameter', variadic: rest,
      default: value ? normalizedTokens(value) : null,
      modifiers,
    });
  }
  return result;
}

function parseDeclaration(node: Node, spanNode: Node, scope: StructuredDeclaration['identity']['scope'],
  wrapperModifiers: string[], table: ReturnType<typeof buildUtf16ToByteTable>,
  bindingName?: string, bindingType?: Node): StructuredDeclaration | null {
  const nameNode = field(node, 'name');
  if (nameNode?.type === 'computed_property_name') return null;
  const name = bindingName ?? nameNode?.text;
  if (!name) return null;
  let isStatic = false;
  for (let i = 0; i < node.childCount; i++) {
    if (node.child(i)?.type === 'static') isStatic = true;
  }
  const constructor = scope.length > 0 && name === 'constructor' && !isStatic;
  const formal = field(node, 'parameters');
  const single = node.type === 'arrow_function' ? field(node, 'parameter') : undefined;
  const params = formal ? parseParameters(formal) : single?.type === 'identifier' ? [{
    position: 0, label: null, name: single.text, binding: 'identifier' as const,
    type: { state: 'unknown' as const, reason: 'inferred-not-computed' as const },
    optional: false, variadic: false, default: null, modifiers: [],
  }] : null;
  if (!params) return null;
  let returnType = writtenType(field(node, 'return_type'));
  let boundGenerics: string[] = [];
  if (bindingType) {
    const functionType = children(bindingType)[0];
    if (!functionType || functionType.type !== 'function_type') return null;
    const typeParams = parseParameters(field(functionType, 'parameters'));
    const typeResult = field(functionType, 'return_type');
    if (!typeParams || typeParams.length !== params.length || !typeResult) return null;
    for (let i = 0; i < params.length; i++) {
      const written = typeParams[i]!.type;
      if (params[i]!.type.state === 'written' && JSON.stringify(params[i]!.type) !== JSON.stringify(written)) return null;
      params[i]!.type = written;
      params[i]!.optional = typeParams[i]!.optional;
      params[i]!.variadic = typeParams[i]!.variadic;
    }
    const boundResult: TypeRef = { state: 'written', text: normalizedTokens(typeResult) };
    if (returnType.state === 'written' && JSON.stringify(returnType) !== JSON.stringify(boundResult)) return null;
    returnType = boundResult;
    const boundGenericNode = child(functionType, 'type_parameters');
    boundGenerics = boundGenericNode ? children(boundGenericNode)
      .filter(n => n.type === 'type_parameter').map(normalizedTokens) : [];
  }
  const modifierNodes: string[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (!c || c.startIndex >= (field(node, 'parameters')?.startIndex ?? node.endIndex)) break;
    if (['async', 'static', 'abstract', 'override_modifier', 'readonly', 'accessibility_modifier',
      'declare', 'default', 'generator', '*', '?'].includes(c.type)) modifierNodes.push(normalizedTokens(c));
  }
  const genericNode = child(node, 'type_parameters');
  const inlineGenerics = genericNode ? children(genericNode).filter(n => n.type === 'type_parameter').map(normalizedTokens) : [];
  if (inlineGenerics.length && boundGenerics.length && JSON.stringify(inlineGenerics) !== JSON.stringify(boundGenerics)) return null;
  const generics = inlineGenerics.length ? inlineGenerics : boundGenerics;
  const kind = constructor ? 'constructor' : scope.length ? 'method' : 'function';
  return {
    identity: { kind, scope, name, guards: [] },
    displayName: scope.length ? `${scope.map(s => s.name).join('.')}.${name}` : name,
    span: utf16RangeToByteRange(table, spanNode.startIndex,
      (node.type === 'method_signature' || node.type === 'abstract_method_signature') && spanNode.nextSibling?.type === ';'
        ? spanNode.nextSibling.endIndex : spanNode.endIndex),
    parameters: params,
    result: constructor ? null : { kind: 'return', type: returnType },
    throws: { mode: 'notExpressible' },
    header: { modifiers: [...wrapperModifiers, ...modifierNodes], generic_parameters: generics, constraints: [] },
    role: node.type.includes('signature') ? 'signature' : 'implementation',
  };
}

function extract(bytes: Uint8Array, grammar: Language, limits?: TypeScriptLimits): StructuredExtraction {
  if (limits?.inputBytes !== undefined && bytes.byteLength > limits.inputBytes) throw new TypeScriptLimitError('inputBytes');
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { status: 'incomplete', reason: 'parse-error' };
  }
  const parser = new Parser();
  let tree: ReturnType<Parser['parse']> = null;
  try {
    parser.setLanguage(grammar);
    tree = parser.parse(source);
    if (!tree || tree.rootNode.hasError) return { status: 'incomplete', reason: 'parse-error' };
    if (limits?.syntaxVisits !== undefined) {
      let visits = 0;
      const pending = [tree.rootNode];
      while (pending.length) {
        const node = pending.pop()!;
        if (++visits > limits.syntaxVisits) throw new TypeScriptLimitError('syntaxVisits');
        for (let i = node.childCount - 1; i >= 0; i--) {
          const next = node.child(i);
          if (next) pending.push(next);
        }
      }
    }
    const table = buildUtf16ToByteTable(source);
    const declarations: StructuredDeclaration[] = [];
    const add = (n: Node, span: Node, scope: StructuredDeclaration['identity']['scope'],
      mods: string[], binding?: string, bindingType?: Node): boolean => {
      const parsed = parseDeclaration(n, span, scope, mods, table, binding, bindingType);
      if (!parsed) return false;
      declarations.push(parsed);
      if (limits?.declarations !== undefined && declarations.length > limits.declarations) throw new TypeScriptLimitError('declarations');
      return true;
    };
    const scan = (node: Node, span = node, mods: string[] = []): boolean => {
      if (node.type === 'export_statement') {
        const inner = children(node).find(n => ['function_declaration', 'function_signature',
          'generator_function_declaration', 'class_declaration', 'abstract_class_declaration',
          'lexical_declaration', 'variable_declaration', 'ambient_declaration'].includes(n.type));
        const exportModifiers: string[] = [];
        for (let i = 0; i < node.childCount; i++) {
          const token = node.child(i);
          if (token?.type === 'export' || token?.type === 'default') exportModifiers.push(token.text);
        }
        if (!inner && children(node).some(n => ['class', 'class_expression', 'module',
          'internal_module', 'statement_block', 'expression_statement'].includes(n.type))) return false;
        return !inner || scan(inner, node, [...exportModifiers, ...mods]);
      }
      if (node.type === 'ambient_declaration') {
        const inner = children(node)[0];
        if (inner && ['module', 'internal_module', 'statement_block'].includes(inner.type)) return false;
        return !inner || scan(inner, span, [...mods, 'declare']);
      }
      if (['function_declaration', 'function_signature', 'generator_function_declaration'].includes(node.type)) {
        return add(node, span, [], mods);
      }
      if (node.type === 'class_declaration' || node.type === 'abstract_class_declaration') {
        const name = field(node, 'name');
        const body = field(node, 'body');
        if (!name || !body) return false;
        const scope = [{ kind: 'class', name: name.text }];
        for (const member of children(body)) {
          if (member.type === 'method_definition' || member.type === 'method_signature'
            || member.type === 'abstract_method_signature') {
            let accessor = false;
            for (let i = 0; i < member.childCount; i++) {
              const token = member.child(i);
              if (token?.type === 'get' || token?.type === 'set') accessor = true;
            }
            if (accessor) continue;
            if (!add(member, member, scope, [])) return false;
          } else if (member.type === 'public_field_definition') {
            const value = field(member, 'value');
            if (value && containsWrappedFunction(value)) return false;
          }
        }
        return true;
      }
      if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
        const declarators = children(node).filter(n => n.type === 'variable_declarator');
        for (const declarator of declarators) {
          const value = field(declarator, 'value');
          if (value?.type === 'class' || value?.type === 'class_expression') return false;
          if (value && ['as_expression', 'satisfies_expression', 'parenthesized_expression', 'type_assertion'].includes(value.type)) {
            if (containsWrappedFunction(value)) return false;
          }
          if (!value || !['arrow_function', 'function_expression', 'generator_function'].includes(value.type)) continue;
          const name = field(declarator, 'name');
          if (!name || name.type !== 'identifier' || declarators.length !== 1) return false;
          const keyword = node.child(0)?.text;
          if (!add(value, span, [], [...mods, ...(keyword ? [keyword] : [])], name.text,
            field(declarator, 'type'))) return false;
        }
        return true;
      }
      if (node.type === 'module' || node.type === 'internal_module'
        || node.type === 'expression_statement' && children(node).some(n => n.type === 'internal_module')) return false;
      return true;
    };
    for (const node of children(tree.rootNode)) {
      if (!scan(node)) return { status: 'incomplete', reason: 'unsupported-construct' };
    }
    return { status: 'complete', declarations };
  } finally {
    tree?.delete();
    parser.delete();
  }
}
