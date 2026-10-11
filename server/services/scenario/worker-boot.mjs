// The scenario worker's entry point. A worker thread does not inherit the
// TypeScript loader the main thread was started with (`node --import tsx`),
// and passing `--import tsx` in its execArgv is not honoured, so the worker
// registers tsx itself and then loads the real entry. See isolate.ts.
import { register } from 'tsx/esm/api';

register();
await import('./worker.ts');
