'use client';
/**
 * One task as a card: a short title, what it is for, the objective it serves,
 * its status, who holds it, how long it has taken and what came of it. The
 * full instructions stay one tap away, never on the card itself.
 */
import { StatusPill, TimeAgo } from '@/components/brain/display';
import type { WorkEntryFull } from '@/lib/types';
import { useState } from 'react';

/** The title as a person reads it: the first clause, at most ~90 characters. Presentation only. */
export function shortTitle(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  const stripped = clean
    .replace(/^(establish|find out|determine|research|investigate),?\s+(from published sources,?\s+)?/i, '')
    .replace(/^causal unknown:\s*/i, '');
  const base = stripped.charAt(0).toUpperCase() + stripped.slice(1);
  const cut = base.search(/[.:;?!](\s|$)| — /);
  const first = cut > 20 ? base.slice(0, cut) : base;
  if (first.length <= 90) return first;
  const words = first.slice(0, 90).replace(/\s+\S*$/, '');
  return `${words}…`;
}

function duration(fromIso: string | null, toIso: string | null): string | null {
  if (!fromIso) return null;
  const from = Date.parse(fromIso);
  const to = toIso ? Date.parse(toIso) : Date.now();
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  const m = Math.round((to - from) / 60_000);
  if (m < 60) return `${m} min`;
  const h = m / 60;
  if (h < 48) return `${h.toFixed(h < 10 ? 1 : 0)} h`;
  return `${Math.round(h / 24)} days`;
}

const GROUP_LABEL: Record<string, string> = {
  WORKING_NOW: 'Working now',
  UP_NEXT: 'Up next',
  WAITING: 'Waiting',
  EXPLORING: 'Exploring',
  FINISHED: 'Finished',
};

export function TaskCard({ entry, objective }: { entry: WorkEntryFull; objective: string | null }) {
  const [open, setOpen] = useState(false);
  const card: NonNullable<WorkEntryFull['card']> = entry.card ?? { startedAt: null, finishedAt: null, worker: null, result: null };
  const running = entry.group === 'WORKING_NOW';
  const finished = entry.group === 'FINISHED';
  const spent = duration(card.startedAt, finished ? card.finishedAt : running ? null : card.finishedAt);
  const outcome = entry.blocked ? (entry.waitingOn ?? card.result) : finished ? card.result : (entry.waitingOn ?? null);
  return (
    <li className='min-w-0 rounded-xl border p-4'>
      <div className='flex min-w-0 flex-wrap items-start justify-between gap-2'>
        <h3 className='min-w-0 flex-1 text-sm font-medium break-words text-pretty'>{shortTitle(entry.title)}</h3>
        <StatusPill status={entry.blocked ? 'Blocked' : (GROUP_LABEL[entry.group] ?? entry.state)} tone={entry.blocked ? 'bad' : running ? 'good' : undefined} />
      </div>
      {(card.purpose || (entry.why && entry.why !== entry.title)) && (
        <p className='text-muted-foreground mt-1.5 line-clamp-2 text-sm break-words'>{card.purpose ?? entry.why}</p>
      )}
      <dl className='mt-3 grid grid-cols-1 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-2'>
        <div className='min-w-0'>
          <dt className='text-muted-foreground'>Objective</dt>
          <dd className='break-words'>{card.goalTitle ?? objective ?? 'Not tied to a goal'}</dd>
        </div>
        <div className='min-w-0'>
          <dt className='text-muted-foreground'>Worker</dt>
          <dd className='break-words'>{card.worker ?? (running ? 'Not recorded' : 'Not assigned')}</dd>
        </div>
        <div>
          <dt className='text-muted-foreground'>Time {finished ? 'taken' : running ? 'so far' : 'waiting'}</dt>
          <dd className='tabular-nums'>
            {finished || running ? (spent ?? 'Not recorded') : <TimeAgo at={card.startedAt ?? entry.updatedAt} />}
          </dd>
        </div>
        <div>
          <dt className='text-muted-foreground'>Status</dt>
          <dd>{entry.state.replace(/_/g, ' ').toLowerCase()} · updated <TimeAgo at={entry.updatedAt} /></dd>
        </div>
        {outcome && (
          <div className='min-w-0 sm:col-span-2'>
            <dt className='text-muted-foreground'>{entry.blocked ? 'Blocker' : finished ? 'Result' : 'Waiting on'}</dt>
            <dd className='break-words'>{outcome}</dd>
          </div>
        )}
      </dl>
      <button
        type='button'
        className='text-muted-foreground hover:text-foreground mt-3 text-xs underline-offset-4 hover:underline'
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {open ? 'Hide full instructions' : 'Full instructions'}
      </button>
      {open && (
        <div className='bg-muted/50 mt-2 flex min-w-0 flex-col gap-2 rounded-lg p-3 text-xs'>
          <p className='break-words whitespace-pre-wrap'>{entry.title}</p>
          {entry.why && <p className='text-muted-foreground break-words whitespace-pre-wrap'>{entry.why}</p>}
          {entry.priorityLabel && <p>Priority: {entry.priorityLabel}{entry.priorityReason ? ` — ${entry.priorityReason}` : ''}</p>}
          <dl className='grid gap-1'>
            {entry.how.map((h) => (
              <div key={h.label} className='flex min-w-0 gap-2'>
                <dt className='text-muted-foreground shrink-0'>{h.label}</dt>
                <dd className='min-w-0 font-mono break-all'>{h.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </li>
  );
}
