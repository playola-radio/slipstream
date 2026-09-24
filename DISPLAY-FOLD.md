# `display-fold.v1` — the display fold contract

This document defines how a client turns a session's published event records into
the state it displays. `src/display-fold.ts` implements it. The hand-written corpus
under `contracts/display-fold/v1/` is its executable form, and
`node tools/projection-check.ts fold` is the oracle a client (e.g. the Swift app)
compares its own fold against.

Sources: `STAGE-T-PREREQS.md` Part 2 and the T0 decisions D1, D8, and D9 (ratified in
PR #24).

## Scope: four components, not the whole session (D1)

`display-fold.v1` covers exactly **attributions, evidence, coverage, and gaps**.

It does **not** cover baseline, file inventory, or task grouping. Those are Stage T
work (T2a) and will be specified separately. A session that holds only baseline and
file-change records folds to four empty arrays:

```json
{"contract":"display-fold.v1","result":"ok","state":{"attributions":[],"coverage":[],"evidence":[],"gaps":[]}}
```

Agreement on this contract is **never whole-session parity**. Do not advertise it as
such.

## Input

The input is a sequence of already-parsed JSON records, in any order: the finite
replay, an SSE stream, or a mix, with or without transport duplicates.

- **Identity.** A record's identity is `(source, seq)`.
  - `source` is a non-empty string.
  - `seq` is a canonical decimal string (`^[1-9][0-9]*$`) of any length. Seqs compare
    numerically, by length first and then code unit, and are never converted to
    `Number`.
  - Every seq inside `data` that the fold reads is handled the same way.
- **Envelope.** A record with an identity must also carry a string `type` and an
  object `data`.
- **Consumed types.** The contract interprets five types:
  - `slipstream.file.changed.v1`
  - `slipstream.change.attribution.v1`
  - `slipstream.harness.evidence.v1`
  - `slipstream.enrichment.coverage.v1`
  - `slipstream.capture.gap.v1`

  For the last four, the fields the fold reads must have the shape their schema gives
  them (enums, strings, seq strings). Fields the fold does not read are not checked.
  A file change is used only as an attribution target.
- **Attribution `change_seq`.** An attribution's `change_seq` is a seq string,
  validated the same way as `policy_seq`: it must match `^[1-9][0-9]*$`. A
  non-canonical `change_seq` makes the attribution record itself invalid, before
  target rejection is considered.
- **Timestamps.** The only timestamp the fold reads is evidence `timestamp.at_ms`. It
  must be an integer. Outside `0..Number.MAX_SAFE_INTEGER` it is
  `timestamp-out-of-range`. Timestamps the fold does not read (gap and change
  `observed_at_ms`, observation intervals) are not validated.
- **Unknown types** are ignored, including unconsumed `slipstream.*` types at any
  version, which keeps the contract forward-compatible.

## Result envelope

The fold always produces exactly one of these four results:

| `result` | Shape | Meaning |
|---|---|---|
| `ok` | `{contract, result, state}` | The four components. |
| `invalid` | `{contract, result, error:{reason, source?, seq?}}` | `invalid-record` or `timestamp-out-of-range`. A record with no usable identity gives `{reason:"invalid-record"}` with no source or seq. |
| `corrupt` | `{contract, result, error:{reason:"conflicting-records", source, seq}}` | Two different records share one identity. |
| `unsupported` | `{contract, result, error:{reason:"unsupported-event-version", source, seq, type}}` | A consumed family at a version other than `v1`. |

- A refusal carries **no state**. A partial fold is never shown as good.
- **Precedence:** `invalid` > `corrupt` > `unsupported`.
- Within `invalid`, an identity-less record wins. Otherwise the smallest identity is
  reported: `source` first, then `seq` numerically.
- The result never depends on delivery order.

### Duplicate vs conflict

Records are compared **whole**:

- object key order is irrelevant;
- array order matters;
- `-0` equals `0`.

A record identical to one already seen is a transport duplicate. It is dropped, so a
redelivered gap never appears twice. A different record with the same identity is
**corruption**. The fold never picks the newest.

### Unknown vs unsupported

The two cases are handled differently:

- **Unknown:** a type outside the five consumed families. It is ignored.
- **Unsupported:** `slipstream.<consumed family>.v<anything but 1>`. It is refused.
  This includes `v2`, `v01`, and `vNext`.

## Component rules

**Attributions** use the existing `foldAttributions` (`src/attribution.ts`), which
already defines valid targets:

- The target exists as a `file.changed.v1` in the same source.
- The target precedes the attribution.
- The highest valid attribution seq replaces the earlier ones wholesale.

An attribution with a rejected target is **ignored**, not a failure.

- Row fields: `source`, `change_seq`, `attribution_seq`, `policy_seq`, `status`,
  `reason`, `evidence_seqs`, and `excluded_conflicts` when published.
- No `pending` row is ever synthesized.

**Evidence** uses the existing `foldEvidence`, applied **per source**. The same
evidence key in two sessions gives two rows. The per-source grouping lives only in
`display-fold.ts`, so the daemon's single-session use of `foldEvidence` is unchanged.

- Row fields: `source`, `harness`, `harness_session_id`, `record_id`,
  `evidence_seqs`, `min_at_ms`, `max_at_ms`, `known_paths`, `conflicted`.

**Coverage** keeps the highest-seq record per `(source, harness)`, which replaces
earlier ones wholesale.

- `issues` are preserved, duplicates included.
- A harness with no record has **no row**. Absence means unknown; success is never
  synthesized.
- Row fields: `source`, `harness`, `seq`, `state`, and `issues` when published.

**Gaps** are the published gap records, as recorded. The fold never infers them,
heals them, or scores completeness.

- Row fields: `source`, `seq`, `reason`, `scope`, and `episode_id` when published.
- `observed_at_ms` is not part of the row.

Scoring (`src/attribution-scoring.ts`, which moved out of `attribution.ts` under D9)
is **not** part of this contract.

## Canonical output

The output depends only on the set of distinct valid records.

**Sort orders**

| Data | Sorted by |
|---|---|
| Attributions | `(source, change_seq)` |
| `evidence_seqs` | numeric |
| `excluded_conflicts` | `(harness, harness_session_id, record_id)` |
| Evidence | `(source, harness, harness_session_id, record_id)` |
| `known_paths` | unique values, in code-unit order |
| Coverage | `(source, harness)` |
| `issues` | `(kind, detail)` |
| Gaps | `(source, seq)` |

**Strings** are compared exactly, by UTF-16 code unit (JavaScript `<`). They are
never passed through `localeCompare` and never normalized. So `é` and `é` are
different strings, and an astral character sorts before `～`.

**Optional fields:**

- A field absent from the input is absent from the row.
- An explicitly empty array stays present.
- Rows are built from named fields only, so unknown input fields never leak into the
  output.

**Serialization (`canonicalJson`):**

- Object keys are sorted by UTF-16 code unit at every depth. This includes
  integer-like keys, which plain `JSON.stringify` would reorder.
- No whitespace.
- String escaping follows `JSON.stringify`, so lone surrogates are escaped.
- Numbers must be safe integers, and `-0` is written as `0`.
- Anything else throws.
- The oracle prints `canonicalJson(result)` plus `\n`.

## What `ok` does not certify

`ok` means the given records fold cleanly. It does **not** mean the replay was
complete: the fold imposes no contiguity or first-seq requirement. Proving delivery
completeness through a high-water mark belongs to the reader client (T1b). The fold
of a stream truncated at the finite replay's `slipstream-durable-seq` is the
interpretation of that prefix.

## Oracle

```sh
node tools/projection-check.ts fold --fixture revision-and-gap
node tools/projection-check.ts fold --events path/to/events.ndjson
curl -s -H "authorization: Bearer $TOKEN" "$URL/v1/sessions/$SID/events?after=0" \
  | node tools/projection-check.ts fold --events -
```

- The command takes exactly one of `--fixture <name>` or `--events <path|->`.
- Input is NDJSON. Blank lines are skipped, CRLF is accepted, and the last line may
  lack a newline.
- All input is parsed before folding.

| Exit code | Meaning |
|---|---|
| `0` | `ok` |
| `1` | The fold refused. The envelope is still printed. |
| `2` | Bad arguments, a missing fixture, unreadable input, invalid UTF-8, or malformed JSON. Nothing goes to stdout; the problem line is named by number but never quoted. |

**Corpus layout:** `contracts/display-fold/v1/<case>/input.ndjson` and
`expected.json`.

- The data is synthetic.
- Every expected output was written by hand, **never** generated by running the
  code.
- Cases that expect a rejection count as passing when the fold rejects as specified.

## Not in this version (T0.2)

T0.2 adds:

- the `Slipstream-Fold-Contract: display-fold.v1` response header on finite and SSE
  replies;
- immutable released manifests and implementation fingerprints;
- the CI change gate.

Until then the reader sends no contract header. A client learns the contract only
from this document and the oracle.

## Honesty

This contract is **release enforcement, not a mathematical proof**. It has residual
risks:

- dependency omissions;
- inadequate fixtures;
- a bypassed release gate.

Version checking detects a **declared** incompatibility. It cannot discover an
**undeclared** semantic change.

## Decision record (Codex consult, 2026-09-23)

Architected with Codex (consult mode), then refined:

1. **Envelope.**
   - Results are `ok`, `invalid`, `corrupt`, or `unsupported`, and a refusal carries
     no state.
   - Precedence is invalid > corrupt > unsupported, independent of order. An
     identity-less record wins; otherwise the smallest identity is reported.
   - Transport equality compares whole parsed records.
   - `ok` imposes no contiguity requirement.
2. **Canonical sorts and serializer** as above. Keys are sorted by code unit in the
   serializer itself, not by pre-sorting an object and calling `JSON.stringify`, which
   reorders integer-like keys.
3. **Per-source evidence** lives only in `display-fold.ts`, and `foldEvidence` is
   called unmodified per group.
4. **D9 split.** `EvaluationInput`, `EvaluationResult`, `evaluateChange`,
   `windowOverlaps`, `touchesPath`, `attributionResultsEqual`, and `sameStringSet`
   moved to `src/attribution-scoring.ts` with no re-export. The public folds stayed.
   The move changed no behavior, and the full suite passed before and after.
5. **Oracle CLI.**
   - One selector.
   - Exit codes 0/1/2 as above; exit 2 prints nothing on stdout.
   - Malformed lines are reported by number and never quoted.
   - Malformed-NDJSON cases live in the CLI tests, not in the corpus.
6. **Scope warnings accepted:**
   - no synthesized pending rows;
   - scoring's `keyStr` ordering is not reused for display order (JSON-encoded keys
     sort differently from component-wise order for `"` and `\`);
   - rejected attribution targets are ignored;
   - no headers, manifests, or fingerprints;
   - live acceptance must prove receipt of every identity through H, because two empty
     folds matching proves nothing.

**Deviation from the consult:** timestamp range checks apply only to evidence
`timestamp.at_ms`, the one timestamp the fold reads. Unread timestamps are not
validated, which keeps the contract minimal and forward-compatible.
