/**
 * Magic Deck Lab: a secondary destination, reached from More (CLAUDE.md §57).
 *
 * Seven subsections, each its own address. Every number comes from the server
 * with the kind of claim it is, and a stale card index or a failed call is said
 * out loud — there is no silent green result.
 */
import { useEffect, useRef, useState } from 'react';
import {
  MAGIC_SECTIONS,
  MagicApi,
  pathFor,
  sectionFromPath,
  type MagicSection,
} from '../lib/magicApi.ts';
import { useAsync } from './useAsync.ts';
import { CollectionSection, DecksSection, ExportsSection, ImportForm } from './magic/Decks.tsx';
import { DesignSection } from './magic/Design.tsx';
import { LeagueSection, MatchupsSection } from './magic/League.tsx';
import { OptimizeSection } from './magic/Optimize.tsx';
import { ErrorLine, errorText } from './magic/shared.tsx';

const LABELS: Record<MagicSection, string> = {
  design: 'Design',
  decks: 'My Decks',
  optimize: 'Optimize',
  matchups: 'Matchups',
  league: 'League',
  collection: 'Collection',
  exports: 'Exports',
};

/** How long to wait before re-reading a catalog that is still loading, and how many times. */
const CATALOG_POLL_MS = 15_000;
const CATALOG_POLLS = 8;

/**
 * The catalog the whole lab resolves names against, as the server reads it.
 * Reading the status is what starts a refresh of an empty or stale catalog, so
 * a loading catalog is re-read on a bounded timer rather than left to look stuck.
 */
function CatalogBanner(): JSX.Element {
  const status = useAsync(() => MagicApi.catalogStatus(), []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const polls = useRef(0);
  const data = status.data;
  const loading = data ? data.state === 'LOADING' || data.state === 'EMPTY' : false;
  const { reload } = status;
  useEffect(() => {
    if (!loading || polls.current >= CATALOG_POLLS) return undefined;
    const timer = setTimeout(() => {
      polls.current += 1;
      reload();
    }, CATALOG_POLL_MS);
    return () => clearTimeout(timer);
  }, [loading, data, reload]);

  const refresh = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await MagicApi.refreshCatalog();
      polls.current = 0;
      reload();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  let line: JSX.Element | null = null;
  if (status.error && !data) {
    line = (
      <p className="rs-magic-stale" role="status">
        Card catalog status unavailable{status.error.retryable ? ' for now' : ''}: {status.error.message}
      </p>
    );
  } else if (!data) {
    line = <p className="rs-meta">Reading the card catalog…</p>;
  } else if (loading) {
    line = (
      <p className="rs-magic-stale" role="status">
        The card catalog is loading ({data.cards} cards so far). {data.reason ?? ''} Names cannot all be resolved until it finishes.
      </p>
    );
  } else if (data.stale) {
    line = (
      <p className="rs-magic-stale" role="status">
        Stale card catalog ({data.cards} cards{data.fetchedAt ? `, fetched ${data.fetchedAt}` : ''}): {data.reason ?? 'it could not be refreshed.'}
      </p>
    );
  } else {
    line = (
      <p className="rs-magic-fresh">
        Card catalog: {data.cards} cards{data.fetchedAt ? `, fetched ${data.fetchedAt}` : ''}.
      </p>
    );
  }
  return (
    <section className="rs-magic-catalog" aria-label="Card catalog">
      {line}
      {data?.lastError && !data.stale ? <p className="rs-meta">Last refresh error: {data.lastError}</p> : null}
      <button type="button" disabled={busy} onClick={() => void refresh()}>
        {busy ? 'Starting refresh…' : 'Refresh card catalog'}
      </button>
      <ErrorLine message={error} />
    </section>
  );
}

export function MagicView({
  section: sectionProp,
  onNavigate,
}: {
  section?: MagicSection | null;
  onNavigate?: (path: string) => void;
}): JSX.Element {
  const initial =
    sectionProp !== undefined
      ? sectionProp
      : typeof window !== 'undefined'
        ? sectionFromPath(window.location.pathname)
        : null;
  const [section, setSection] = useState<MagicSection | null>(initial);
  const [deckId, setDeckId] = useState<string | null>(null);
  useEffect(() => {
    if (sectionProp !== undefined) setSection(sectionProp);
  }, [sectionProp]);

  const go = (next: MagicSection | null): void => {
    setSection(next);
    const path = pathFor(next);
    if (onNavigate) onNavigate(path);
    else if (typeof window !== 'undefined') window.history.pushState({}, '', path);
  };
  const openDeck = (id: string): void => {
    setDeckId(id);
    go('decks');
  };

  return (
    <div className="rs-stack rs-magic">
      <header>
        <h2>Magic Deck Lab</h2>
        <nav aria-label="Magic sections" className="rs-magic-nav">
          {MAGIC_SECTIONS.map((key) => (
            <a
              key={key}
              href={pathFor(key)}
              aria-current={section === key ? 'page' : undefined}
              onClick={(event) => {
                event.preventDefault();
                go(key);
              }}
            >
              {LABELS[key]}
            </a>
          ))}
        </nav>
      </header>
      <CatalogBanner />
      {section === null ? (
        <section className="rs-card" aria-label="Start here">
          <h3>Where do you want to start?</h3>
          <div className="rs-magic-actions">
            <button type="button" onClick={() => go('design')}>
              Describe a new deck
            </button>
            <button type="button" onClick={() => go('decks')}>
              Import a deck
            </button>
            <button type="button" onClick={() => go('optimize')}>
              Optimize a saved deck
            </button>
            <button type="button" onClick={() => go('league')}>
              Open the Precon Commander League
            </button>
          </div>
        </section>
      ) : null}
      {section === 'design' ? <DesignSection onSaved={openDeck} /> : null}
      {section === 'decks' ? <DecksSection selected={deckId} onSelect={setDeckId} /> : null}
      {section === 'optimize' ? <OptimizeSection initialDeckId={deckId} /> : null}
      {section === 'matchups' ? <MatchupsSection /> : null}
      {section === 'league' ? <LeagueSection /> : null}
      {section === 'collection' ? <CollectionSection /> : null}
      {section === 'exports' ? <ExportsSection /> : null}
    </div>
  );
}

export { ImportForm };
