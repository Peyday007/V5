import { randomUUID } from 'node:crypto';
import type { Db } from '../store/db.ts';
import { nowIso } from '../store/db.ts';
import type { ResolutionChoices } from '../games/types.ts';

/**
 * Saved decks. A deck is stored as the text it was imported from plus the person's answers to
 * every resolution question, so re-opening it reproduces exactly what they confirmed — quantities
 * as uploaded, nothing silently changed.
 */
export interface StoredDeck {
  id: string;
  name: string;
  game: string;
  format: string;
  sourceText: string;
  sourceKind: 'text' | 'csv';
  choices: ResolutionChoices;
  createdAt: string;
  updatedAt: string;
}

export function saveDeck(db: Db, d: Omit<StoredDeck, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): StoredDeck {
  const now = nowIso();
  const id = d.id ?? randomUUID();
  const existing = d.id ? getDeck(db, d.id) : null;
  const data = JSON.stringify({ choices: d.choices, sourceKind: d.sourceKind });
  if (existing) {
    db.prepare('UPDATE decks SET name = ?, format = ?, source_text = ?, data = ?, updated_at = ? WHERE id = ?')
      .run(d.name, d.format, d.sourceText, data, now, id);
  } else {
    db.prepare('INSERT INTO decks (id, name, game, format, source_text, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, d.name, d.game, d.format, d.sourceText, data, now, now);
  }
  return getDeck(db, id)!;
}

export function getDeck(db: Db, id: string): StoredDeck | null {
  const r = db.prepare('SELECT * FROM decks WHERE id = ?').get(id) as Record<string, string> | undefined;
  return r ? fromRow(r) : null;
}

export function listDecks(db: Db): StoredDeck[] {
  return (db.prepare('SELECT * FROM decks ORDER BY updated_at DESC').all() as Array<Record<string, string>>).map(fromRow);
}

export function deleteDeck(db: Db, id: string): boolean {
  return db.prepare('DELETE FROM decks WHERE id = ?').run(id).changes > 0;
}

function fromRow(r: Record<string, string>): StoredDeck {
  const data = JSON.parse(r.data!) as { choices: ResolutionChoices; sourceKind: 'text' | 'csv' };
  return {
    id: r.id!, name: r.name!, game: r.game!, format: r.format!, sourceText: r.source_text!,
    sourceKind: data.sourceKind ?? 'text', choices: data.choices ?? {}, createdAt: r.created_at!, updatedAt: r.updated_at!,
  };
}
