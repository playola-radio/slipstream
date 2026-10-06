import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

/**
 * The published `bin` map is a packaging contract: harnesses launch the MCP
 * forwarder by name, so a missing or mistargeted `slipstream-mcp` entry means a
 * plain `npm install -g` can watch a worktree but never wire the forwarder into
 * Claude Code or Codex. Both commands must point at compiled `dist/` JavaScript —
 * Node refuses type stripping under `node_modules`, so a `src/*.ts` target would
 * fail to launch once installed.
 */
test('package.json exposes both bin commands as compiled dist entrypoints', async () => {
  const manifestPath = fileURLToPath(new URL('../package.json', import.meta.url));
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { bin?: Record<string, string> };

  assert.deepEqual(manifest.bin, {
    slipstream: './dist/cli.js',
    'slipstream-mcp': './dist/mcp-forwarder.js',
  });
});
