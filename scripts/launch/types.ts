/** The contract every launch stage (Stripe, Etsy, store, mailer) implements. */
export interface StageContext {
  env: Record<string, string | undefined>;
  dryRun: boolean;
  fetch: typeof fetch;
  log: (line: string) => void;
  root: string /* repo root */;
}

export interface StageResult {
  stage: string;
  status: 'NEEDS_OWNER' | 'DONE' | 'PARTIAL' | 'FAILED';
  detail: string;
  ownerAction?: string;
  items: Array<{ key: string; state: 'CREATED' | 'EXISTS' | 'UPDATED' | 'WOULD_CREATE' | 'FAILED'; url?: string; note?: string }>;
}
