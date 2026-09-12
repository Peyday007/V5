/**
 * The shell.
 *
 * Opening Brain lands here. The structure is three parts and each one is a
 * decision the owner approved on 2026-09-12:
 *
 *   - a **rail** of six destinations, with Build and Connected sites below a
 *     rule — they are operations on the machine rather than views of the work,
 *     and neither is hidden or deleted (§5 is explicit that their placement is
 *     a design choice and not authorization to remove them);
 *   - a **reading column**, one measure wide, so a wide monitor does not turn a
 *     briefing into a banner;
 *   - a **docked command bar**, because the conversation is an affordance
 *     rather than a destination: somebody on Work who wants to ask why
 *     something is ranked there should not have to navigate away to ask.
 *
 * Two controls live in the rail's foot. The **depth** control is §4.5 — Normal,
 * Interested, Technical — and it is a property of the reader, so it is chosen
 * once here and every surface answers to it. The **More** menu holds the things
 * a person reaches for rarely, including the old console at `/legacy`, which is
 * one click away and never a URL somebody has to be told.
 *
 * On a phone the rail becomes a thumb bar of the same six, the command bar sits
 * above it, and Build and Connected sites move into More — the same information
 * architecture and the same state, which is §21's rule: one product, not two.
 */
import { useCallback, useEffect, useState } from 'react';
import { Api } from '../lib/api.ts';
import type { SessionUser } from '../lib/api.ts';
import type { Project } from '../../../server/domain/types.ts';
import { RussellApi } from '../lib/russellApi.ts';
import { DEPTHS, DEPTH_LABELS, isDepth, navigationMode, type Depth } from './present.ts';
import { useAsync } from './useAsync.ts';
import { Conversation } from './Conversation.tsx';
import { RussellHome } from './Home.tsx';
import { Search } from './Search.tsx';
import { FleetCentre } from './Fleet.tsx';
import { BuildView } from './Build.tsx';
import {
  FleetView,
  ProjectView,
  KnowledgeView,
  NeedsYouView,
  SitesView,
  WhoView,
  WorkView,
} from './Views.tsx';
import { parseRoute, type Navigation, type Route } from '../lib/router.ts';

/**
 * The six, and then the two.
 *
 * `primary` is the approved split. Everything in both lists keeps its own
 * address, so a deep link to `/build` or `/sites` works exactly as it did
 * whichever list it is in.
 */
const SECTIONS = [
  { name: 'HOME' as const, label: 'Russell', primary: true },
  { name: 'WORK' as const, label: 'Work', primary: true },
  { name: 'PROJECTS' as const, label: 'Ideas', primary: true },
  { name: 'KNOWLEDGE' as const, label: 'Knows', primary: true },
  { name: 'FLEET' as const, label: 'Who', primary: true },
  { name: 'NEEDS_YOU' as const, label: 'Needs you', primary: true },
  { name: 'BUILD' as const, label: 'Build', primary: false },
  { name: 'SITES' as const, label: 'Connected sites', primary: false },
];

const DEPTH_KEY = 'brain.depth';

export function useViewportWidth(): number {
  const [width, setWidth] = useState(() =>
    typeof window === 'undefined' ? 1200 : window.innerWidth,
  );
  useEffect(() => {
    const onResize = (): void => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return width;
}

/**
 * The reader's chosen depth, remembered in two places on purpose.
 *
 * `localStorage` answers instantly so the first paint is right, and the
 * server's per-account preference is what makes the choice follow a person to
 * another browser. The local value is the optimistic one and the account's is
 * authoritative: when they differ on load, the account wins.
 *
 * Both reads are guarded. A private window or blocked site data makes the
 * storage accessor throw rather than return nothing, and a failed preference
 * read must leave a usable shell rather than an unusable one — §18's rule that
 * every account works with strong defaults, applied to its own mechanism.
 */
function useDepth(): [Depth, (next: Depth) => void] {
  const [depth, setDepth] = useState<Depth>(() => {
    try {
      const stored = window.localStorage.getItem(DEPTH_KEY);
      return isDepth(stored) ? stored : 'NORMAL';
    } catch {
      return 'NORMAL';
    }
  });

  useEffect(() => {
    let cancelled = false;
    void RussellApi.preferences().then(
      (answer) => {
        const stored = answer.preferences.depth;
        if (!cancelled && isDepth(stored)) setDepth(stored);
      },
      () => {
        /* the shell still works at the depth this browser remembers */
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const choose = useCallback((next: Depth) => {
    setDepth(next);
    try {
      window.localStorage.setItem(DEPTH_KEY, next);
    } catch {
      /* a viewer whose browser refuses storage still gets the depth they chose,
         for this visit. Losing it on reload is a smaller harm than throwing. */
    }
    // Nothing optimistic depends on this: the screen has already changed, and
    // a failed write means the choice does not follow them to another browser
    // rather than that it did not happen.
    void RussellApi.setPreference('depth', next).catch(() => undefined);
  }, []);

  return [depth, choose];
}

export function RussellShell({
  navigation,
  user,
  onSignedOut,
}: {
  navigation: Navigation;
  user: SessionUser;
  onSignedOut(): void;
}): JSX.Element {
  const { route, go } = navigation;
  const mode = navigationMode(useViewportWidth());
  const [menuOpen, setMenuOpen] = useState(false);
  const [depth, setDepth] = useDepth();

  const projects = useAsync(() => Api.projects(), []);
  const project: Project | null = projects.data?.projects[0] ?? null;
  const projectId = project?.id ?? null;

  const conversations = useAsync(() => RussellApi.conversations(), []);
  const [openedId, setOpenedId] = useState<string | null>(null);

  /*
   * The thread a person lands on.
   *
   * Their most recent one if they have one, and a new one if they do not. Made
   * once, guarded on `openedId`, because a shell that opened a fresh thread on
   * every render would fill a person's list with empty conversations.
   */
  useEffect(() => {
    if (openedId || conversations.loading || conversations.error) return;
    const existing = conversations.data?.conversations[0];
    if (existing) {
      setOpenedId(existing.id);
      return;
    }
    let cancelled = false;
    const title = `Conversation — ${new Date().toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })}`;
    void RussellApi.openConversation(title, projectId).then(
      (created) => {
        if (!cancelled) setOpenedId(created.id);
      },
      () => {
        /* a shell with no thread still renders; the conversation says why */
      },
    );
    return () => {
      cancelled = true;
    };
  }, [openedId, conversations.loading, conversations.error, conversations.data, projectId]);

  const conversationId = route.name === 'CONVERSATION' ? route.conversationId : openedId;

  const signOut = useCallback(() => {
    void Api.logout().then(onSignedOut, onSignedOut);
  }, [onSignedOut]);

  const needsYou = useAsync(
    () => (projectId ? RussellApi.needsYou(projectId) : Promise.resolve({ requests: [] })),
    [projectId],
  );
  /*
   * The badge counts decisions, and an outstanding approval is one.
   *
   * Read from the same projection the briefing uses rather than computed a
   * second time here, because two places counting the same thing is how they
   * come to disagree — which they did: a project waiting on the one permission
   * that lets Russell act showed no badge at all.
   */
  const authority = useAsync(
    () => (projectId ? RussellApi.authority(projectId) : Promise.resolve(null)),
    [projectId],
  );
  const openCount =
    (needsYou.data?.requests.length ?? 0) +
    (authority.data && authority.data.grant === null ? 1 : 0);

  /* Bumped after the command bar posts, so the open thread re-reads itself. */
  const [reloadToken, setReloadToken] = useState(0);
  const [draft, setDraft] = useState('');
  const [starting, setStarting] = useState(false);

  const openThread = useCallback(
    (id: string) => {
      setOpenedId(id);
      go({ name: 'CONVERSATION', conversationId: id });
    },
    [go],
  );

  /*
   * Beginning a thread.
   *
   * The shell opens a person's *most recent* conversation and creates one only
   * when they have none — so without this there is no way to start a second
   * subject, and once a second exists no way back to the first except by
   * knowing its id. The list above is the way back; this is the way forward.
   */
  const startConversation = useCallback(() => {
    if (starting) return;
    setStarting(true);
    void RussellApi.openConversation('New conversation', projectId).then(
      (created) => {
        setStarting(false);
        // Reload rather than patch: what is listed is what is stored.
        conversations.reload();
        setOpenedId(created.id);
        go({ name: 'CONVERSATION', conversationId: created.id });
      },
      () => {
        // The button comes back rather than spinning. A control that never
        // recovers from one failed click is worse than one that did nothing.
        setStarting(false);
      },
    );
  }, [starting, projectId, conversations, go]);

  /* A starter fills the bar rather than sending itself. A suggestion that
     spent capacity on one click would be a decision nobody took. */
  const prefill = useCallback((text: string) => {
    setDraft(text);
    const box = document.getElementById('rs-command-input');
    if (box instanceof HTMLTextAreaElement) box.focus();
  }, []);

  return (
    <div
      className={`rs-shell rs-shell-${mode.toLowerCase()}`}
      data-nav={mode}
      data-depth={depth}
    >
      <nav className="rs-rail" aria-label="Sections">
        <h1 className="rs-brand">
          Brain <small>Russell</small>
        </h1>

        <ul className="rs-rail-group">
          {SECTIONS.filter((section) => section.primary).map((section) => (
            <RailItem
              key={section.name}
              section={section}
              route={route}
              go={go}
              badge={section.name === 'NEEDS_YOU' ? openCount : 0}
            />
          ))}
        </ul>

        <ul className="rs-rail-group rs-rail-secondary">
          {SECTIONS.filter((section) => !section.primary).map((section) => (
            <RailItem key={section.name} section={section} route={route} go={go} badge={0} />
          ))}
        </ul>

        <div className="rs-rail-foot">
          {/* Search is a destination rather than a box in the chrome: at phone
              width a persistent field would take the room the conversation
              needs, and the command bar is already where a person types. */}
          <button
            type="button"
            className="rs-rail-item"
            aria-current={route.name === 'SEARCH' ? 'page' : undefined}
            onClick={() => go({ name: 'SEARCH' })}
          >
            Search
          </button>

          <div
            className="rs-depth"
            role="group"
            aria-label="How much detail you want"
          >
            {DEPTHS.map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={depth === option}
                onClick={() => setDepth(option)}
              >
                {DEPTH_LABELS[option]}
              </button>
            ))}
          </div>

          <div className="rs-more">
            <button
              type="button"
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              onClick={() => setMenuOpen((open) => !open)}
            >
              More · {user.displayName}
            </button>
            {menuOpen ? (
              <ul className="rs-menu" role="menu">
                {/* On a phone the two secondary destinations live here, because
                    eight items in a thumb bar is a bar whose last item nobody
                    finds. The addresses are unchanged either way. */}
                {mode === 'BAR'
                  ? SECTIONS.filter((section) => !section.primary).map((section) => (
                      <li role="none" key={section.name}>
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setMenuOpen(false);
                            go({ name: section.name } as Route);
                          }}
                        >
                          {section.label}
                        </button>
                      </li>
                    ))
                  : null}
                <li role="none">
                  <button type="button" role="menuitem" onClick={() => go({ name: 'LEGACY' })}>
                    Full console
                  </button>
                </li>
                <li role="none">
                  <button type="button" role="menuitem" onClick={signOut}>
                    Sign out
                  </button>
                </li>
              </ul>
            ) : null}
          </div>
        </div>
      </nav>

      <main className="rs-main">
        {route.name === 'HOME' ? (
          <RussellHome
            projectId={projectId}
            openThreadId={conversationId}
            onOpenThread={openThread}
            onAsk={prefill}
            onStartThread={startConversation}
            starting={starting}
          />
        ) : null}
        {route.name === 'CONVERSATION' ? (
          conversationId ? (
            <div className="rs-column">
              <Conversation
                conversationId={conversationId}
                showComposer={false}
                reloadToken={reloadToken}
              />
            </div>
          ) : (
            <p className="rs-state rs-state-loading">Opening a conversation…</p>
          )
        ) : null}
        {route.name === 'WORK' ? <WorkView projectId={projectId} /> : null}
        {route.name === 'BUILD' ? <BuildView projectId={projectId} /> : null}
        {route.name === 'PROJECTS' ? <ProjectView projectId={projectId} /> : null}
        {route.name === 'KNOWLEDGE' ? <KnowledgeView projectId={projectId} /> : null}
        {route.name === 'FLEET' ? (
          <>
            {/* Who is people first, machinery second. The one-sentence reading
                stays underneath because it is the one thing that carries its
                own freshness, which the role-gated view deliberately does not. */}
            <WhoView projectId={projectId} />
            <FleetView />
            <FleetCentre projectId={projectId} />
          </>
        ) : null}
        {route.name === 'SITES' ? <SitesView projectId={projectId} /> : null}
        {route.name === 'SEARCH' ? (
          <Search
            onOpen={(href) => {
              // The server sends a real address in this application, so the
              // shell navigates rather than reconstructing a route from a kind.
              window.history.pushState({}, '', href);
              go(parseRoute(href));
            }}
          />
        ) : null}
        {route.name === 'NEEDS_YOU' ? (
          <NeedsYouView projectId={projectId} onAnswered={needsYou.reload} />
        ) : null}
        {route.name === 'NOT_FOUND' ? (
          <p className="rs-state rs-state-empty">
            There is nothing at that address.{' '}
            <button type="button" className="rs-link" onClick={() => go({ name: 'HOME' })}>
              Go back to Russell
            </button>
          </p>
        ) : null}
      </main>

      <CommandBar
        conversationId={conversationId}
        draft={draft}
        setDraft={setDraft}
        onSent={() => {
          setReloadToken((token) => token + 1);
          conversations.reload();
          if (conversationId && route.name !== 'CONVERSATION') {
            go({ name: 'CONVERSATION', conversationId });
          }
        }}
      />
    </div>
  );
}

function RailItem({
  section,
  route,
  go,
  badge,
}: {
  section: { name: Route['name']; label: string };
  route: Route;
  go(route: Route): void;
  badge: number;
}): JSX.Element {
  return (
    <li>
      <button
        type="button"
        className="rs-rail-item"
        aria-current={route.name === section.name ? 'page' : undefined}
        onClick={() => go({ name: section.name } as Route)}
      >
        {section.label}
        {badge > 0 ? (
          <span className="rs-badge" aria-label={`${badge} waiting`}>
            {badge}
          </span>
        ) : null}
      </button>
    </li>
  );
}

/**
 * The persistent way to talk to Brain (§6).
 *
 * Nothing optimistic: the words stay in the box until the server has accepted
 * them, and a failure keeps them rather than losing what somebody typed. The
 * bar is present on every screen, which is the point — a question about what is
 * on the screen should be askable from the screen.
 */
function CommandBar({
  conversationId,
  draft,
  setDraft,
  onSent,
}: {
  conversationId: string | null;
  draft: string;
  setDraft(next: string): void;
  onSent(): void;
}): JSX.Element {
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const send = useCallback(async () => {
    const content = draft.trim();
    if (!content || sending || !conversationId) return;
    setSending(true);
    setProblem(null);
    try {
      await RussellApi.say(conversationId, content);
      setDraft('');
      onSent();
    } catch {
      setProblem('That did not send. Your words are still here — try again.');
    } finally {
      setSending(false);
    }
  }, [conversationId, draft, onSent, sending, setDraft]);

  return (
    <div className="rs-command">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <label className="rs-visually-hidden" htmlFor="rs-command-input">
          Say something to Russell
        </label>
        <textarea
          id="rs-command-input"
          value={draft}
          rows={1}
          placeholder={
            conversationId ? 'Ask Russell, or tell it something…' : 'Opening a conversation…'
          }
          disabled={!conversationId}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends, shift-enter is a newline. Both are ordinary
            // expectations and neither should require reaching for a mouse.
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <button
          type="submit"
          className="rs-primary"
          disabled={sending || !conversationId || draft.trim().length === 0}
        >
          {sending ? 'Sending…' : 'Send'}
        </button>
      </form>
      {problem ? (
        <p className="rs-state rs-state-error" role="alert">
          {problem}
        </p>
      ) : null}
    </div>
  );
}
