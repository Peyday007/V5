/**
 * Three visually distinct, clickable proofs of concept of the world
 * (UI-27-5, S-0428), each over the same facts and the same lens. They differ
 * only in theme, layout and art direction — never in what they say — so the
 * owner can choose an art direction by comparing them side by side.
 */
import { useReducer, useState } from 'react';
import type { WorldFact } from '../../../../server/routes/world.ts';
import { decideRenderMode, readCapabilitySignals, type WorldRenderMode } from '../capability.ts';
import { initialLensState, lensReducer } from '../lens.ts';
import { DRAGON_THEME, PLAIN_THEME, type ThemeDefinition } from '../theme.ts';
import type { TruthContext } from '../truth.ts';
import { WorldScene, type SceneLayout } from '../WorldScene.tsx';
import { SAMPLE_FACTS, SAMPLE_GENERATED_AT, SAMPLE_PROJECT_ID } from './sample.ts';

export interface WorldPrototype {
  id: string;
  name: string;
  description: string;
  theme: ThemeDefinition;
  layout: SceneLayout;
}

export const PROTOTYPES: readonly WorldPrototype[] = [
  { id: 'citadel', name: 'Dragon citadel', description: 'Isometric districts in the dragon art direction.', theme: DRAGON_THEME, layout: 'ISOMETRIC' },
  { id: 'ledger', name: 'Ledger map', description: 'A flat grid of plain panels, closest to the operations view.', theme: PLAIN_THEME, layout: 'GRID' },
  { id: 'constellation', name: 'Constellation', description: 'Districts on a ring around the citadel, for an at-a-glance whole.', theme: DRAGON_THEME, layout: 'RADIAL' },
];

export interface WorldPrototypesProps {
  /** Live facts. When omitted, the clearly marked sample state is used. */
  facts?: readonly WorldFact[];
  ctx?: TruthContext;
  mode?: WorldRenderMode;
  initial?: string;
}

export function WorldPrototypes({ facts, ctx, mode, initial = 'citadel' }: WorldPrototypesProps) {
  const sample = facts === undefined;
  const shownFacts = facts ?? SAMPLE_FACTS;
  const context: TruthContext = ctx ?? { world: { generatedAt: SAMPLE_GENERATED_AT, projectId: SAMPLE_PROJECT_ID }, nowMs: Date.parse(SAMPLE_GENERATED_AT) };
  const renderMode = mode ?? decideRenderMode(readCapabilitySignals()).mode;
  const [lens, dispatch] = useReducer(lensReducer, undefined, initialLensState);
  const [chosen, setChosen] = useState(initial);
  const proto = PROTOTYPES.find((p) => p.id === chosen) ?? PROTOTYPES[0]!;
  return (
    <div className="world-prototypes">
      <div className="world-prototype-picker" role="group" aria-label="Prototype">
        {PROTOTYPES.map((p) => (
          <button key={p.id} type="button" aria-pressed={p.id === proto.id} onClick={() => setChosen(p.id)} title={p.description}>
            {p.name}
          </button>
        ))}
      </div>
      <WorldScene facts={shownFacts} mode={renderMode} lens={lens} onLensAction={dispatch} ctx={context} theme={proto.theme} layout={proto.layout} sample={sample} variant={proto.id} />
    </div>
  );
}
