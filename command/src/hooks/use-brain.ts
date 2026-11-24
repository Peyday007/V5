'use client';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { BrainError, brain, readTool } from '@/lib/brain';

/** How often a page re-reads Brain while it is open. */
export const LIVE_INTERVAL_MS = 20_000;

const retry = (failures: number, error: Error) =>
  error instanceof BrainError && error.retryable && failures < 4;
const retryDelay = (attempt: number) => Math.min(30_000, 2_000 * 2 ** attempt);

/** A Brain route, re-read every `interval` ms while the page is visible. */
export function useBrain<T>(
  path: string | null,
  options: { interval?: number | false } = {}
): UseQueryResult<T, Error> {
  return useQuery<T, Error>({
    queryKey: ['brain', path],
    queryFn: () => brain<T>(path as string),
    enabled: !!path,
    refetchInterval: options.interval === undefined ? LIVE_INTERVAL_MS : options.interval,
    refetchIntervalInBackground: false,
    retry,
    retryDelay
  });
}

/** A read-only operator tool, re-read like a route. */
export function useTool<T>(
  tool: string | null,
  args: Record<string, string> = {},
  options: { interval?: number | false } = {}
): UseQueryResult<T, Error> {
  return useQuery<T, Error>({
    queryKey: ['tool', tool, args],
    queryFn: () => readTool<T>(tool as string, args),
    enabled: !!tool,
    refetchInterval: options.interval === undefined ? LIVE_INTERVAL_MS * 2 : options.interval,
    refetchIntervalInBackground: false,
    retry,
    retryDelay
  });
}
