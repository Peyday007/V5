/**
 * The left pane: every layer of the project, in order, with its derived state.
 *
 * This is the screen the user scans first, so each row has to answer "is this
 * layer done, and if not what is stopping it?" without a click. Everything shown
 * comes from the `LayerStateSnapshot` the server just derived — the row never
 * computes a status of its own, so the list can never disagree with the layer
 * pane or the planner (invariant 7).
 */
import type { Layer, LayerStateSnapshot, Project } from '../../../server/domain/types.ts';
import { Badge } from './Badge.tsx';

/** How many missing canonical names fit on a row before we summarise the rest. */
const MISSING_PREVIEW = 2;

/**
 * Render a missing-dependency list the way the user needs to read it: by
 * canonical name, because "Missing: Discovery Logic v1G" is the answer, and a
 * count is not.
 */
function formatMissing(missing: string[]): string {
  const shown = missing.slice(0, MISSING_PREVIEW);
  const rest = missing.length - shown.length;
  const head = shown.join(', ');
  return rest > 0 ? `${head} (+${rest} more)` : head;
}

function documentCounts(snapshot: LayerStateSnapshot | undefined, layer: Layer): string {
  if (!snapshot) return `— / ${layer.expectedVersions.length}`;
  return `${snapshot.documentsComplete} / ${snapshot.documentsExpected}`;
}

export function LayerList(props: {
  project: Project | null;
  layers: Layer[];
  state: LayerStateSnapshot[];
  selectedLayerId: string | null;
  onSelect(layerId: string): void;
}): JSX.Element {
  const { project, layers, state, selectedLayerId } = props;

  const stateByLayer = new Map<string, LayerStateSnapshot>();
  for (const snapshot of state) stateByLayer.set(snapshot.layerId, snapshot);

  const ordered = [...layers].sort((a, b) => a.orderIndex - b.orderIndex);

  if (ordered.length === 0) {
    return (
      <div className="empty">
        {project
          ? `${project.name} has no layers yet. Layers are created with the project seed or through the API.`
          : 'No project is loaded.'}
      </div>
    );
  }

  const projectWave = project?.currentWave ?? null;

  return (
    <div className="layer-list">
      {ordered.map((layer, index) => {
        const snapshot = stateByLayer.get(layer.id);
        const status = snapshot?.status ?? layer.status;
        const selected = layer.id === selectedLayerId;
        const currentVersion = snapshot?.currentVersion ?? layer.currentVersion;
        const activeRuns = snapshot?.activeRunIds.length ?? 0;
        const missing = snapshot?.missingDependencies ?? [];
        const inconsistent = snapshot?.inconsistentDocuments ?? [];
        const nextAction = snapshot?.nextAction ?? '';
        const behind = projectWave !== null && layer.currentWave < projectWave;

        return (
          <button
            type="button"
            key={layer.id}
            className={`layer-row${selected ? ' layer-row--selected' : ''}`}
            aria-pressed={selected}
            onClick={() => props.onSelect(layer.id)}
            title={snapshot?.reason ?? layer.name}
          >
            <span className="spread">
              <span className="layer-row__name truncate">
                <span className="layer-row__index">{String(index + 1).padStart(2, '0')} </span>
                {layer.name.toUpperCase()}
              </span>
              <Badge status={status} title={snapshot?.reason ?? status} />
            </span>

            <span className="layer-row__meta">
              <span className={currentVersion ? 'info' : 'muted'}>{currentVersion ?? 'no version'}</span>
              <span>docs {documentCounts(snapshot, layer)}</span>
              <span className={behind ? 'warn' : undefined}>wave {layer.currentWave}</span>
              {activeRuns > 0 ? <span className="warn">{activeRuns} running</span> : null}
              {layer.parked ? <span className="muted">parked</span> : null}
            </span>

            {missing.length > 0 ? (
              <span className="layer-row__missing" title={missing.join('\n')}>
                Missing: {formatMissing(missing)}
              </span>
            ) : null}

            {inconsistent.length > 0 ? (
              <span className="layer-row__missing" title={inconsistent.join('\n')}>
                INCONSISTENT STATE: {formatMissing(inconsistent)} — file gone from disk
              </span>
            ) : null}

            {nextAction ? <span className="layer-row__next truncate">{nextAction}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
