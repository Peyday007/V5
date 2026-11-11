/**
 * One thread of the reasoning evaluator pool (§101): it receives a portfolio
 * input, runs the one pure engine on it, and posts the result back. Niced, so
 * the server's own loop wins every contended slice (scenario/worker.ts).
 */
import { setPriority } from 'node:os';
import { parentPort } from 'node:worker_threads';
import { evaluateGoalPortfolio } from '../portfolio.ts';
import { sweepFor, type SweepJob } from '../reconstruction.ts';

try {
  setPriority(19);
} catch {
  /* not permitted here; the evaluation still runs */
}

parentPort!.on('message', async (message: { id: number; kind?: 'evaluate' | 'sweep'; input?: Parameters<typeof evaluateGoalPortfolio>[0]; job?: SweepJob }) => {
  try {
    // The variable sweep (§102) runs here, off the server's loop; an evaluation is the one engine.
    const result = message.kind === 'sweep' ? await sweepFor(message.job!) : evaluateGoalPortfolio(message.input!);
    parentPort!.postMessage({ id: message.id, ok: true, result });
  } catch (error) {
    parentPort!.postMessage({ id: message.id, ok: false, message: error instanceof Error ? error.message : String(error) });
  }
});
