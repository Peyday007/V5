/**
 * The default shell.
 *
 * Opening Brain lands here, on a conversation — not on a three-pane operations
 * console. That is the whole change of posture the step is for: a person should
 * be able to say what they want and be told what happened, and everything else
 * is available when they go looking for it.
 *
 * The old console is not deleted and is not hidden as punishment. It is behind
 * a secondary menu, one click away, because it is still the only place some
 * operations exist and a person who needs it should not have to be told a URL.
 *
 * Layout is one decision, taken from the viewport: a rail beside the
 * conversation on a desktop, a bar under it on a phone. `navigationMode` owns
 * it, so the behaviour is asserted in a test rather than left to a media query
 * nobody exercises.
 */
import { useCallback, useEffect, useState } from 'react';
import { Api } from '../lib/api.ts';
import type { SessionUser } from '../lib/api.ts';
import type { Project } from '../../../server/domain/types.ts';
import { RussellApi } from '../lib/russellApi.ts';
import { navigationMode } from './present.ts';
import { useAsync } from './useAsync.ts';
import { Conversation } from './Conversation.tsx';
import { FleetView, KnowledgeView, NeedsYouView, ProjectsView, WorkView } from './Views.tsx';
import type { Navigation, Route } from '../lib/router.ts';

const SECTIONS = [
  { name: 'HOME' as const, label: 'Russell' },
  { name: 'WORK' as const, label: 'Work' },
  { name: 'PROJECTS' as const, label: 'Ideas' },
  { name: 'KNOWLEDGE' as const, label: 'Knows' },
  { name: 'FLEET' as const, label: 'Who' },
  { name: 'NEEDS_YOU' as const, label: 'Needs you' },
];

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
    void RussellApi.openConversation('New conversation', projectId).then(
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

  const conversationId =
    route.name === 'CONVERSATION' ? route.conversationId : openedId;

  const signOut = useCallback(() => {
    void Api.logout().then(onSignedOut, onSignedOut);
  }, [onSignedOut]);

  const needsYou = useAsync(
    () => (projectId ? RussellApi.needsYou(projectId) : Promise.resolve({ requests: [] })),
    [projectId],
  );
  const openCount = needsYou.data?.requests.length ?? 0;

  return (
    <div className={`rs-shell rs-shell-${mode.toLowerCase()}`} data-nav={mode}>
      <header className="rs-header">
        <h1 className="rs-brand">Russell</h1>
        <Briefing projectId={projectId} projectName={project?.name ?? null} />
        <div className="rs-more">
          <button
            type="button"
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            aria-label="More"
            onClick={() => setMenuOpen((open) => !open)}
          >
            More
          </button>
          {menuOpen ? (
            <ul className="rs-menu" role="menu">
              {/* The old console. One click, never a URL somebody has to be
                  told, and never the default. */}
              <li role="none">
                <button type="button" role="menuitem" onClick={() => go({ name: 'LEGACY' })}>
                  Full console
                </button>
              </li>
              {user.isBrainAdmin ? (
                <li role="none">
                  {/* Server-rendered and outside the client bundle on purpose:
                      it is the surface you need when the bundle is broken. */}
                  <a role="menuitem" href="/operator">
                    Operator console
                  </a>
                </li>
              ) : null}
              <li role="none">
                <button type="button" role="menuitem" onClick={signOut}>
                  Sign out ({user.displayName})
                </button>
              </li>
            </ul>
          ) : null}
        </div>
      </header>

      <nav className="rs-nav" aria-label="Sections">
        <ul>
          {SECTIONS.map((section) => (
            <li key={section.name}>
              <button
                type="button"
                aria-current={route.name === section.name ? 'page' : undefined}
                onClick={() => go({ name: section.name } as Route)}
              >
                {section.label}
                {section.name === 'NEEDS_YOU' && openCount > 0 ? (
                  <span className="rs-badge" aria-label={`${openCount} waiting`}>
                    {openCount}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <main className="rs-main">
        {route.name === 'HOME' || route.name === 'CONVERSATION' ? (
          conversationId ? (
            <Conversation conversationId={conversationId} />
          ) : (
            <p className="rs-state rs-state-loading">Opening a conversation…</p>
          )
        ) : null}
        {route.name === 'WORK' ? <WorkView projectId={projectId} /> : null}
        {route.name === 'PROJECTS' ? <ProjectsView projectId={projectId} /> : null}
        {route.name === 'KNOWLEDGE' ? <KnowledgeView projectId={projectId} /> : null}
        {route.name === 'FLEET' ? <FleetView /> : null}
        {route.name === 'NEEDS_YOU' ? (
          <NeedsYouView projectId={projectId} onAnswered={needsYou.reload} />
        ) : null}
        {route.name === 'NOT_FOUND' ? (
          <p className="rs-state rs-state-empty">
            There is nothing at that address.{' '}
            <button type="button" onClick={() => go({ name: 'HOME' })}>
              Go back to Russell
            </button>
          </p>
        ) : null}
      </main>
    </div>
  );
}

/**
 * The four sentences, in their fixed order.
 *
 * Composed on the server so that the ordering rule lives in one place; this
 * only renders it. A briefing that could not be read says so rather than
 * showing an encouraging blank.
 */
function Briefing({
  projectId,
  projectName,
}: {
  projectId: string | null;
  projectName: string | null;
}): JSX.Element {
  const query = useAsync(
    () => (projectId ? RussellApi.briefing(projectId) : Promise.resolve(null)),
    [projectId],
  );
  if (query.loading) return <p className="rs-briefing rs-state-loading">Reading the project…</p>;
  if (query.error || !query.data) {
    return (
      <p className="rs-briefing rs-state-empty">
        {projectName ? `Russell cannot read ${projectName} right now.` : 'Nothing to report yet.'}
      </p>
    );
  }
  const { briefing, cycle } = query.data;
  return (
    <div className="rs-briefing">
      <p className="rs-briefing-focus">{briefing.focus}</p>
      <p>{briefing.progress}</p>
      {briefing.latest ? <p className="rs-briefing-latest">{briefing.latest}</p> : null}
      <p>{briefing.next}</p>
      <p className="rs-briefing-needs">{briefing.needsYou}</p>
      {cycle && cycle.state !== 'RUNNING' ? (
        <p className="rs-state rs-state-stale">
          {cycle.state === 'PAUSED' ? 'Russell is paused' : 'Russell is stopped'}
          {cycle.pausedReason ? `: ${cycle.pausedReason}` : '.'}
        </p>
      ) : null}
    </div>
  );
}
