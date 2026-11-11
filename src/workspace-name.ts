/**
 * The one validator for workspace display names, shared by `name_workspace` and
 * `rename_session`. Rules run in order and the first failure is reported. No
 * Unicode normalization; the stored value is the trimmed string.
 */

export type NameReason = 'not_string' | 'ill_formed' | 'control_character' | 'empty' | 'too_long';

export type NameResult =
  | { ok: true; name: string }
  | { ok: false; reason: NameReason; message: string };

const MAX_NAME_BYTES = 64;
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

function reject(reason: NameReason, message: string): NameResult {
  return { ok: false, reason, message };
}

export function validateName(input: unknown): NameResult {
  if (typeof input !== 'string') return reject('not_string', 'name must be a string');
  if (!input.isWellFormed()) return reject('ill_formed', 'name contains an unpaired surrogate');
  if (CONTROL_RE.test(input)) {
    return reject('control_character', 'name contains a line break or control character');
  }
  const name = input.trim();
  if (name === '') return reject('empty', 'name is empty');
  if (Buffer.byteLength(name, 'utf8') > MAX_NAME_BYTES) {
    return reject('too_long', `name is longer than ${MAX_NAME_BYTES} UTF-8 bytes`);
  }
  return { ok: true, name };
}
