/**
 * Search, over everything one person may see.
 *
 * The scope is the server's — there is no project parameter to send — so this
 * renders results and never decides what somebody is allowed to find. What it
 * does decide is how an empty answer reads, and that is the part worth getting
 * right: nothing found across four projects and nothing found because you can
 * see none are different facts, and the count makes the difference visible.
 *
 * Saved views come down with the response rather than being kept here, so the
 * set a person sees and the set the server actually filters by are one object.
 */
import { useEffect, useState } from 'react';
import { RussellApi } from '../lib/russellApi.ts';
import type { SearchHit, SearchKind } from '../lib/russellApi.ts';
import { humanWhen } from './present.ts';

const KIND_WORDS: Record<SearchKind, string> = {
  CONVERSATION: 'Conversation',
  IDEA: 'Idea',
  MISSION: 'Work',
  KNOWLEDGE: 'Knows',
  DOCUMENT: 'Document',
  FRONTIER: 'Frontier',
};

/** How long to wait after the last keystroke before asking the server. */
const SETTLE_MS = 250;

export function Search({ onOpen }: { onOpen(href: string): void }): JSX.Element {
  const [term, setTerm] = useState('');
  const [kinds, setKinds] = useState<SearchKind[] | undefined>(undefined);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [scoped, setScoped] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [views, setViews] = useState<readonly { key: string; label: string; kinds: SearchKind[] }[]>(
    [],
  );
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (term.trim().length < 2) {
      setHits(null);
      return;
    }
    let cancelled = false;
    setBusy(true);
    /*
     * Debounced rather than fired per keystroke.
     *
     * Six queries per character is a load nobody notices until the project has
     * grown, and the results it produces are thrown away before they render.
     */
    const timer = setTimeout(() => {
      void RussellApi.search(term.trim(), kinds).then(
        (answer) => {
          if (cancelled) return;
          setHits(answer.results.hits);
          setScoped(answer.results.scopedProjects);
          setTruncated(answer.results.truncated);
          setViews(answer.savedViews);
          setProblem(null);
          setBusy(false);
        },
        () => {
          if (cancelled) return;
          // A failed search is not an empty one. Saying "no results" here would
          // be the interface inventing an answer the server never gave.
          setProblem('The search did not run. Nothing was found or missed — try again.');
          setHits(null);
          setBusy(false);
        },
      );
    }, SETTLE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [term, kinds]);

  return (
    <div className="rs-column">
      <p className="rs-eyebrow">Search</p>
      <h2 className="rs-view-title">Find anything you can see</h2>

      <div className="rs-build-submit">
        <label className="rs-visually-hidden" htmlFor="rs-search-input">
          Search everything
        </label>
        <input
          id="rs-search-input"
          type="search"
          value={term}
          placeholder="A name, a number, a question…"
          onChange={(event) => setTerm(event.target.value)}
        />
      </div>

      {views.length > 0 ? (
        <ul className="rs-starters">
          {views.map((view) => (
            <li key={view.key}>
              <button
                type="button"
                className="rs-starter"
                aria-pressed={
                  kinds !== undefined && kinds.join(',') === view.kinds.join(',') ? true : undefined
                }
                onClick={() =>
                  setKinds((current) =>
                    current !== undefined && current.join(',') === view.kinds.join(',')
                      ? undefined
                      : view.kinds,
                  )
                }
              >
                {view.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {problem ? (
        <p className="rs-state rs-state-error" role="alert">
          {problem}
        </p>
      ) : null}

      {term.trim().length > 0 && term.trim().length < 2 ? (
        <p className="rs-hint">Two characters or more — one matches everything.</p>
      ) : null}

      {busy ? <p className="rs-state rs-state-loading">Searching…</p> : null}

      {hits !== null && !busy ? (
        hits.length === 0 ? (
          <p className="rs-state rs-state-empty">
            Nothing matched “{term.trim()}” across{' '}
            {scoped === 1 ? 'the one project you can see' : `the ${scoped} projects you can see`}.
          </p>
        ) : (
          <>
            <ul className="rs-list" aria-label="Results">
              {hits.map((hit) => (
                <li key={`${hit.kind}:${hit.id}`}>
                  <button type="button" className="rs-card" onClick={() => onOpen(hit.href)}>
                    <span className="rs-row">
                      <span className="rs-item-title">{hit.title}</span>
                      <span className="rs-pill">{KIND_WORDS[hit.kind]}</span>
                    </span>
                    {hit.detail ? <span className="rs-item-meta">{hit.detail}</span> : null}
                    <Stamp at={hit.updatedAt} />
                  </button>
                </li>
              ))}
            </ul>
            {truncated ? (
              <p className="rs-hint">
                There are more matches than are shown. Narrow the words, or pick one of the views
                above.
              </p>
            ) : null}
          </>
        )
      ) : null}
    </div>
  );
}

function Stamp({ at }: { at: string | null }): JSX.Element | null {
  const when = humanWhen(at);
  if (!when || !at) return null;
  return (
    <span className="rs-item-meta">
      <time className="rs-when" dateTime={at} title={when.exact}>
        {when.text}
      </time>
    </span>
  );
}
