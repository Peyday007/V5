'use client';
/**
 * The few display pieces every page shares, so every page reads the same way.
 *
 * The rule these enforce: a value Brain did not return is shown as "not
 * reported", never as zero and never as a placeholder number. A read that
 * failed says it failed, with Brain's own sentence.
 */
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Icons } from '@/components/icons';
import { BrainError } from '@/lib/brain';
import { cn } from '@/lib/utils';
import type { UseQueryResult } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

export const NOT_REPORTED = 'Not reported';

export function money(cents: number | null | undefined, currency = 'USD'): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return NOT_REPORTED;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: Math.abs(cents) >= 100_000 ? 0 : 2
  }).format(cents / 100);
}

export function num(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NOT_REPORTED;
  return new Intl.NumberFormat('en-US').format(value);
}

export function pct(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NOT_REPORTED;
  return `${Math.round(value * 100)}%`;
}

export function words(value: string | null | undefined): string {
  if (!value) return '';
  return value.toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

function useNow(intervalMs = 5_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function ago(iso: string | number | null | undefined, now = Date.now()): string {
  if (iso === null || iso === undefined || iso === '') return NOT_REPORTED;
  const t = typeof iso === 'number' ? iso : Date.parse(iso);
  if (!Number.isFinite(t)) return String(iso);
  const s = Math.round((now - t) / 1000);
  const future = s < 0;
  const a = Math.abs(s);
  const text =
    a < 45
      ? `${a}s`
      : a < 3600
        ? `${Math.round(a / 60)}m`
        : a < 86400
          ? `${Math.round(a / 3600)}h`
          : `${Math.round(a / 86400)}d`;
  return future ? `in ${text}` : `${text} ago`;
}

export function TimeAgo({ at, className }: { at: string | number | null | undefined; className?: string }) {
  const now = useNow();
  const title = at ? new Date(at).toISOString() : undefined;
  return (
    <time className={cn('tabular-nums', className)} dateTime={title} title={title}>
      {ago(at, now)}
    </time>
  );
}

/** "Updated 12s ago" for one query — the page's proof that it is live. */
export function Freshness({ query }: { query: Pick<UseQueryResult, 'dataUpdatedAt' | 'isFetching'> }) {
  const now = useNow();
  if (!query.dataUpdatedAt) return null;
  return (
    <span className='text-muted-foreground inline-flex items-center gap-1.5 text-xs'>
      <span
        className={cn('size-1.5 rounded-full', query.isFetching ? 'animate-pulse bg-amber-500' : 'bg-emerald-500')}
      />
      Updated {ago(query.dataUpdatedAt, now)}
    </span>
  );
}

const TONES = {
  good: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  warn: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
  bad: 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400',
  info: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-400',
  neutral: 'text-muted-foreground'
} as const;
export type Tone = keyof typeof TONES;

const GOOD = /^(PASS|CONNECTED|AVAILABLE|ACTIVE|LIVE|DONE|COMPLETE|RESOLVED|ACCEPTED|HEALTHY|WORKING|READY|VERIFIED|DELIVERED|ON_TRACK|MET|ANSWERED)/;
const BAD = /(FAIL|REFUSED|UNREACHABLE|BLOCK|QUARANTIN|CANCELLED|NOT_RESOLVED|REJECT|NOT_VIABLE|INFEASIBLE|BROKEN|ERROR|OVERDUE|URGENT|NOT_CONNECTED|EXHAUSTED)/;
const WARN = /(WAIT|PAUSE|NEEDS|REPAIR|HELD|IDLE|LIMITED|PENDING|UNKNOWN|DEGRADED|PARTIAL|AT_RISK|BLOCKING|COOLING|CANDIDATE|UNMEASURED)/;

export function toneOf(status: string | null | undefined): Tone {
  if (!status) return 'neutral';
  const s = status.toUpperCase();
  if (BAD.test(s)) return 'bad';
  if (GOOD.test(s)) return 'good';
  if (WARN.test(s)) return 'warn';
  return 'neutral';
}

export function StatusPill({ status, tone, className }: { status: string | null | undefined; tone?: Tone; className?: string }) {
  if (!status) return <Badge variant='outline' className={cn(TONES.neutral, className)}>{NOT_REPORTED}</Badge>;
  return (
    <Badge variant='outline' className={cn('whitespace-nowrap', TONES[tone ?? toneOf(status)], className)}>
      {words(status)}
    </Badge>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: Tone;
}) {
  return (
    <Card size='sm' className='min-w-0'>
      <CardHeader>
        <CardDescription className='truncate'>{label}</CardDescription>
        <CardTitle
          className={cn(
            'truncate text-xl font-semibold tabular-nums md:text-2xl',
            tone === 'bad' && 'text-red-600 dark:text-red-400',
            tone === 'good' && 'text-emerald-600 dark:text-emerald-400',
            tone === 'warn' && 'text-amber-600 dark:text-amber-400'
          )}
        >
          {value}
        </CardTitle>
      </CardHeader>
      {hint && <CardContent className='text-muted-foreground -mt-2 text-xs text-pretty'>{hint}</CardContent>}
    </Card>
  );
}

export function Panel({
  title,
  description,
  action,
  children,
  className,
  flush
}: {
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  flush?: boolean;
}) {
  return (
    <Card className={cn('min-w-0', className)}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription className='text-pretty'>{description}</CardDescription>}
        {action && <CardAction>{action}</CardAction>}
      </CardHeader>
      <CardContent className={cn('min-w-0', flush && 'px-0')}>{children}</CardContent>
    </Card>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className='text-muted-foreground flex items-center gap-2 rounded-lg border border-dashed px-4 py-6 text-sm'>
      <Icons.circle className='size-4 shrink-0 opacity-50' />
      <span className='text-pretty'>{children}</span>
    </div>
  );
}

export function Failure({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  const retryable = error instanceof BrainError && error.retryable;
  const forbidden = error instanceof BrainError && (error.status === 404 || error.status === 403);
  const refused = error instanceof BrainError && error.status === 422;
  if (refused) {
    return (
      <div role='status' className={cn('flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3 text-sm', TONES.neutral)}>
        <Icons.lock className='size-4 shrink-0' />
        <span className='min-w-0 flex-1 text-pretty'>
          Brain did not return this reading for your account ({error.message.replace(/\.$/, '')}). Operator readings need
          operator rights on the goal's project.
        </span>
      </div>
    );
  }
  return (
    <div
      role='alert'
      className={cn(
        'flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3 text-sm',
        retryable ? TONES.warn : TONES.bad
      )}
    >
      <Icons.alertCircle className='size-4 shrink-0' />
      <span className='min-w-0 flex-1 text-pretty'>
        {forbidden
          ? 'Brain did not return this for your account. It is either not there or not yours to read.'
          : error.message}
        {retryable && ' Retrying automatically.'}
      </span>
      {onRetry && (
        <Button size='sm' variant='outline' onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

/** Loading, failed or loaded — one shape for every read on every page. */
export function QueryView<T>({
  query,
  children,
  rows = 3
}: {
  query: UseQueryResult<T, Error>;
  children: (data: T) => React.ReactNode;
  rows?: number;
}) {
  if (query.isPending) {
    return (
      <div className='flex flex-col gap-2' role='status' aria-label='Loading'>
        {Array.from({ length: rows }, (_, i) => (
          <Skeleton key={i} className='h-10 w-full' />
        ))}
      </div>
    );
  }
  if (query.isError && query.data === undefined) {
    return <Failure error={query.error} onRetry={() => void query.refetch()} />;
  }
  return (
    <>
      {query.isError && <Failure error={query.error} onRetry={() => void query.refetch()} />}
      {children(query.data as T)}
    </>
  );
}

/** A label/value list for the fields Brain returned. */
export function Facts({ items }: { items: { label: string; value: React.ReactNode }[] }) {
  return (
    <dl className='grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2'>
      {items.map((item) => (
        <div key={item.label} className='flex min-w-0 justify-between gap-3 border-b py-1.5 last:border-0 sm:[&:nth-last-child(2)]:border-0'>
          <dt className='text-muted-foreground shrink-0'>{item.label}</dt>
          <dd className='min-w-0 truncate text-right font-medium tabular-nums'>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Raw JSON for a section whose shape Brain may extend; behind a toggle, never primary. */
export function Details({ value, label = 'Details' }: { value: unknown; label?: string }) {
  return (
    <details className='group text-xs'>
      <summary className='text-muted-foreground hover:text-foreground cursor-pointer select-none'>{label}</summary>
      <pre className='bg-muted mt-2 max-h-80 overflow-auto rounded-md p-3 font-mono text-[11px] leading-relaxed'>
        {JSON.stringify(value, null, 2)}
      </pre>
    </details>
  );
}
