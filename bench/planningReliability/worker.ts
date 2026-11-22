/**
 * One planningReliability case process (`pool.ts`). It runs cases the parent hands it,
 * one at a time, through the same `runCase` the serial runner calls, and sends each
 * graded row back. It inherits the parent's environment (`../env.ts` set the data root
 * before the parent loaded anything), so a case sees what it would see serially.
 */
// First: the bench's process environment.
import '../env.ts';
import { runCase } from './index.ts';
import type { FromWorker, ToWorker } from './pool.ts';
import { closeWorldDatabase, type Template } from './world.ts';

let template: Template | null = null;
let dir = '';
const send = (m: FromWorker) => process.send?.(m);

process.on('disconnect', () => process.exit(1));
process.on('message', (raw: ToWorker) => {
  void (async () => {
    if (raw.type === 'init') {
      template = raw.template;
      dir = raw.dir;
      send({ type: 'ready' });
    } else if (raw.type === 'job') {
      const row = await runCase(raw.job, template, template ? null : 'no template database', dir);
      send({ type: 'row', index: raw.job.index, row });
    } else {
      await closeWorldDatabase();
      process.exit(0);
    }
  })();
});
