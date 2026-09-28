# TypeScript/TSX written function extraction (`typescript.v2`)

FD1 implements only the language side of `interface.v2`. The contract remains
`FUNCTION-CHANGES.md` and `contracts/interface/v2/schema.json`. The daemon's
recorded-range resolver and HTTP service are separate FD3/FD4 work.

## Callable boundary

`createTypeScriptInterfaceExtractor('typescript' | 'tsx')` in
`src/interface-v2-typescript.ts` loads the pinned grammar once and returns a
synchronous function over one **whole captured UTF-8 blob** (`Uint8Array`). It
returns complete structured declarations or an incomplete reason (`parse-error`
or `unsupported-construct`). Invalid UTF-8, any Tree-sitter ERROR/MISSING node,
or an unrepresentable eligible construct makes the entire side incomplete.

`compareStructuredExtractions(before, after)` in
`src/interface-v2-comparison.ts` accepts complete, absent, or incomplete sides.
It performs D3 exact-first matching, duplicate/ambiguity checks, parameter
pairing, and component comparison, returning `status`, optional
`fallback_reason`, and `changes`. FD4 selects recorded blobs, handles unavailable
and identical endpoints, then adds path, provenance, coverage and admission.
The comparator reuses v1's D3/D8 `compare` function through a canonical
structured-header key; `interface.v1` remains unchanged.

## Supported syntax and limits

- Top-level named function declarations, generator declarations and overload
  signatures; `declare` and `export`/`default` wrappers.
- Named `const`/`let`/`var` bindings whose value is directly an arrow or function
  expression, including TSX components. One-parameter arrows and inline
  function-type annotations on bindings are supported.
- Methods and constructors in named class and abstract class declarations,
  including their overload signatures. Written parameter properties, generics, modifiers,
  optional/rest/default syntax, and written returns are retained.
- A destructuring pattern is one parameter. Omitted return annotations are
  `unknown / inferred-not-computed`; TypeScript throws is `notExpressible`.
- Source spans are half-open UTF-8 byte offsets. Trivia is removed through
  syntax leaves; literal bytes and token boundaries remain significant.

The extractor excludes anonymous callbacks, local/nested functions, accessors,
interface method signatures, object-literal methods, generated declarations,
decorators as a source of function input/output changes, and function values
hidden behind calls such as `memo(...)`. It never infers types from bodies or
follows shared types. Any namespace, module, or `declare global` block is
currently `unsupported-construct`. Values wrapped in casts, `satisfies`, or
parentheses are `unsupported-construct` when they contain eligible functions.
A direct class-expression binding,
computed method name, class-field function, opaque function-type alias on a
function binding, `this` parameter, decorated parameter, or eligible syntax this module cannot represent is
`unsupported-construct` for the entire file. This is a syntax-only subset, not
an assertion that excluded code has no callable behavior.

The grammar artifacts and Tree-sitter runtime are pinned by version/SHA-256 in
the loader. A changed WASM under `typescript.v2` fails to load. The checker command
`node tools/projection-check.ts interface-v2 --lang typescript` creates a
disposable blob store and compares parser output with the hand-written corpus:
28 source-bearing file comparisons across 27 case directories, plus synthetic
TSX and comment-bearing TypeScript pairs. It does not claim FD3
endpoint/provenance validation.
