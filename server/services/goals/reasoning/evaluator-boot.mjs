// The reasoning evaluator's entry point. A worker thread does not inherit the
// main thread's TypeScript loader, so it registers tsx and loads the real
// entry, exactly as the scenario worker does (scenario/worker-boot.mjs).
import { register } from 'tsx/esm/api';

register();
await import('./evaluatorWorker.ts');
