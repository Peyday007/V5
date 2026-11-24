'use client';
import PageContainer from '@/components/layout/page-container';
import { Empty, QueryView, StatusPill, TimeAgo } from '@/components/brain/display';
import { Icons } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useBrain } from '@/hooks/use-brain';
import { useHomeProject } from '@/hooks/use-homes';
import { BrainError, enc, post } from '@/lib/brain';
import type { Conversation, Thread } from '@/lib/types';
import { cn } from '@/lib/utils';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

/**
 * Talking to Brain directly. The same Russell conversation routes the console
 * uses: a turn is accepted (202) and answered by Brain's fleet, so the thread is
 * re-read every 4 s while any reply is pending.
 */
export default function ConversationPage() {
  const client = useQueryClient();
  const { projectId } = useHomeProject();
  const list = useBrain<{ conversations: Conversation[] }>('/api/russell/conversations?limit=50', {
    interval: 30_000
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!selected && list.data?.conversations[0]) setSelected(list.data.conversations[0].id);
  }, [list.data, selected]);

  async function create() {
    setCreating(true);
    try {
      const conversation = await post<Conversation>('/api/russell/conversations', {
        title: 'New conversation',
        projectId: projectId ?? null
      });
      await client.invalidateQueries({ queryKey: ['brain', '/api/russell/conversations?limit=50'] });
      setSelected(conversation.id);
    } catch (e) {
      toast.error(e instanceof BrainError ? e.message : 'Could not start a conversation.');
    } finally {
      setCreating(false);
    }
  }

  return (
    <PageContainer
      pageTitle='Brain'
      pageDescription='Ask Brain directly. Replies are produced by Brain and arrive here as they complete.'
      pageHeaderAction={
        <Button onClick={create} disabled={creating}>
          <Icons.add /> New conversation
        </Button>
      }
    >
      <div className='grid min-h-[60vh] gap-4 lg:grid-cols-[18rem_1fr]'>
        <aside className='min-w-0'>
          <QueryView query={list}>
            {({ conversations }) =>
              conversations.length === 0 ? (
                <Empty>No conversations yet. Start one to talk to Brain.</Empty>
              ) : (
                <>
                  <select
                    aria-label='Conversation'
                    className='border-input bg-background h-9 w-full rounded-md border px-2 text-sm lg:hidden'
                    value={selected ?? ''}
                    onChange={(e) => setSelected(e.target.value)}
                  >
                    {conversations.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.title}
                      </option>
                    ))}
                  </select>
                  <ul className='hidden max-h-[70vh] flex-col gap-1 overflow-y-auto lg:flex'>
                    {conversations.map((c) => (
                      <li key={c.id}>
                        <button
                          type='button'
                          onClick={() => setSelected(c.id)}
                          className={cn(
                            'hover:bg-accent w-full rounded-md px-3 py-2 text-left text-sm',
                            selected === c.id && 'bg-accent font-medium'
                          )}
                        >
                          <span className='block truncate'>{c.title}</span>
                          <span className='text-muted-foreground text-xs'>
                            <TimeAgo at={c.updatedAt} />
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )
            }
          </QueryView>
        </aside>
        <section className='flex min-w-0 flex-col rounded-xl border'>
          {selected ? <ThreadView id={selected} /> : <div className='p-6'><Empty>Select or start a conversation.</Empty></div>}
        </section>
      </div>
    </PageContainer>
  );
}

function ThreadView({ id }: { id: string }) {
  const client = useQueryClient();
  const path = `/api/russell/conversations/${enc(id)}?limit=100`;
  const [pendingSeen, setPendingSeen] = useState(false);
  const thread = useBrain<Thread>(path, { interval: pendingSeen ? 4_000 : 30_000 });
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const end = useRef<HTMLDivElement>(null);

  const turns = thread.data?.turns ?? [];
  const pending = turns.some((t) => t.status === 'PENDING');
  useEffect(() => setPendingSeen(pending), [pending]);
  useEffect(() => end.current?.scrollIntoView({ block: 'end' }), [turns.length]);

  async function send(event?: React.FormEvent) {
    event?.preventDefault();
    const content = draft.trim();
    if (!content) return;
    setSending(true);
    try {
      await post(`/api/russell/conversations/${enc(id)}/turns`, { content });
      setDraft('');
      setPendingSeen(true);
      await client.invalidateQueries({ queryKey: ['brain', path] });
    } catch (e) {
      toast.error(e instanceof BrainError ? e.message : 'Brain did not accept that message.');
    } finally {
      setSending(false);
    }
  }

  async function retry(messageId: string) {
    try {
      await post(`/api/russell/conversations/${enc(id)}/turns/${enc(messageId)}/retry`);
      await client.invalidateQueries({ queryKey: ['brain', path] });
    } catch (e) {
      toast.error(e instanceof BrainError ? e.message : 'Retry was refused.');
    }
  }

  return (
    <>
      <div className='border-b px-4 py-3'>
        <p className='truncate text-sm font-medium'>{thread.data?.conversation.title ?? 'Conversation'}</p>
      </div>
      <div className='flex max-h-[60vh] min-h-[40vh] flex-1 flex-col gap-3 overflow-y-auto p-4'>
        <QueryView query={thread}>
          {(data) =>
            data.turns.length === 0 ? (
              <Empty>No messages yet. Ask Brain anything about its work.</Empty>
            ) : (
              <>
                {data.turns.map((t) => (
                  <div
                    key={t.id}
                    className={cn('flex max-w-[85%] flex-col gap-1', t.role === 'USER' ? 'self-end items-end' : 'self-start')}
                  >
                    <div
                      className={cn(
                        'rounded-2xl px-3.5 py-2 text-sm whitespace-pre-wrap text-pretty',
                        t.role === 'USER' ? 'bg-primary text-primary-foreground' : 'bg-muted'
                      )}
                    >
                      {t.status === 'PENDING' && !t.content ? (
                        <span className='text-muted-foreground inline-flex items-center gap-2'>
                          <Icons.spinner className='size-3.5 animate-spin' />
                          {t.pendingDetail ?? 'Brain is working on a reply…'}
                        </span>
                      ) : (
                        t.content
                      )}
                    </div>
                    <div className='text-muted-foreground flex items-center gap-2 text-[11px]'>
                      <TimeAgo at={t.createdAt} />
                      {t.status !== 'COMPLETE' && <StatusPill status={t.status} />}
                      {t.status === 'FAILED' && t.role !== 'USER' && (
                        <button className='underline' type='button' onClick={() => retry(t.id)}>
                          Retry
                        </button>
                      )}
                    </div>
                  </div>
                ))}
                <div ref={end} />
              </>
            )
          }
        </QueryView>
      </div>
      <form onSubmit={send} className='flex items-end gap-2 border-t p-3'>
        <Textarea
          aria-label='Message Brain'
          placeholder='Message Brain…'
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          className='max-h-40 min-h-10 resize-none'
        />
        <Button type='submit' size='icon' disabled={sending || !draft.trim()} aria-label='Send'>
          {sending ? <Icons.spinner className='animate-spin' /> : <Icons.send />}
        </Button>
      </form>
    </>
  );
}
