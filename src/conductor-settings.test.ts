import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SettingsError, readLegacyScripts, readTomlScripts, writeTomlScripts } from './conductor-settings.ts';

const P = '/repo/.conductor/settings.toml';

describe('reading Conductor scripts', () => {
  it('reads basic and literal strings from the [scripts] table', () => {
    const text = '[git]\nsetup = "not a script"\n\n[scripts]\nsetup = "npm ci && echo \\"ok\\"" # deps\narchive = \'rm -rf tmp\'\nrun = "npm start"\n';
    assert.deepEqual(readTomlScripts(text, P), { setup: 'npm ci && echo "ok"', archive: 'rm -rf tmp' });
  });

  it('reads nothing from a file without scripts', () => {
    assert.deepEqual(readTomlScripts('# empty\n[ui]\ntheme = "dark"\n', P), {});
  });

  for (const [name, text] of [
    ['a multi-line string', '[scripts]\nsetup = """\nnpm ci\n"""\n'],
    ['a dotted key at the top level', 'scripts.setup = "npm ci"\n'],
    ['an inline table', 'scripts = { setup = "npm ci" }\n'],
    ['a quoted key', '[scripts]\n"setup" = "npm ci"\n'],
    ['a repeated table', '[scripts]\nsetup = "a"\n[scripts]\narchive = "b"\n'],
    ['a non-string value', '[scripts]\nsetup = 3\n'],
    ['a double-quoted scripts header', '["scripts"]\nsetup = "npm ci"\n'],
    ['a single-quoted scripts header', "[ 'scripts' ]\narchive = 'rm -rf tmp'\n"],
    ['an escaped scripts header', '["scr\\u0069pts"]\nsetup = "npm ci"\n'],
    ['an escaped top-level scripts key', '"scr\\u0069pts".setup = "npm ci"\n'],
    ['an escaped script key', '[scripts]\n"s\\u0065tup" = "npm ci"\n'],
    ['a multi-line string elsewhere in the file', '[notes]\ntext = \'\'\'\n[scripts]\nsetup = "x"\n\'\'\'\n'],
    ['a multi-line basic string elsewhere in the file', '[notes]\ntext = \"\"\"\nsetup = "x"\n\"\"\"\n[ui]\nx = 1\n'],
  ] as const) {
    it(`refuses ${name} rather than guess`, () => {
      assert.throws(() => readTomlScripts(text, P), (err: Error) => err instanceof SettingsError && err.message.startsWith(`${P}:`));
    });
  }

  it('still reads a file whose other tables merely resemble scripts', () => {
    const text = '[scripts.extra]\nsetup = "not ours"\n[scripts]\nsetup = "npm ci"\n';
    assert.deepEqual(readTomlScripts(text, P), { setup: 'npm ci' });
  });

  it('reads a legacy conductor.json', () => {
    assert.deepEqual(readLegacyScripts('{"scripts":{"setup":"npm ci","run":"npm start","archive":7}}', '/r/conductor.json'), { setup: 'npm ci' });
    assert.throws(() => readLegacyScripts('{', '/r/conductor.json'), SettingsError);
  });
});

describe('writing Conductor scripts', () => {
  it('replaces existing entries in place and keeps every other line', () => {
    const text = '# mine\n[scripts]\nsetup = "old"  # was\nrun = "npm start"\n\n[ui]\ntheme = "dark"\n';
    const out = writeTomlScripts(text, { setup: 'new "one"' }, P);
    assert.equal(out, '# mine\n[scripts]\nsetup = "new \\"one\\""\nrun = "npm start"\n\n[ui]\ntheme = "dark"\n');
    assert.deepEqual(readTomlScripts(out, P), { setup: 'new "one"' });
  });

  it('adds missing entries to an existing [scripts] table', () => {
    const out = writeTomlScripts('[ui]\nx = 1\n[scripts]\nrun = "r"\n', { setup: 's', archive: 'a' }, P);
    assert.deepEqual(readTomlScripts(out, P), { setup: 's', archive: 'a' });
    assert.match(out, /^\[ui\]\nx = 1\n\[scripts\]\n/);
  });

  it('appends a [scripts] table when there is none', () => {
    assert.equal(writeTomlScripts('', { setup: 's' }, P), '[scripts]\nsetup = "s"\n');
    assert.equal(writeTomlScripts('[ui]\nx = 1\n', { archive: 'a' }, P), '[ui]\nx = 1\n\n[scripts]\narchive = "a"\n');
  });

  it('round-trips a script with a backslash and a quote', () => {
    const script = 'printf "%s\\n" \'it\'"\'"\'s\'';
    assert.deepEqual(readTomlScripts(writeTomlScripts('', { setup: script }, P), P), { setup: script });
  });
});
