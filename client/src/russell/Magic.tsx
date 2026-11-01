/**
 * Magic Deck Lab: a secondary destination, reached from More (CLAUDE.md §57).
 *
 * Seven subsections, each its own address. Every number comes from the server
 * with the kind of claim it is, and a stale card index or a failed call is said
 * out loud — there is no silent green result.
 */
import { useEffect, useState } from 'react';
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
import { StaleNote } from './magic/shared.tsx';

const LABELS: Record<MagicSection, string> = {
  design: 'Design',
  decks: 'My Decks',
  optimize: 'Optimize',
  matchups: 'Matchups',
  league: 'League',
  collection: 'Collection',
  exports: 'Exports',
};

function CatalogBanner(): JSX.Element | null {
  const status = useAsync(() => MagicApi.catalogStatus(), []);
  if (status.error) {
    return (
      <p className="rs-magic-stale" role="status">
        Card catalog status unavailable: {status.error.message}
      </p>
    );
  }
  const data = status.data;
  if (!data) return null;
  if (data.status === 'NEVER') {
    return <p className="rs-magic-stale" role="status">The card catalog has not been loaded yet, so names cannot be resolved.</p>;
  }
  if (data.status === 'FAILED') {
    return (
      <p className="rs-magic-stale" role="status">
        The last catalog refresh failed ({data.lastError ?? 'no reason given'}); serving the cached index.
      </p>
    );
  }
  return <StaleNote freshness={data} />;
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
      {section === 'design' ? <DesignSection onBuilt={openDeck} /> : null}
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
