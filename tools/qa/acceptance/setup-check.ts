/** Finish attach's agent setup check the way a live root chat does: the real
 * PostToolUse hook command delivers the check, and the bound chat returns it
 * through the public answer verb. Questions are refused until this completes. */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { sendControlRequest } from '../../../src/control-client.ts';

export async function completeSetupCheck(opts: {
  store: string;
  harness: 'codex' | 'claude-code';
  callback: { session_id: string; cwd: string } & Record<string, unknown>;
}): Promise<void> {
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ['src/cli.ts', 'hook', opts.harness, 'post-tool-use', '--store', opts.store],
      { stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.setEncoding('utf8').on('data', (s: string) => { out += s; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(out) : reject(new Error(`setup hook exited ${String(code)}`)));
    child.stdin.end(JSON.stringify(opts.callback));
  });
  const context = stdout === '' ? '' : (JSON.parse(stdout) as { hookSpecificOutput: { additionalContext: string } })
    .hookSpecificOutput.additionalContext;
  const checkId = /^Slipstream setup check ([0-9a-f-]{36})\./.exec(context)?.[1];
  if (!checkId) throw new Error('the root hook did not deliver a setup check');
  const ack = await sendControlRequest({ socketPath: join(opts.store, 'control.sock'), request: {
    v: 1, verb: 'answer_question', harness: opts.harness, harness_session_id: opts.callback.session_id,
    worktree: opts.callback.cwd, question_id: checkId, text: 'connected',
  } });
  if (!ack.ok) throw new Error(`setup check answer refused: ${ack.code}`);
}
