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
import { MachinesView } from './Machines.tsx';
import { LaborView } from './Labor.tsx';
import { ResearchView } from './Research.tsx';
import { ConnectionsPanel } from './Connections.tsx';
import { ClaudeConnectionCard } from './ClaudeConnection.tsx';
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
import { CashSection } from './Cash.tsx';
import { Devices } from './Devices.tsx';
import { PeopleAndCapacityView } from './People.tsx';

/**
 * The six, and then everything else.
 *
 * Integration 3 settled the primary set by what a person comes to Brain to
 * find out, rather than by which backend system answers it: what Brain is doing
 * for me (Home), what is making or costing money (Cash), what it is trying to
 * learn (Research), what it is building (Build), what genuinely needs me (Needs
 * you), and who and what is connected (Who).
 *
 * This **reverses** two earlier placements, and the reversal is recorded rather
 * than quietly applied. Cash was secondary on the argument that a temporary
 * section must not become the definition of Brain; that argument is about
 * authority, and nothing about where a link sits grants any. The sprint is the
 * surface the people running it open most, and burying it in a menu made the
 * product harder to use without making anything safer. Research had no
 * destination at all — its goals and budgets were scattered across Work and
 * Needs you.
 *
 * Everything that left the primary set keeps its own address, so a deep link to
 * `/work`, `/projects` or `/sites` works exactly as it did. Those surfaces are
 * reached from More, at every width.
 */
const SECTIONS = [
  { name: 'HOME' as const, label: 'Home', primary: true },
  { name: 'CASH' as const, label: 'Cash', primary: true },
  { name: 'RESEARCH' as const, label: 'Research', primary: true },
  { name: 'BUILD' as const, label: 'Build', primary: true },
  { name: 'NEEDS_YOU' as const, label: 'Needs you', primary: true },
  { name: 'FLEET' as const, label: 'Who', primary: true },
  { name: 'WORK' as const, label: 'All work', primary: false },
  { name: 'PROJECTS' as const, label: 'Ideas', primary: false },
  { name: 'KNOWLEDGE' as const, label: 'What Brain knows', primary: false },
  { name: 'SITES' as const, label: 'Connected sites', primary: false },
  { name: 'MACHINES' as const, label: 'Machines', primary: false },
  { name: 'LABOR' as const, label: 'Labor', primary: false },
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

/**
 * What an empty thread is called until somebody says something in it.
 *
 * The moment and nothing else. It is replaced by the server from the first
 * message, so this only has to be distinguishable from the thread somebody
 * started five minutes ago — which "New conversation" was not.
 */
function newThreadTitle(): string {
  return `Conversation — ${new Date().toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })}`;
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
    const title = newThreadTitle();
    /*
     * No project, and that is the whole of the Deal Dispatch defect.
     *
     * This passed `projectId` — `projects[0]`, the first project the API
     * happened to return — so every ordinary conversation in this Brain was
     * created attached to the seeded project and filed under its name. Nobody
     * chose it: the route's own default is null, and `attachment_source` on
     * every one of those rows says `NONE`.
     *
     * A thread that turns out to be about a project is attached by the router
     * when the person says something that identifies one, or by the person
     * themselves. Opening a window is not evidence of either.
     */
    void RussellApi.openConversation(title, null).then(
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

  /*
   * The badge counts exactly what Needs you shows, from the same reading.
   *
   * It used to count three sources while the page read three others, so it
   * could say 0 above a page of decisions. One inbox, one count (Integration 3).
   * A failed read shows no number rather than a guessed one.
   */
  const inbox = useAsync(() => RussellApi.inbox(projectId), [projectId]);
  const openCount = inbox.data?.items.length ?? 0;

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
    /*
     * Unattached, for the reason above, and named after when it was started
     * rather than "New conversation".
     *
     * A list of six threads all called *New conversation* is a list nobody can
     * navigate, and the name is the only thing distinguishing them until the
     * first message arrives. The server renames it from that message the
     * moment there is one — deterministically, from the person's own words —
     * so this is what a thread is called for as long as it is empty.
     */
    void RussellApi.openConversation(newThreadTitle(), null).then(
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

        {/*
          The foot, and what happens to it on a phone.

          At rail width it is three things side by side: Search, the depth
          control and the More menu. At thumb-bar width there is no room for
          three, so it becomes the bar's seventh cell holding More alone and the
          other two move *into* that menu — which is what More already meant
          here for Build and Connected sites.

          It used to be `display: none` at this width instead, which took all
          three off a phone: no Search, no depth, and no way to reach Build,
          Connected sites, the full console or **Sign out**. The `mode === 'BAR'`
          branch below has existed the whole time and nothing could reach it,
          because the element holding it was not rendered at the only width the
          branch is for. Found by walking the journey on a phone in
          `scripts/visual-qa.ts`; every assertion in the suite passed while a
          person on a phone could not sign out.
        */}
        <div className="rs-rail-foot">
          {/* Search is a destination rather than a box in the chrome: at phone
              width a persistent field would take the room the conversation
              needs, and the command bar is already where a person types. */}
          {mode === 'RAIL' ? (
            <>
              <button
                type="button"
                className="rs-rail-item"
                aria-current={route.name === 'SEARCH' ? 'page' : undefined}
                onClick={() => go({ name: 'SEARCH' })}
              >
                Search
              </button>

              <div className="rs-depth" role="group" aria-label="How much detail you want">
                <DepthChoice depth={depth} setDepth={setDepth} />
              </div>
            </>
          ) : null}

          <div className="rs-more">
            <button
              type="button"
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              onClick={() => setMenuOpen((open) => !open)}
            >
              {/* A thumb-bar cell is about fifty pixels wide, and a name does
                  not fit in one. The name is on Who, which is where a person
                  looks for who they are signed in as. */}
              {mode === 'BAR' ? 'More' : `More · ${user.displayName}`}
            </button>
            {menuOpen ? (
              <ul className="rs-menu" role="menu">
                {/* On a phone the two secondary destinations live here, because
                    eight items in a thumb bar is a bar whose last item nobody
                    finds. The addresses are unchanged either way. */}
                {mode === 'BAR' ? (
                  <li role="none">
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false);
                        go({ name: 'SEARCH' });
                      }}
                    >
                      Search
                    </button>
                  </li>
                ) : null}
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
                {mode === 'BAR' ? (
                  <li role="none" className="rs-menu-depth">
                    {/* Left open after a choice on purpose: the pressed state is
                        the answer, and a sheet that closed itself would hide it. */}
                    <span id="rs-menu-depth-label">How much detail you want</span>
                    <div className="rs-depth" role="group" aria-labelledby="rs-menu-depth-label">
                      <DepthChoice depth={depth} setDepth={setDepth} inMenu />
                    </div>
                  </li>
                ) : null}
                {/* People & capacity is in More rather than the rail because
                    it is set up once and then read occasionally. It is a
                    destination all the same: it used to be a panel at the
                    bottom of Cash, which made a temporary section the place a
                    person went to administer the permanent Brain. */}
                <li role="none">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      go({ name: 'PEOPLE' });
                    }}
                  >
                    People &amp; capacity
                  </button>
                </li>
                <li role="none">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      go({ name: 'DEVICES' });
                    }}
                  >
                    Your devices
                  </button>
                </li>
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
            needsYouCount={openCount}
            go={go}
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
        {route.name === 'RESEARCH' ? (
          <ResearchView projectId={projectId} onOpenNeedsYou={() => go({ name: 'NEEDS_YOU' })} />
        ) : null}
        {route.name === 'BUILD' ? <BuildView projectId={projectId} /> : null}
        {route.name === 'PROJECTS' ? <ProjectView projectId={projectId} /> : null}
        {route.name === 'KNOWLEDGE' ? <KnowledgeView projectId={projectId} /> : null}
        {route.name === 'FLEET' ? (
          <>
            {/*
              * Who, since Integration 3: every Claude account Brain can run on,
              * in one of six words; then the people on this project; then the
              * operator's capacity and routing reading, one click away. The
              * Deal Dispatch reading that used to sit here under the title
              * "Who is doing the work" was about a connected site's work, and
              * lives on Connected sites now.
              */}
            <ConnectionsPanel onOpenPeople={() => go({ name: 'PEOPLE' })} />
            <ClaudeConnectionCard />
            <WhoView projectId={projectId} />
            <details className="rs-details rs-panel">
              <summary>Capacity and routing — the operator view</summary>
              <FleetCentre projectId={projectId} />
            </details>
          </>
        ) : null}
        {route.name === 'SITES' ? (
          <>
            <SitesView projectId={projectId} />
            <FleetView />
          </>
        ) : null}
        {route.name === 'MACHINES' ? <MachinesView projectId={projectId} /> : null}
        {route.name === 'LABOR' ? <LaborView projectId={projectId} /> : null}
        {route.name === 'DEVICES' ? <Devices /> : null}
        {route.name === 'PEOPLE' ? <PeopleAndCapacityView /> : null}
        {route.name === 'CASH' ? (
          <CashSection projectId={projectId} isBrainAdmin={user.isBrainAdmin} />
        ) : null}
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
          <NeedsYouView projectId={projectId} onAnswered={inbox.reload} go={go} />
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
 * The three depth buttons, in the one place they are written.
 *
 * Rendered in the rail's foot at rail width and inside the More sheet at
 * thumb-bar width — the same three controls over the same state, extracted so
 * the two placements cannot drift into offering different choices. The wrapper
 * carries the `role="group"` and its label, because the two placements label it
 * differently: beside a rail there is nothing to read it against, and inside a
 * sheet there is a heading.
 */
function DepthChoice({
  depth,
  setDepth,
  inMenu = false,
}: {
  depth: Depth;
  setDepth(next: Depth): void;
  /**
   * Inside a `role="menu"`, a plain toggle button is not a valid child and a
   * screen reader is entitled to skip it. `menuitemradio` is the same three
   * controls saying the same thing in the grammar of the container they are
   * actually in — one of three, this one chosen — rather than a second control.
   */
  inMenu?: boolean;
}): JSX.Element {
  return (
    <>
      {DEPTHS.map((option) => (
        <button
          key={option}
          type="button"
          {...(inMenu
            ? { role: 'menuitemradio' as const, 'aria-checked': depth === option }
            : { 'aria-pressed': depth === option })}
          onClick={() => setDepth(option)}
        >
          {DEPTH_LABELS[option]}
        </button>
      ))}
    </>
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
