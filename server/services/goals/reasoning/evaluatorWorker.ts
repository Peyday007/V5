/**
 * One thread of the reasoning evaluator pool (§100): it receives a portfolio
 * input, runs the one pure engine on it, and posts the result back. Niced, so
 * the server's own loop wins every contended slice (scenario/worker.ts).
 */
import { setPriority } from 'node:os';
import { parentPort } from 'node:worker_threads';
import { evaluateGoalPortfolio } from '../portfolio.ts';

try {
  setPriority(19);
} catch {
  /* not permitted here; the evaluation still runs */
}

parentPort!.on('message', (message: { id: number; input: Parameters<typeof evaluateGoalPortfolio>[0] }) => {
  try {
    parentPort!.postMessage({ id: message.id, ok: true, result: evaluateGoalPortfolio(message.input) });
  } catch (error) {
    parentPort!.postMessage({ id: message.id, ok: false, message: error instanceof Error ? error.message : String(error) });
  }
});
