/**
 * Where the puzzle kernel stands, and the one decision it waits on a person for.
 *
 * Every sentence here is the server's (`services/puzzle/view.ts`); nothing is
 * re-derived. The screen exists for one control. A format reaches SELLABLE only
 * when a person has recorded that they read or played what the machine made
 * (`HUMAN_EDIT_PASSED`), and until it does no product of it is promoted into
 * Cash — so no sale of it can ever be recorded against a piece. The route took
 * that observation and nothing in the product could send it, which is a
 * mechanism nothing calls.
 *
 * The control is offered only for a format at PRODUCTIZABLE whose next rung,
 * SELLABLE, the server says waits on a person: a qualified product exists, so
 * there is something to have read. Offered anywhere else it would record a
 * reading that moves nothing. It records a statement and decides nothing else —
 * the maturity ladder re-reads the rows and says what moved.
 */
import { useCallback, useState } from 'react';
import { api } from '../lib/api.ts';
import { useAsync } from './useAsync.ts';

interface FormatMaturity {
  formatKey: string;
  name: string;
  rung: string;
  waitingOn: string;
  remedy: 'CODE' | 'RESEARCH' | 'PERSON' | 'MONEY' | 'NOTHING';
  evidence: { validPuzzles: number; products: number; buyers: number };
}

interface Observation {
  id: string;
  kind: string;
  formatKey: string | null;
  statement: string;
  createdAt: string;
}

interface PuzzleView {
  rightNow: {
    formatsOnMap: number;
    formatsBrainCanMake: number;
    systems: number;
    validPuzzles: number;
    qualifiedProducts: number;
    promoted: number;
  };
  maturity: FormatMaturity[];
  recent: Observation[];
  needsPerson: { what: string; why: string }[];
  nextAction: string;
}

export function PuzzlesView({ projectId }: { projectId: string | null }): JSX.Element {
  const query = useAsync<PuzzleView | null>(
    async () => (projectId ? await api<PuzzleView>(`/api/projects/${projectId}/cash/puzzles`) : null),
    [projectId],
  );
  if (!projectId) return <p className="rs-empty">Open a project to see its puzzles.</p>;
  // The placeholder is for the first read only, so a reload never unmounts a form.
  if (query.loading && !query.data) return <p className="rs-empty">Reading the puzzle kernel…</p>;
  if (query.error) return <p className="rs-empty">{query.error.message}</p>;
  const view = query.data;
  if (!view) return <p className="rs-empty">Reading the puzzle kernel…</p>;

  const now = view.rightNow;
  return (
    <div className="rs-stack rs-puzzles">
      <section className="rs-card">
        <h2>Puzzles</h2>
        <p>
          {now.validPuzzles} proved puzzle(s) across {now.systems} system(s), {now.qualifiedProducts}{' '}
          qualified product(s), {now.promoted} in Cash.
        </p>
        <p className="rs-item-meta">{view.nextAction}</p>
      </section>

      <section className="rs-card">
        <h3>Formats</h3>
        <ul className="rs-list">
          {view.maturity.map((one) => (
            <li key={one.formatKey} className="rs-item">
              <strong>{one.name}</strong> — {one.rung}
              <p className="rs-item-meta">{one.waitingOn}</p>
              {one.rung === 'PRODUCTIZABLE' && one.remedy === 'PERSON' ? (
                <RecordRead projectId={projectId} format={one.name} reload={query.reload} />
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      {view.recent.length > 0 ? (
        <section className="rs-card">
          <h3>Recorded</h3>
          <ul className="rs-list">
            {view.recent.map((one) => (
              <li key={one.id} className="rs-item">
                {one.kind}
                {one.formatKey ? ` · ${one.formatKey}` : ''}: {one.statement}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function RecordRead({
  projectId,
  format,
  reload,
}: {
  projectId: string;
  format: string;
  reload: () => void;
}): JSX.Element {
  const [statement, setStatement] = useState('');
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const submit = useCallback(() => {
    if (busy || !statement.trim()) return;
    setBusy(true);
    setProblem(null);
    void api<{ message: string }>(`/api/projects/${projectId}/cash/puzzles/observations`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'HUMAN_EDIT_PASSED', format, statement }),
    }).then(
      (answer) => {
        setBusy(false);
        setSaid(answer.message);
        setStatement('');
        reload();
      },
      (error: unknown) => {
        setBusy(false);
        setProblem(error instanceof Error ? error.message : String(error));
      },
    );
  }, [busy, statement, projectId, format, reload]);

  return (
    <div className="rs-form">
      <label>
        What you read or played, and what you found
        <textarea
          aria-label={`What you read of ${format}`}
          value={statement}
          onChange={(event) => setStatement(event.target.value)}
          placeholder="e.g. Solved puzzles 1, 40 and 90 of the Vol. 1 PDF; each had one solution and the layout printed cleanly."
        />
      </label>
      <button type="button" onClick={submit} disabled={busy || !statement.trim()}>
        Record that a person read it
      </button>
      {said ? <p className="rs-item-meta">{said}</p> : null}
      {problem ? <p className="rs-item-meta">{problem}</p> : null}
    </div>
  );
}
