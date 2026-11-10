/**
 * Historical memory: what Brain recovered from the person's conversation
 * history, and what it thinks deserves another look.
 *
 * Every sentence on this page is the server's — why an idea matters, why now,
 * what happened afterwards — and each discovery links to the conversations it
 * came from. The page renders and asks; it never decides.
 */
import { useCallback, useEffect, useState } from 'react';
import JSZip from 'jszip';
import { MemoryApi } from '../lib/memoryApi.ts';
import type {
  ConversationRecord,
  CoverageReport,
  DiscoveryView,
  HubView,
  IdeaDetail,
  IdeaSummary,
  MemoryDecision,
  MemorySearchHit,
  MovieSchoolFoundation,
  TopicHistory,
  TopicNode,
} from '../lib/memoryApi.ts';
import { uploadArchive, type ArchiveEntrySource, type UploadProgress, type UploadSummary } from '../../../server/services/memory/upload.ts';

type Tab = 'DISCOVERIES' | 'IDEAS' | 'TOPICS' | 'HUBS' | 'SEARCH' | 'IMPORT';
const TABS: { key: Tab; label: string }[] = [
  { key: 'DISCOVERIES', label: 'Discoveries' },
  { key: 'IDEAS', label: 'Ideas & goals' },
  { key: 'TOPICS', label: 'Topics' },
  { key: 'HUBS', label: 'Hubs & Movie School' },
  { key: 'SEARCH', label: 'Search' },
  { key: 'IMPORT', label: 'Import & coverage' },
];

const CHOICES: { decision: MemoryDecision; letter: string; label: string }[] = [
  { decision: 'EXPLORE', letter: 'A', label: "I'm still interested — explore this" },
  { decision: 'PLAN', letter: 'B', label: 'Turn this into a concrete game plan' },
  { decision: 'CREATE_SECTION', letter: 'C', label: 'Create a dedicated project' },
  { decision: 'LATER', letter: 'D', label: 'Save this for later' },
  { decision: 'NOT_INTERESTED', letter: 'E', label: "I'm no longer interested" },
  { decision: 'UPDATE_WANT', letter: 'F', label: 'Update what I actually want' },
];

function when(iso: string | null | undefined): string {
  if (!iso) return 'unknown date';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'unknown date' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function period(first: string | null, last: string | null): string {
  if (!first && !last) return 'date unknown';
  if (first?.slice(0, 7) === last?.slice(0, 7)) return when(first);
  return `${when(first)} – ${when(last)}`;
}

function useLoad<T>(load: () => Promise<T>, deps: unknown[]): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setError(null);
    load().then(
      (value) => live && setData(value),
      (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data, error, reload: () => setTick((t) => t + 1) };
}

export function MemoryView(): JSX.Element {
  const [tab, setTab] = useState<Tab>('DISCOVERIES');
  const [ideaId, setIdeaId] = useState<string | null>(null);
  const [conversation, setConversation] = useState<{ id: string; passageId?: string } | null>(null);
  const openIdea = useCallback((id: string) => {
    setConversation(null);
    setIdeaId(id);
  }, []);
  const openConversation = useCallback((id: string, passageId?: string) => setConversation({ id, passageId }), []);

  return (
    <section className="rs-panel rs-memory" aria-labelledby="rs-memory-title">
      <h2 id="rs-memory-title">Historical memory</h2>
      <p className="rs-quiet">
        Your conversation history, recovered and organized — and the ideas in it that may deserve another look.
      </p>
      <div className="rs-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} onClick={() => { setTab(t.key); setIdeaId(null); setConversation(null); }}>
            {t.label}
          </button>
        ))}
      </div>
      {conversation ? (
        <ConversationPanel conversationId={conversation.id} passageId={conversation.passageId} onClose={() => setConversation(null)} />
      ) : ideaId ? (
        <IdeaPanel ideaId={ideaId} onClose={() => setIdeaId(null)} onOpenConversation={openConversation} onOpenIdea={openIdea} />
      ) : (
        <>
          {tab === 'DISCOVERIES' ? <Discoveries onOpenIdea={openIdea} onOpenConversation={openConversation} /> : null}
          {tab === 'IDEAS' ? <Ideas onOpenIdea={openIdea} /> : null}
          {tab === 'TOPICS' ? <Topics onOpenIdea={openIdea} onOpenConversation={openConversation} /> : null}
          {tab === 'HUBS' ? <Hubs onOpenIdea={openIdea} onOpenConversation={openConversation} /> : null}
          {tab === 'SEARCH' ? <SearchTab onOpenIdea={openIdea} onOpenConversation={openConversation} /> : null}
          {tab === 'IMPORT' ? <ImportTab /> : null}
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
function Discoveries({ onOpenIdea, onOpenConversation }: { onOpenIdea(id: string): void; onOpenConversation(id: string, p?: string): void }): JSX.Element {
  const { data, error, reload } = useLoad(() => MemoryApi.discoveries('OPEN'), []);
  if (error) return <p className="rs-state rs-state-error">{error}</p>;
  if (!data) return <p className="rs-state rs-state-loading">Reading your discoveries…</p>;
  if (data.discoveries.length === 0) {
    return (
      <p className="rs-state rs-state-empty">
        Nothing to bring back right now. Discoveries appear once a history has been imported and read — see Import &amp; coverage.
      </p>
    );
  }
  return (
    <div className="rs-list">
      {data.discoveries.map((d) => (
        <DiscoveryCard key={d.id} discovery={d} onDecided={reload} onOpenIdea={onOpenIdea} onOpenConversation={onOpenConversation} />
      ))}
    </div>
  );
}

function DiscoveryCard({
  discovery: d,
  onDecided,
  onOpenIdea,
  onOpenConversation,
}: {
  discovery: DiscoveryView;
  onDecided(): void;
  onOpenIdea(id: string): void;
  onOpenConversation(id: string, p?: string): void;
}): JSX.Element {
  return (
    <article className="rs-card rs-discovery">
      <p className="rs-card-title">{d.title}</p>
      <p className="rs-quiet">
        {d.kind.toLowerCase()} · {period(d.period.first, d.period.last)} · {d.unresolved ? 'unresolved' : d.state.toLowerCase()}
      </p>
      <p className="rs-item-meta"><strong>What you said:</strong> {d.originally}</p>
      <p className="rs-item-meta"><strong>Why it matters:</strong> {d.whyMatters}</p>
      <p className="rs-item-meta"><strong>What happened afterwards:</strong> {d.afterwards}</p>
      <p className="rs-item-meta"><strong>Why now:</strong> {d.whyNow}</p>
      <ul className="rs-list">
        {d.sources.map((s) => (
          <li key={`${s.conversationId}-${s.passageId}`}>
            <button type="button" className="rs-button-quiet" onClick={() => onOpenConversation(s.conversationId, s.passageId)}>
              {s.title} · {when(s.saidAt)}
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="rs-button-quiet" onClick={() => onOpenIdea(d.ideaId)}>Full history</button>
      <DecisionBar ideaId={d.ideaId} onDecided={onDecided} />
    </article>
  );
}

function DecisionBar({ ideaId, onDecided }: { ideaId: string; onDecided(): void }): JSX.Element {
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const act = async (decision: MemoryDecision): Promise<void> => {
    if (decision === 'UPDATE_WANT' && !feedback.trim()) {
      setOutcome('Write what you want from it now in the box, then choose F.');
      return;
    }
    setBusy(true);
    try {
      const { result } = await MemoryApi.decide(ideaId, {
        decision,
        feedback: feedback.trim() || undefined,
        wantedNow: decision === 'UPDATE_WANT' ? feedback.trim() : undefined,
      });
      setOutcome(
        result.created.kind === 'CANDIDATE'
          ? 'Done — it is now an idea in Brain, and Russell will work it through.'
          : result.created.kind === 'PROJECT'
            ? 'Done — a project was created for it.'
            : 'Recorded.',
      );
      onDecided();
    } catch (e) {
      setOutcome(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="rs-memory-decide">
      <label className="rs-quiet">
        Your instructions or feedback (optional; required for F)
        <textarea rows={2} value={feedback} onChange={(e) => setFeedback(e.target.value)} />
      </label>
      <div className="rs-memory-choices">
        {CHOICES.map((c) => (
          <button key={c.decision} type="button" className={c.letter === 'A' || c.letter === 'B' ? 'rs-primary' : 'rs-button'} disabled={busy} onClick={() => void act(c.decision)}>
            {c.letter}. {c.label}
          </button>
        ))}
        <button type="button" className="rs-button-quiet" disabled={busy || !feedback.trim()} onClick={() => void act('FEEDBACK')}>
          Just save my note
        </button>
      </div>
      {outcome ? <p className="rs-quiet" role="status">{outcome}</p> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
const STATES = ['', 'UNRESOLVED', 'ACTIVE', 'PAUSED', 'COMPLETED', 'SUPERSEDED', 'REJECTED'];

function Ideas({ onOpenIdea }: { onOpenIdea(id: string): void }): JSX.Element {
  const [state, setState] = useState('');
  const [q, setQ] = useState('');
  const { data, error } = useLoad(() => MemoryApi.ideas({ state, q }), [state, q]);
  return (
    <div>
      <div className="rs-memory-filters">
        <select value={state} onChange={(e) => setState(e.target.value)} aria-label="State">
          {STATES.map((s) => <option key={s} value={s}>{s ? s.toLowerCase() : 'every state'}</option>)}
        </select>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter ideas" aria-label="Filter ideas" />
      </div>
      {error ? <p className="rs-state rs-state-error">{error}</p> : null}
      {!data ? <p className="rs-state rs-state-loading">Reading the registry…</p> : null}
      {data && data.ideas.length === 0 ? <p className="rs-state rs-state-empty">No ideas recorded yet.</p> : null}
      <ul className="rs-list">
        {data?.ideas.map((i: IdeaSummary) => (
          <li key={i.id} className="rs-card">
            <button type="button" className="rs-button-quiet" onClick={() => onOpenIdea(i.id)}>
              <span className="rs-card-title">{i.title}</span>
            </button>
            <p className="rs-quiet">
              {i.kind.toLowerCase()} · {i.state.toLowerCase()} · {period(i.firstSeenAt, i.lastSeenAt)} · {i.conversations} conversation(s)
              {i.hasOpenDiscovery ? ' · surfaced' : ''}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function IdeaPanel({
  ideaId,
  onClose,
  onOpenConversation,
  onOpenIdea,
}: {
  ideaId: string;
  onClose(): void;
  onOpenConversation(id: string, p?: string): void;
  onOpenIdea(id: string): void;
}): JSX.Element {
  const { data, error, reload } = useLoad<IdeaDetail>(() => MemoryApi.idea(ideaId), [ideaId]);
  if (error) return <p className="rs-state rs-state-error">{error}</p>;
  if (!data) return <p className="rs-state rs-state-loading">Reconstructing…</p>;
  const { idea } = data;
  return (
    <article className="rs-card rs-memory-idea">
      <button type="button" className="rs-button-quiet" onClick={onClose}>← Back</button>
      <p className="rs-card-title">{idea.title}</p>
      <p className="rs-quiet">{idea.kind.toLowerCase()} · {idea.state.toLowerCase()} · {period(idea.firstSeenAt, idea.lastSeenAt)} · version {idea.version}</p>
      <p className="rs-item-meta"><strong>Originally:</strong> {idea.statement}</p>
      <p className="rs-item-meta"><strong>Status:</strong> {idea.stateBasis}</p>
      {idea.ownerIntent ? <p className="rs-item-meta"><strong>What you want now:</strong> {idea.ownerIntent}</p> : null}
      {idea.obstacles.length ? <p className="rs-item-meta"><strong>Stalled on:</strong> {idea.obstacles.map((o) => o.toLowerCase()).join(', ')}</p> : null}
      {idea.openQuestions.length ? (
        <>
          <h4 className="rs-group-title">Open questions</h4>
          <ul className="rs-list">{idea.openQuestions.map((q) => <li key={q} className="rs-item-meta">{q}</li>)}</ul>
        </>
      ) : null}
      {idea.nextActions.length ? (
        <>
          <h4 className="rs-group-title">Game plan (draft)</h4>
          <ol>{idea.nextActions.map((a) => <li key={a} className="rs-item-meta">{a}</li>)}</ol>
        </>
      ) : null}
      <h4 className="rs-group-title">How it developed</h4>
      <ol className="rs-memory-timeline">
        {data.timeline.map((t) => (
          <li key={t.passageId}>
            <p className="rs-quiet">{when(t.saidAt)} · {t.stage.toLowerCase().replace('_', ' ')}{t.direct ? '' : ' · related'}</p>
            <p className="rs-item-meta">{t.excerpt}</p>
            <button type="button" className="rs-button-quiet" onClick={() => onOpenConversation(t.conversationId, t.passageId)}>{t.conversationTitle}</button>
          </li>
        ))}
      </ol>
      {data.currentConnections.length ? (
        <>
          <h4 className="rs-group-title">Connected to what Brain holds now</h4>
          <ul className="rs-list">{data.currentConnections.map((c) => <li key={c.id} className="rs-item-meta">{c.kind.toLowerCase().replace(/_/g, ' ')}: {c.title}</li>)}</ul>
        </>
      ) : null}
      {data.related.length ? (
        <>
          <h4 className="rs-group-title">Related ideas</h4>
          <ul className="rs-list">
            {data.related.map((r) => (
              <li key={`${r.id}-${r.relation}`}>
                <button type="button" className="rs-button-quiet" onClick={() => onOpenIdea(r.id)}>{r.title}</button>
                <span className="rs-quiet"> — {r.basis}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {data.topics.length ? <p className="rs-quiet">Topics: {data.topics.map((t) => t.label).join(', ')}</p> : null}
      {data.decisions.length ? (
        <>
          <h4 className="rs-group-title">Your decisions</h4>
          <ul className="rs-list">{data.decisions.map((d) => <li key={d.createdAt} className="rs-item-meta">{when(d.createdAt)}: {d.decision.toLowerCase().replace('_', ' ')}{d.feedback ? ` — “${d.feedback}”` : ''}</li>)}</ul>
        </>
      ) : null}
      <details className="rs-details">
        <summary>Earlier versions ({data.versions.length})</summary>
        <ul className="rs-list">{data.versions.map((v) => <li key={v.version} className="rs-item-meta">v{v.version} · {when(v.createdAt)} · {v.reason}</li>)}</ul>
      </details>
      <DecisionBar ideaId={idea.id} onDecided={reload} />
    </article>
  );
}

function ConversationPanel({ conversationId, passageId, onClose }: { conversationId: string; passageId?: string; onClose(): void }): JSX.Element {
  const [branches, setBranches] = useState(false);
  const { data, error } = useLoad<ConversationRecord>(() => MemoryApi.conversation(conversationId, branches), [conversationId, branches]);
  if (error) return <p className="rs-state rs-state-error">{error}</p>;
  if (!data) return <p className="rs-state rs-state-loading">Opening the original conversation…</p>;
  const c = data.conversation;
  return (
    <article className="rs-card rs-memory-conversation" data-passage={passageId ?? ''}>
      <button type="button" className="rs-button-quiet" onClick={onClose}>← Back</button>
      <p className="rs-card-title">{c.title}</p>
      <p className="rs-quiet">
        {c.source === 'BRIDGE' ? 'Synced live' : 'From your export'} · {when(c.createdAt)} – {when(c.updatedAt)} · {c.messages} messages
        {c.branchPoints ? ` · ${c.branchPoints} branch point(s), ${c.alternates} alternate message(s)` : ''}
        {c.projectName || c.projectRef ? ` · project ${c.projectName ?? c.projectRef}` : ''} · version {c.version}
      </p>
      {c.branchPoints ? (
        <label className="rs-quiet">
          <input type="checkbox" checked={branches} onChange={(e) => setBranches(e.target.checked)} /> Show edited and regenerated branches
        </label>
      ) : null}
      <ol className="rs-memory-transcript">
        {data.messages.map((m) => (
          <li key={m.id} data-role={m.role} data-alternate={!m.onReadPath || m.superseded ? 'true' : 'false'}>
            <p className="rs-quiet">
              {m.role === 'USER' ? 'You' : m.role === 'ASSISTANT' ? (m.modelSlug ?? 'Assistant') : m.role.toLowerCase()} · {when(m.saidAt)}
              {!m.onReadPath ? ' · alternate branch' : ''}{m.superseded ? ' · earlier version' : ''}{m.hidden ? ' · hidden context' : ''}
            </p>
            <p className="rs-memory-text">{m.text}</p>
            {m.attachments.map((a) => (
              <p key={a.id} className="rs-quiet">
                {a.kind.toLowerCase()}: {a.name ?? 'unnamed'} —{' '}
                {a.state === 'RECOVERED' ? (
                  a.kind === 'IMAGE' ? <img src={`/api/memory/attachments/${a.id}`} alt={a.name ?? 'attachment'} className="rs-memory-image" /> : <a href={`/api/memory/attachments/${a.id}`}>open</a>
                ) : a.state === 'FAILED' ? 'could not be stored' : 'referenced, file not imported'}
              </p>
            ))}
          </li>
        ))}
      </ol>
      {data.topics.length ? <p className="rs-quiet">Topics: {data.topics.map((t) => t.label).join(', ')}</p> : null}
    </article>
  );
}

// ---------------------------------------------------------------------------
function Topics({ onOpenIdea, onOpenConversation }: { onOpenIdea(id: string): void; onOpenConversation(id: string, p?: string): void }): JSX.Element {
  const { data, error } = useLoad(() => MemoryApi.topics(), []);
  const [open, setOpen] = useState<string | null>(null);
  if (error) return <p className="rs-state rs-state-error">{error}</p>;
  if (!data) return <p className="rs-state rs-state-loading">Reading topics…</p>;
  if (open) return <TopicPanel topicId={open} onClose={() => setOpen(null)} onOpenIdea={onOpenIdea} onOpenConversation={onOpenConversation} onOpenTopic={setOpen} />;
  if (data.topics.length === 0) return <p className="rs-state rs-state-empty">No topics yet — they form once a history is imported.</p>;
  const node = (t: TopicNode): JSX.Element => (
    <li key={t.id}>
      <button type="button" className="rs-button-quiet" onClick={() => setOpen(t.id)}>{t.label}</button>
      <span className="rs-quiet"> · {t.conversations} conversations · {period(t.firstSeenAt, t.lastSeenAt)}</span>
      {t.children.length ? <ul>{t.children.map(node)}</ul> : null}
    </li>
  );
  return <ul className="rs-list rs-memory-topics">{data.topics.map(node)}</ul>;
}

function TopicPanel({
  topicId, onClose, onOpenIdea, onOpenConversation, onOpenTopic,
}: { topicId: string; onClose(): void; onOpenIdea(id: string): void; onOpenConversation(id: string, p?: string): void; onOpenTopic(id: string): void }): JSX.Element {
  const [role, setRole] = useState<'USER' | 'ALL'>('USER');
  const { data, error } = useLoad<TopicHistory>(() => MemoryApi.topic(topicId, role), [topicId, role]);
  if (error) return <p className="rs-state rs-state-error">{error}</p>;
  if (!data) return <p className="rs-state rs-state-loading">Reading the topic's history…</p>;
  return (
    <article className="rs-card">
      <button type="button" className="rs-button-quiet" onClick={onClose}>← Topics</button>
      <p className="rs-card-title">{data.topic.label}</p>
      <p className="rs-quiet">{data.topic.conversations} conversations · terms: {data.topic.terms.join(', ')}</p>
      {data.children.length ? <p className="rs-quiet">Subtopics: {data.children.map((c) => <button key={c.id} type="button" className="rs-button-quiet" onClick={() => onOpenTopic(c.id)}>{c.label}</button>)}</p> : null}
      {data.ideas.length ? (
        <>
          <h4 className="rs-group-title">Ideas in this topic</h4>
          <ul className="rs-list">{data.ideas.map((i) => <li key={i.id}><button type="button" className="rs-button-quiet" onClick={() => onOpenIdea(i.id)}>{i.title}</button> <span className="rs-quiet">{i.state.toLowerCase()}</span></li>)}</ul>
        </>
      ) : null}
      <h4 className="rs-group-title">History, oldest first</h4>
      <label className="rs-quiet"><input type="checkbox" checked={role === 'ALL'} onChange={(e) => setRole(e.target.checked ? 'ALL' : 'USER')} /> Include the assistant's replies</label>
      <ol className="rs-memory-timeline">
        {data.history.map((h) => (
          <li key={h.passageId}>
            <p className="rs-quiet">{when(h.saidAt)} · {h.role === 'USER' ? 'you' : 'assistant'}</p>
            <p className="rs-item-meta">{h.excerpt}</p>
            <button type="button" className="rs-button-quiet" onClick={() => onOpenConversation(h.conversationId, h.passageId)}>{h.conversationTitle}</button>
          </li>
        ))}
      </ol>
    </article>
  );
}

// ---------------------------------------------------------------------------
function Hubs({ onOpenIdea, onOpenConversation }: { onOpenIdea(id: string): void; onOpenConversation(id: string, p?: string): void }): JSX.Element {
  const hubs = useLoad(() => MemoryApi.hubs(), []);
  const commitments = useLoad(() => MemoryApi.commitments(), []);
  const school = useLoad<{ foundation: MovieSchoolFoundation }>(() => MemoryApi.movieSchool(), []);
  return (
    <div>
      <h3 className="rs-group-title">Prepared hubs</h3>
      {hubs.data?.hubs.length === 0 ? <p className="rs-state rs-state-empty">No sustained commitment has been recognised yet.</p> : null}
      {hubs.data?.hubs.map((h: HubView) => (
        <article key={h.id} className="rs-card">
          <p className="rs-card-title">{h.title}</p>
          <p className="rs-quiet">{h.kind.toLowerCase().replace('_', ' ')} · {h.state.toLowerCase()}</p>
          <pre className="rs-memory-text">{h.draftPlan}</pre>
          {h.state === 'PREPARED' || h.state === 'PROPOSED' ? (
            <div className="rs-memory-choices">
              <button type="button" className="rs-primary" onClick={() => void MemoryApi.decideHub(h.id, 'ACCEPT').then(hubs.reload)}>Make this a project</button>
              <button type="button" className="rs-button" onClick={() => void MemoryApi.decideHub(h.id, 'DECLINE').then(hubs.reload)}>Not needed</button>
            </div>
          ) : null}
        </article>
      ))}
      <h3 className="rs-group-title">Commitments, as the record shows them</h3>
      <ul className="rs-list">
        {commitments.data?.commitments.map((c) => (
          <li key={c.topicId} className="rs-item-meta"><strong>{c.label}</strong> — {c.verdict === 'PURSUED' ? 'pursued' : 'discussed'}: {c.why}</li>
        ))}
      </ul>
      <MovieSchool data={school.data?.foundation ?? null} onOpenIdea={onOpenIdea} onOpenConversation={onOpenConversation} onChanged={school.reload} />
    </div>
  );
}

function MovieSchool({ data, onOpenIdea, onOpenConversation, onChanged }: { data: MovieSchoolFoundation | null; onOpenIdea(id: string): void; onOpenConversation(id: string, p?: string): void; onChanged(): void }): JSX.Element {
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<'OBJECTIVE' | 'EXERCISE' | 'ASSESSMENT'>('OBJECTIVE');
  if (!data) return <p className="rs-state rs-state-loading">Reading Movie School…</p>;
  return (
    <section className="rs-card rs-movie-school">
      <h3 className="rs-card-title">Movie School — the foundation</h3>
      <p className="rs-quiet">
        {data.totals.filmConversations} conversations · {data.totals.filmPassages} passages about film, {data.totals.yourPassages} in your own words.
      </p>
      <p className="rs-item-meta">{data.caveat}</p>
      {data.facets.map((f) => (
        <details key={f.facet} className="rs-details">
          <summary>{f.label} ({f.count})</summary>
          <p className="rs-quiet">{f.distinction}</p>
          <ul className="rs-list">
            {f.examples.map((e) => (
              <li key={e.passageId}>
                <p className="rs-quiet">{when(e.saidAt)} · {e.role === 'USER' ? 'you' : 'assistant'}</p>
                <p className="rs-item-meta">{e.excerpt}</p>
                <button type="button" className="rs-button-quiet" onClick={() => onOpenConversation(e.conversationId, e.passageId)}>{e.conversationTitle}</button>
              </li>
            ))}
          </ul>
        </details>
      ))}
      <h4 className="rs-group-title">Your film ideas and projects</h4>
      <ul className="rs-list">
        {data.concepts.map((c) => <li key={c.id}><button type="button" className="rs-button-quiet" onClick={() => onOpenIdea(c.id)}>{c.title}</button> <span className="rs-quiet">{c.state.toLowerCase()}</span></li>)}
      </ul>
      <h4 className="rs-group-title">Learning, practice and assessment (from now on)</h4>
      {data.practice.length === 0 ? <p className="rs-quiet">Nothing recorded yet — this is kept separate from the history above.</p> : null}
      <ul className="rs-list">{data.practice.map((p) => <li key={p.id} className="rs-item-meta">{p.kind.toLowerCase()}: {p.title} · {p.state.toLowerCase()}</li>)}</ul>
      <div className="rs-memory-filters">
        <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} aria-label="Kind">
          <option value="OBJECTIVE">Learning objective</option>
          <option value="EXERCISE">Exercise</option>
          <option value="ASSESSMENT">Assessment</option>
        </select>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add one" aria-label="Add practice" />
        <button type="button" className="rs-button" disabled={!title.trim()} onClick={() => void MemoryApi.addPractice({ kind, title }).then(() => { setTitle(''); onChanged(); })}>Add</button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
function SearchTab({ onOpenIdea, onOpenConversation }: { onOpenIdea(id: string): void; onOpenConversation(id: string, p?: string): void }): JSX.Element {
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [role, setRole] = useState('');
  const [order, setOrder] = useState('NEWEST');
  const [hits, setHits] = useState<MemorySearchHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (): Promise<void> => {
    setError(null);
    try {
      const answer = await MemoryApi.search(q, { from, to, role, order });
      setHits(answer.hits);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div>
      <form className="rs-memory-filters" onSubmit={(e) => { e.preventDefault(); void run(); }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search everything you discussed" aria-label="Search" />
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To" />
        <select value={role} onChange={(e) => setRole(e.target.value)} aria-label="Who said it">
          <option value="">Anyone</option>
          <option value="USER">You</option>
          <option value="ASSISTANT">The assistant</option>
        </select>
        <select value={order} onChange={(e) => setOrder(e.target.value)} aria-label="Order">
          <option value="NEWEST">Newest first</option>
          <option value="OLDEST">Oldest first</option>
        </select>
        <button type="submit" className="rs-primary" disabled={q.trim().length < 2}>Search</button>
      </form>
      {error ? <p className="rs-state rs-state-error">{error}</p> : null}
      {hits && hits.length === 0 ? <p className="rs-state rs-state-empty">Nothing found.</p> : null}
      <ul className="rs-list">
        {hits?.map((h) => (
          <li key={`${h.kind}-${h.id}`} className="rs-card">
            <p className="rs-quiet">{h.kind.toLowerCase()} · {when(h.saidAt)}{h.role ? ` · ${h.role === 'USER' ? 'you' : 'assistant'}` : ''}</p>
            {h.kind === 'IDEA' ? (
              <button type="button" className="rs-button-quiet" onClick={() => onOpenIdea(h.id)}>{h.title}</button>
            ) : h.conversationId ? (
              <button type="button" className="rs-button-quiet" onClick={() => onOpenConversation(h.conversationId!, h.kind === 'PASSAGE' ? h.id : undefined)}>{h.title}</button>
            ) : (
              <span className="rs-card-title">{h.title}</span>
            )}
            {h.excerpt ? <p className="rs-item-meta">{h.excerpt}</p> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
async function entriesFromFiles(files: FileList): Promise<ArchiveEntrySource[]> {
  const out: ArchiveEntrySource[] = [];
  for (const file of Array.from(files)) {
    if (/\.zip$/i.test(file.name)) {
      const zip = await JSZip.loadAsync(file);
      zip.forEach((path, entry) => {
        if (entry.dir) return;
        out.push({
          name: path,
          size: (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? null,
          text: () => entry.async('string'),
          base64: () => entry.async('base64'),
        });
      });
    } else {
      out.push({
        name: file.webkitRelativePath || file.name,
        size: file.size,
        text: () => file.text(),
        base64: async () => {
          const buffer = new Uint8Array(await file.arrayBuffer());
          let binary = '';
          for (let i = 0; i < buffer.length; i += 0x8000) binary += String.fromCharCode(...buffer.subarray(i, i + 0x8000));
          return btoa(binary);
        },
      });
    }
  }
  return out;
}

function ImportTab(): JSX.Element {
  const overview = useLoad(() => MemoryApi.overview(), []);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [summary, setSummary] = useState<UploadSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const start = async (files: FileList | null): Promise<void> => {
    if (!files || files.length === 0) return;
    setBusy(true);
    setError(null);
    setSummary(null);
    try {
      const entries = await entriesFromFiles(files);
      const result = await uploadArchive({
        label: Array.from(files).map((f) => f.name).join(', ').slice(0, 200),
        entries,
        post: MemoryApi.post,
        progress: setProgress,
      });
      setSummary(result);
      overview.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const c: CoverageReport | undefined = overview.data?.coverage;
  return (
    <div>
      <article className="rs-card">
        <p className="rs-card-title">Import your ChatGPT history</p>
        <ol className="rs-item-meta">
          <li>In ChatGPT: Settings → Data controls → Export data. The email link downloads a .zip.</li>
          <li>Choose that .zip here (or ChatGPTExporter JSON / Markdown files). It is read in this browser and sent to your Brain only.</li>
          <li>If it is interrupted, choose the same file again: only what is missing is sent.</li>
        </ol>
        <input type="file" accept=".zip,.json,.md,.markdown" multiple disabled={busy} onChange={(e) => void start(e.target.files)} aria-label="Choose an export" />
        {progress && busy ? <p className="rs-quiet" role="status">{progress.message} ({progress.done}/{progress.total})</p> : null}
        {error ? <p className="rs-state rs-state-error">{error}</p> : null}
        {summary ? (
          <p className="rs-item-meta" role="status">
            {summary.declared} conversations found · {summary.sent} sent · {summary.alreadyHeld} already held · {summary.failed.length} failed ·{' '}
            {summary.filesSent} files sent, {summary.filesMissing} referenced but not in the export, {summary.filesTooLarge} too large.
          </p>
        ) : null}
        <p className="rs-quiet">
          From a terminal instead: <code>npm run memory -- import path/to/export.zip --url https://your-brain --key brnc_…</code>
        </p>
      </article>
      {overview.error ? <p className="rs-state rs-state-error">{overview.error}</p> : null}
      {c ? <Coverage c={c} /> : <p className="rs-state rs-state-loading">Counting…</p>}
    </div>
  );
}

function Coverage({ c }: { c: CoverageReport }): JSX.Element {
  return (
    <article className="rs-card rs-memory-coverage">
      <p className="rs-card-title">Coverage — measured, with denominators</p>
      <ul className="rs-list">
        <li className="rs-item-meta"><strong>Recovered:</strong> {c.classes.recovered}</li>
        <li className="rs-item-meta"><strong>Discovered, not recovered:</strong> {c.classes.discoveredNotRecovered}</li>
        <li className="rs-item-meta"><strong>Unverifiable:</strong> {c.classes.unverifiable}</li>
      </ul>
      <table className="rs-memory-table">
        <tbody>
          <tr><th>Conversations declared by archives</th><td>{c.conversations.declared}</td></tr>
          <tr><th>Recovered from archives</th><td>{c.conversations.recovered}</td></tr>
          <tr><th>Synced live (bridge)</th><td>{c.conversations.fromBridge}</td></tr>
          <tr><th>Failed / not yet sent</th><td>{c.conversations.failed} / {c.conversations.notYetSent}</td></tr>
          <tr><th>Messages declared / stored</th><td>{c.messages.declared} / {c.messages.stored}</td></tr>
          <tr><th>Alternate branches kept</th><td>{c.messages.alternateBranches} (in {c.branches.conversationsWithBranches} conversations)</td></tr>
          <tr><th>Earlier message versions kept</th><td>{c.messages.supersededVersions}</td></tr>
          <tr><th>Attachments referenced / recovered</th><td>{c.attachments.referenced} / {c.attachments.recovered}</td></tr>
          <tr><th>Messages with text / indexed for search</th><td>{c.search.messagesWithText} / {c.search.messagesIndexed}</td></tr>
          <tr><th>Topics (subtopics, merged)</th><td>{c.organization.topics} ({c.organization.subtopics}, {c.organization.merged})</td></tr>
          <tr><th>Ideas in the registry</th><td>{c.registry.ideas}</td></tr>
          <tr><th>Discoveries open / decided</th><td>{c.rediscovery.open} / {c.rediscovery.decided}</td></tr>
          <tr><th>Date range</th><td>{when(c.dateRange.first)} – {when(c.dateRange.last)}</td></tr>
        </tbody>
      </table>
      <h4 className="rs-group-title">Gaps</h4>
      <ul className="rs-list">{c.gaps.map((g) => <li key={g} className="rs-item-meta">{g}</li>)}</ul>
      {c.conversations.failures.length ? (
        <details className="rs-details">
          <summary>Failed conversations ({c.conversations.failures.length})</summary>
          <ul className="rs-list">{c.conversations.failures.map((f) => <li key={f.externalId} className="rs-item-meta">{f.title}: {f.error} (attempts {f.attempts})</li>)}</ul>
        </details>
      ) : null}
    </article>
  );
}
