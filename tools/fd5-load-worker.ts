/** Isolates HTTP load clients from the capture/reader event loop. */
import { parentPort, workerData } from 'node:worker_threads';
import { startContinuousLoad, type HistoricalChange } from '../src/clip-bench.ts';
import { startInterfaceLoad, type CorpusPage } from './fd5-bench.ts';

type Input = { kind: 'clip'; url: string; token: string; corpus: HistoricalChange[]; slots: number }
  | { kind: 'interface'; url: string; token: string; corpus: CorpusPage[]; slots: number };

if (!parentPort) throw new Error('FD5 load worker needs a parent');
const input = workerData as Input;
const load = input.kind === 'clip'
  ? startContinuousLoad(input.url, input.token, input.corpus, input.slots)
  : startInterfaceLoad(input.url, input.token, input.corpus, input.slots);
parentPort.postMessage({ type: 'started', argv1: process.argv[1] });
parentPort.once('message', async (message: unknown) => {
  if (message !== 'stop') throw new Error('FD5 load worker received an unknown command');
  try {
    const summary = await load.stop();
    parentPort!.postMessage({ type: 'summary', summary });
  } catch (error) {
    parentPort!.postMessage({ type: 'error', error: String(error) });
  } finally { parentPort!.close(); }
});
