# Third-party notices

## Capture ignore matching

- [`ignore`](https://github.com/kaelzhang/node-ignore), pinned to 7.0.12.
- **License: MIT.** Copyright (c) 2013 Kael Zhang, contributors.
- The package's full license is distributed in `node_modules/ignore/LICENSE-MIT`.

Third-party components bundled or loaded at runtime, with their licenses kept
distinct. Slipstream is not itself relicensed by anything here.

## Swift grammar feasibility (T5a.3)

Three separate components, three separate licenses. They are **not** the same
project and are not conflated:

### tree-sitter-swift (the grammar)

- Project: [`alex-pinkus/tree-sitter-swift`](https://github.com/alex-pinkus/tree-sitter-swift)
- The grammar compiled into `tree-sitter-swift.wasm`.
- Declared version range: `^0.4.0`. The exact revision baked into the WASM is
  not recoverable from the artifact; the sha256 is the real pin (see
  `SWIFT-GRAMMAR.md`).
- **License: MIT.**

### tree-sitter-wasms (the wrapper that ships the .wasm)

- Package: [`tree-sitter-wasms`](https://www.npmjs.com/package/tree-sitter-wasms) `@0.1.13`
- Ships the prebuilt `out/tree-sitter-swift.wasm` this project loads.
- **License: Unlicense** (public domain dedication). Full text:
  <https://unlicense.org>.

### web-tree-sitter (the runtime)

- Package: [`web-tree-sitter`](https://www.npmjs.com/package/web-tree-sitter) `@0.25.10`
- The Tree-sitter WASM runtime that loads and runs the grammar. Already a
  dependency of the clip parser; T5a.3 reuses it, adding no new runtime pin.
- **License: MIT.**

The MIT-licensed grammar and runtime and the Unlicense-dedicated wrapper are
listed apart on purpose: the wrapper's public-domain dedication does not extend
to the grammar it packages, and vice versa.
