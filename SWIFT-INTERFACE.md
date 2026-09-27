# Swift written-interface extraction (`swift.v1`)

FD2 implements the Swift language module for `interface.v2`. It compares **written
syntax** in captured UTF-8 blobs. It does not resolve types, evaluate build
settings, inspect function bodies, or infer behavior.

## API and isolation ownership

- `src/swift-interface.ts` exports `SWIFT_V1` and
  `extractSwiftSides([{ id, bytes }], { signal, deadlineMs, limits })`.
  Each result is `complete` with declarations and visit counts, `incomplete`
  with `parse-error` or `unsupported-construct`, or `tooLarge` with the limit.
  An abort or deadline rejects as `SwiftExtractCancelled` or
  `SwiftExtractTimeout`. Other host failures propagate. A pre-aborted signal
  launches no child.
- The parent API batches sides into one invocation of the existing
  `node --liftoff-only` host. Grammar loading and AST traversal occur only in
  that child. The existing `tools/swift-parse.ts` runner owns its deadline,
  abort listener and child cleanup. The prior cancellation demonstration and
  OOM controls remain in place.
- `src/interface-v2-core.ts` exports `compareV2(before, after)`. Its input is
  the extracted `V2Declaration[]` (use `[]` for a recorded absent side). It
  applies D3 duplicate and exact-first correspondence, parameter pairing,
  component deltas and D8 order, returning either `ready` with rows or
  `incomplete` with the duplicate/ambiguity reason. FD2 owns this shared v2
  core; FD1 can import it. The v1 core remains unchanged.
- FD4 owns endpoint resolution, blob retention checks, status precedence,
  admission, routing and response envelopes. It may map per-side extraction
  outcomes without parsing in the daemon process. A host crash or pinned
  artifact failure has no specified §4.4 file status; FD4 must resolve that
  contract gap before mapping such a failure.

## Supported syntax and refusals

The module extracts top-level `func`, members of classes, structs, enums,
actors, protocols and extensions, protocol requirements and `init` (including
`init?` and `init!`). It records written external labels, local names,
defaults, `inout` and other parsed parameter modifiers, variadics, `async`,
`throws`/`rethrows`, generic parameters and `where` constraints. Omitted
`func` returns are `implicit Void`; initializers have the distinct initializer
result, never `-> Self`. Every syntactic `#if` branch is traversed and guards
are part of identity. No branch is evaluated against build settings.

The pinned grammar parses `throws(ErrorType)` with an `ERROR`, so a file using
typed throws is `incomplete / parse-error`. Its known `#Preview` gap has the
same outcome. Any `ERROR` or `MISSING` anywhere refuses the whole file.
Unrepresentable eligible declarations, including operator functions and
constrained extensions, refuse the whole file as `unsupported-construct`.
Invalid UTF-8 is a parse error. A refused side has no declarations or rows.

Published exclusions: anonymous closures, local/nested functions, accessors,
subscripts, macro-generated declarations, deinitializers, shared-type
propagation, effects and behavior. The descriptor also exports this list.
These constructs are outside `swift.v1` extraction; they are not claims that
the file lacks other behavior. A declaration under `#if` has its whole-source
span excluding the enclosing directive lines. Spans use UTF-8 byte offsets,
including any leading BOM bytes and an explicit trailing semicolon when one
is written. Text uses syntax tokens: trivia is dropped, literals remain intact,
and punctuation spacing is canonicalized. Changes in whitespace or comments
alone do not change the written signature.

## Checker

`node tools/swift-extract-check.ts --store <disposable-store> --before
<sha256|absent> --after <sha256|absent>` reads captured CAS blobs, verifies
their hashes, and prints structured status and rows without source bytes or
credentials. It refuses the real store. Exit 0 means `ready`, 1 means a
reported refusal, and 2 means bad input or a host failure. FD2 fixture tests
replay all applicable committed Swift histories from their actual `blobs`
strings; the hand-written `expected.json` files are assertions only.

Cold child timing and provisional admission numbers do not grant D7 approval.
