/**
 * One thread of the reasoning evaluator pool (§101): it receives a portfolio
 * input, runs the one pure engine on it, and posts the result back. Niced, so
 * the server's own loop wins every contended slice (scenario/worker.ts).
 */
import { setPriority } from 'node:os';
import { parentPort } from 'node:worker_threads';
import { evaluateGoalPortfolio } from '../portfolio.ts';
import { sweepFor, type SweepJob } from '../reconstruction.ts';
import type { ConstructionJob } from '../../cash/construct.ts';

try {
  setPriority(19);
} catch {
  /* not permitted here; the evaluation still runs */
}

parentPort!.on('message', async (message: { id: number; kind?: 'evaluate' | 'sweep' | 'construct'; input?: Parameters<typeof evaluateGoalPortfolio>[0]; job?: SweepJob | ConstructionJob }) => {
  try {
    // The variable sweep (§102) and the construction pass (§109) run here, off the server's loop; an evaluation is the one engine.
    const result =
      message.kind === 'sweep'
        ? await sweepFor(message.job as SweepJob)
        : message.kind === 'construct'
          ? await (await import('../../cash/construct.ts')).composeConstruction(message.job as ConstructionJob)
          : evaluateGoalPortfolio(message.input!);
    parentPort!.postMessage({ id: message.id, ok: true, result });
  } catch (error) {
    parentPort!.postMessage({ id: message.id, ok: false, message: error instanceof Error ? error.message : String(error) });
  }
});
