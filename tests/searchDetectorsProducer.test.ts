/**
 * Learned detectors have a production producer.
 *
 * Before this, `createDetectorFromExamples` and `recordDetectorExample` were
 * called only from tests. No detector was ever created in the running Brain,
 * no judged firing ever accrued, and SHADOW-to-ACTIVE promotion could not
 * happen. These tests write only what production writes, feed items and the
 * cheap lane's SCREEN_LEAD answers. They call nothing but `runDetectors()`, the
 * entry Russell's feeds pass uses, and read the rows it leaves.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { insertFeedItems } from '../server/repos/feeds.ts';
import { DELIVERABLE_KINDS } from '../server/services/cash/deliverables/spec.ts';
import { coveredItems, runDetectors } from '../server/services/feeds/detectors.ts';
import { MIN_JUDGED_FOR_PROMOTION } from '../server/services/feeds/learned.ts';
import { labelOf, SCREEN_LABELLER } from '../server/services/feeds/learnFromScreens.ts';

const KIND = DELIVERABLE_KINDS[0]!;
let seq = 0;

/** A feed item and the two models' SCREEN_LEAD answers on it, as the cheap lane stores them. */
async function screened(title: string, answers: readonly ('KEEP' | 'DROP' | 'UNSURE')[]): Promise<string> {
  const ext = `e${seq++}`;
  await insertFeedItems('jobs', [{ externalId: ext, url: `https://x.test/${ext}`, title, body: null, organization: null, publishedAt: null }]);
  const row = await getDb().get<{ id: string }>('SELECT id FROM feed_items WHERE external_id = ?', [ext]);
  const id = row!.id;
  for (const [i, verdict] of answers.entries()) {
    const output = JSON.stringify({ verdict, window: 'SHORT', deliverable: verdict === 'KEEP' ? KIND : 'NONE', need: 'a stated need', payer: '', reason: 'r' });
    await getDb().run(
      `INSERT INTO cheap_results (id, kind, input_hash, subject_id, model, ok, output, error, created_at) VALUES (?, 'SCREEN_LEAD', ?, ?, ?, 1, ?, NULL, ?)`,
      [`cr_${id}_${i}`, `h_${id}`, id, `model-${i}`, output, new Date().toISOString()],
    );
  }
  return id;
}

const detectors = () => getDb().all<{ id: string; detector_key: string; mode: string; scope: string }>('SELECT id, detector_key, mode, scope FROM learned_detectors');
const examples = (detectorId: string) =>
  getDb().all<{ item_ref: string; fired: number; verdict: string; labelled_by: string }>('SELECT item_ref, fired, verdict, labelled_by FROM detector_examples WHERE detector_id = ?', [detectorId]);

describe('learned detectors, produced from the feed run alone', () => {
  beforeEach(async () => {
    await freshProject();
    seq = 0;
  });

  it('a single answer, a disagreement or UNSURE labels nothing; two agreeing answers do', () => {
    const keep = { verdict: 'KEEP' as const, window: 'SHORT' as const, deliverable: KIND, need: 'n', payer: '', reason: 'r' };
    const drop = { ...keep, verdict: 'DROP' as const, deliverable: 'NONE' as const };
    expect(labelOf([keep])).toBeNull();
    expect(labelOf([keep, drop])).toBeNull();
    expect(labelOf([{ ...keep, verdict: 'UNSURE' }, { ...keep, verdict: 'UNSURE' }])).toBeNull();
    expect(labelOf([keep, null])).toBeNull();
    expect(labelOf([keep, keep])).toBe('CONFIRMED');
    expect(labelOf([drop, drop])).toBe('REJECTED');
  });

  it('proposes a GENERAL SHADOW detector from agreed screen answers, never measured on its own examples', async () => {
    for (const t of ['Welding fabricator needed now', 'Senior welding fabricator role', 'Welding fabricator for trailers']) await screened(t, ['KEEP', 'KEEP']);
    await screened('Pastry chef wanted', ['DROP', 'DROP']);
    await screened('Welding fabricator maybe', ['KEEP']); // one answer: not a label

    await runDetectors();
    const made = await detectors();
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ scope: 'GENERAL', mode: 'SHADOW' });
    expect(made[0]!.detector_key).toBe('screen:jobs:fabricator+welding');
    expect(await examples(made[0]!.id)).toHaveLength(0);

    // A second pass over the same answers creates nothing new.
    await runDetectors();
    expect(await detectors()).toHaveLength(1);
  });

  it('judges firings on later screened items and promotes on measured precision, then covers matching items', async () => {
    for (const t of ['Welding fabricator needed now', 'Senior welding fabricator role', 'Welding fabricator for trailers']) await screened(t, ['KEEP', 'KEEP']);
    await screened('Pastry chef wanted', ['DROP', 'DROP']);
    await runDetectors();
    const [detector] = await detectors();

    const fresh: string[] = [];
    for (let i = 0; i < MIN_JUDGED_FOR_PROMOTION; i++) fresh.push(await screened(`Welding fabricator job ${i}`, ['KEEP', 'KEEP']));
    const missed = await screened('Barista wanted', ['DROP', 'DROP']);
    await runDetectors();

    const rows = await examples(detector!.id);
    const firedConfirmed = rows.filter((r) => r.fired === 1 && r.verdict === 'CONFIRMED').map((r) => r.item_ref).sort();
    expect(firedConfirmed).toEqual([...fresh].sort());
    expect(rows.find((r) => r.item_ref === missed)).toMatchObject({ fired: 0, verdict: 'REJECTED' });
    expect(rows.every((r) => r.labelled_by === SCREEN_LABELLER)).toBe(true);
    expect((await detectors())[0]!.mode).toBe('ACTIVE');

    const next = await screened('Welding fabricator urgently needed', []);
    await runDetectors();
    expect((await coveredItems([next])).has(next)).toBe(true);
  });

  it('refuses promotion when the screen rejects what the detector fires on', async () => {
    for (const t of ['Welding fabricator needed now', 'Senior welding fabricator role', 'Welding fabricator for trailers']) await screened(t, ['KEEP', 'KEEP']);
    await runDetectors();
    for (let i = 0; i < MIN_JUDGED_FOR_PROMOTION; i++) await screened(`Welding fabricator scam ${i}`, ['DROP', 'DROP']);
    await runDetectors();
    const [detector] = await detectors();
    expect(detector!.mode).toBe('SHADOW');
    expect((await examples(detector!.id)).filter((r) => r.fired === 1 && r.verdict === 'REJECTED')).toHaveLength(MIN_JUDGED_FOR_PROMOTION);
  });
});
