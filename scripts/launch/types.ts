/** The contract every launch stage (Stripe, Etsy, store, mailer, Pinterest) implements. */
export interface StageContext {
  env: Record<string, string | undefined>;
  dryRun: boolean;
  fetch: typeof fetch;
  log: (line: string) => void;
  root: string /* repo root */;
  /** Results of the stages that already ran in this run, in order (set by run.ts). */
  results?: ReadonlyArray<StageResult>;
}

export interface StageResult {
  stage: string;
  /** WAITING: nothing for the owner to do here; the stage waits on another stage's outcome. */
  status: 'NEEDS_OWNER' | 'DONE' | 'PARTIAL' | 'WAITING' | 'FAILED';
  detail: string;
  ownerAction?: string;
  items: Array<{ key: string; state: 'CREATED' | 'EXISTS' | 'UPDATED' | 'WOULD_CREATE' | 'WAITING' | 'FAILED'; url?: string; note?: string }>;
  /** Facts a later stage reads (e.g. the store's live promotion code). */
  outputs?: Record<string, string>;
}
