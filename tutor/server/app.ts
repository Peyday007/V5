import express, { type Request, type Response, type NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Ctx } from './context.ts';
import { looksLikeCsv, parseDecklistCsv, parseDecklistText } from './decks/parse.ts';
import { deleteDeck, getDeck, listDecks, saveDeck, type StoredDeck } from './decks/store.ts';
import { MtgAdapter, OPPONENT_DECKS, fixtureText } from './games/mtg/adapter.ts';
import type { ResolutionChoices } from './games/types.ts';
import { ask, type Question } from './tutor/tutor.ts';
import { createCoachModel, type CoachModel } from './tutor/llm.ts';
import { bump, conceptFor, profile, recordEvent, review } from './learning.ts';
import { nowIso } from './store/db.ts';
import { recognizeImage, recognizeWithModel } from './recognize.ts';

/**
 * The tutor's HTTP API. The shell (decks, matches, learning) is game-agnostic; everything about
 * Magic goes through the MTG adapter. Model credentials and the Forge bridge stay server-side.
 */
export function createApp(ctx: Ctx, opts: { model?: CoachModel } = {}) {
  const app = express();
  app.use(express.json({ limit: '15mb' }));
  const mtg = new MtgAdapter(ctx);
  const model = opts.model ?? createCoachModel(ctx.config.anthropicKey, ctx.config.model);
  const lastRecorded = new Map<string, number>();
  const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };

  async function loadDeck(stored: StoredDeck) {
    const parsed = stored.sourceKind === 'csv' ? parseDecklistCsv(stored.sourceText) : parseDecklistText(stored.sourceText);
    const deck = await mtg.resolve(parsed, stored.choices);
    deck.name = stored.name;
    return deck;
  }

  // ------------------------------------------------------------------ status
  app.get('/api/status', wrap(async (_req, res) => {
    const engine = await ctx.forge.health();
    res.json({
      games: [{ id: mtg.game, label: mtg.label, formats: mtg.formats() }],
      engine: engine ? { reachable: true, name: 'Forge', version: engine.forgeVersion, revision: engine.forgeRevision, cards: engine.uniqueCards } : { reachable: false, name: 'Forge', setup: 'Run `npm run forge:setup` once, then `npm run bridge`.' },
      catalog: ctx.catalog.status(),
      rules: ctx.rules.info(),
      coach: { configured: model.configured, model: model.label, note: model.configured ? 'Live coaching uses the configured model; engine facts are always shown beside it.' : 'No language model is configured (ANTHROPIC_API_KEY). Engine-grounded explanations and rule-of-thumb hints still work; live model coaching is off.' },
      attribution: [
        'Gameplay and AI opponents: Forge (https://github.com/Card-Forge/forge), GPL-3.0.',
        'Card data and images: Scryfall (https://scryfall.com). Portions are unofficial Fan Content permitted under the Wizards of the Coast Fan Content Policy; card text and images are copyright Wizards of the Coast, LLC.',
        'Rules: Magic: The Gathering Comprehensive Rules, Wizards of the Coast (https://magic.wizards.com/en/rules).',
        'Sample decklists: MTGJSON (https://mtgjson.com), cross-checked against Wizards of the Coast\'s published lists.',
      ],
    });
  }));

  app.post('/api/admin/sync', wrap(async (_req, res) => {
    const cards = await ctx.catalog.sync();
    const rules = await ctx.rules.sync();
    res.json({ cards, rules });
  }));

  // ------------------------------------------------------------------ decks
  app.get('/api/fixtures', (_req, res) => {
    res.json([
      { id: 'hail-caesar', name: 'Hail, Caesar — Fallout Commander precon (Caesar, Legion\'s Emperor)', verified: 'MTGJSON PIP deck file, cross-checked with Wizards\' published decklist' },
      ...OPPONENT_DECKS.map((d) => ({ ...d, verified: 'MTGJSON PIP deck file' })),
    ]);
  });
  app.get('/api/fixtures/:id', (req, res) => {
    try { res.type('text/plain').send(fixtureText(req.params.id!)); } catch { res.status(404).json({ error: 'No such sample deck.' }); }
  });

  function parse(text: string, filename?: string) {
    const csv = looksLikeCsv(text, filename);
    return { parsed: csv ? parseDecklistCsv(text) : parseDecklistText(text), kind: (csv ? 'csv' : 'text') as 'csv' | 'text' };
  }

  app.post('/api/decks/preview', wrap(async (req, res) => {
    const { text, filename, choices, format } = req.body as { text: string; filename?: string; choices?: ResolutionChoices; format?: string };
    if (typeof text !== 'string' || !text.trim()) { res.status(400).json({ error: 'Paste a decklist or upload a file first.' }); return; }
    const { parsed, kind } = parse(text, filename);
    const deck = await mtg.resolve(parsed, choices ?? {});
    const report = await mtg.validate(deck, format ?? 'commander');
    res.json({ deck, report, sourceKind: kind });
  }));

  app.post('/api/decks', wrap(async (req, res) => {
    const { id, name, text, filename, choices, format } = req.body as { id?: string; name?: string; text: string; filename?: string; choices?: ResolutionChoices; format?: string };
    if (typeof text !== 'string' || !text.trim()) { res.status(400).json({ error: 'A deck needs its list.' }); return; }
    if ((format ?? 'commander') !== 'commander') { res.status(400).json({ error: 'Only Commander is implemented and verified.' }); return; }
    const { parsed, kind } = parse(text, filename);
    const stored = saveDeck(ctx.db, { id, name: name?.trim() || parsed.name || 'My deck', game: 'mtg', format: 'commander', sourceText: text, sourceKind: kind, choices: choices ?? {} });
    const deck = await loadDeck(stored);
    const report = await mtg.validate(deck, stored.format);
    res.json({ stored, deck, report });
  }));

  app.get('/api/decks', wrap(async (_req, res) => {
    const out = [];
    for (const s of listDecks(ctx.db)) {
      const deck = await loadDeck(s);
      const cmd = deck.commanderIds.map((cid) => deck.lines.find((l) => l.card?.id === cid)?.card).filter(Boolean);
      out.push({ id: s.id, name: s.name, format: s.format, updatedAt: s.updatedAt, cards: deck.lines.filter((l) => l.section === 'main' || l.section === 'commander').reduce((n, l) => n + l.quantity, 0), commander: cmd.map((c) => ({ name: c!.name, image: c!.image })), unresolved: deck.lines.filter((l) => l.status !== 'resolved').length });
    }
    res.json(out);
  }));

  app.get('/api/decks/:id', wrap(async (req, res) => {
    const s = getDeck(ctx.db, req.params.id!);
    if (!s) { res.status(404).json({ error: 'No such deck.' }); return; }
    const deck = await loadDeck(s);
    res.json({ stored: s, deck, report: await mtg.validate(deck, s.format) });
  }));

  app.delete('/api/decks/:id', (req, res) => { res.json({ deleted: deleteDeck(ctx.db, req.params.id!) }); });

  app.get('/api/decks/:id/guide', wrap(async (req, res) => {
    const s = getDeck(ctx.db, req.params.id!);
    if (!s) { res.status(404).json({ error: 'No such deck.' }); return; }
    res.json(await mtg.guide(await loadDeck(s)));
  }));

  app.get('/api/cards/explain', wrap(async (req, res) => {
    const ref = String(req.query.ref ?? '');
    const s = req.query.deckId ? getDeck(ctx.db, String(req.query.deckId)) : null;
    res.json(await mtg.explainCard(s ? await loadDeck(s) : null, ref));
  }));

  // ------------------------------------------------------------------ image recognition
  app.post('/api/recognize', wrap(async (req, res) => {
    const { image, kind } = req.body as { image: string; kind?: 'decklist' | 'cards' };
    const m = typeof image === 'string' ? image.match(/^data:(image\/[a-z+]+);base64,(.*)$/s) : null;
    if (!m) { res.status(400).json({ error: 'Send an image as a data URL.' }); return; }
    const buf = Buffer.from(m[2]!, 'base64');
    const ocr = await recognizeImage({ image: buf, kind: kind === 'cards' ? 'cards' : 'decklist', catalog: ctx.catalog, dataDir: ctx.config.dataDir });
    let modelNames: string[] = [];
    let modelNote: string | null = null;
    if (kind === 'cards' && model.configured) {
      try {
        modelNames = (await recognizeWithModel(model, buf, m[1]!)).filter((n) => ctx.catalog.exact(n).length > 0);
      } catch (e) { modelNote = `Vision model unavailable: ${(e as Error).message}`; }
    }
    res.json({ ...ocr, modelNames, modelNote, note: 'Recognition is a proposal: check every line, fix or remove it, then add it to your list.' });
  }));

  // ------------------------------------------------------------------ matches
  app.post('/api/matches', wrap(async (req, res) => {
    const { deckId, opponents, coachMode, scenario } = req.body as { deckId: string; opponents?: number; coachMode?: string; scenario?: string[] };
    if (scenario && process.env.TUTOR_BRIDGE_SCENARIOS !== '1') { res.status(400).json({ error: 'Scenario positions are for tests and are not enabled on this server.' }); return; }
    const s = getDeck(ctx.db, deckId);
    if (!s) { res.status(404).json({ error: 'No such deck.' }); return; }
    const n = opponents === 3 ? 3 : 1;
    let created;
    try {
      created = await mtg.createMatch(await loadDeck(s), { opponents: n, opponentDecks: [], scenario });
    } catch (e) {
      res.status(409).json({ error: (e as Error).message });
      return;
    }
    const id = randomUUID();
    const mode = ['teach', 'hints', 'practice'].includes(coachMode ?? '') ? coachMode! : 'teach';
    ctx.db.prepare('INSERT INTO matches (id, deck_id, engine_match_id, mode, coach_mode, opponents, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, deckId, created.engineMatchId, created.mode, mode, JSON.stringify(OPPONENT_DECKS.slice(0, n).map((d) => d.id)), nowIso());
    res.json({ id, mode: created.mode, coachMode: mode, players: created.players });
  }));

  function matchRow(id: string) {
    return ctx.db.prepare('SELECT * FROM matches WHERE id = ?').get(id) as { id: string; deck_id: string; engine_match_id: string; mode: string; coach_mode: string; ended_at: string | null } | undefined;
  }

  app.get('/api/matches/:id/state', wrap(async (req, res) => {
    const m = matchRow(req.params.id!);
    if (!m) { res.status(404).json({ error: 'No such match.' }); return; }
    const after = Number(req.query.after ?? 0);
    const wait = Math.min(Number(req.query.wait ?? 0), 25_000);
    const s = await mtg.matchState(m.engine_match_id, after, wait);
    const rev = Number(s.revision ?? 0);
    if (rev > (lastRecorded.get(m.id) ?? 0)) {
      lastRecorded.set(m.id, rev);
      if (s.decision) {
        const d = s.decision;
        const ready = (d.actions ?? []).filter((a: any) => a.category === 'spell' && a.affordable !== false && a.hasTargets !== false).map((a: any) => a.label.replace(/^Cast /, ''));
        recordEvent(ctx.db, m.id, 'decision', { revision: rev, type: d.type, prompt: d.prompt, turn: s.turn, phase: s.phase, myTurn: s.activePlayerId === s.humanPlayerId, stackSize: (s.stack ?? []).length, legal: (d.actions ?? []).length, readySpells: ready });
      }
      if (s.status === 'over' && !m.ended_at) {
        ctx.db.prepare('UPDATE matches SET ended_at = ?, outcome = ? WHERE id = ?').run(nowIso(), JSON.stringify(s.outcome ?? null), m.id);
        recordEvent(ctx.db, m.id, 'outcome', s.outcome ?? {});
      }
    }
    res.json({ ...s, coachMode: m.coach_mode, matchId: m.id });
  }));

  app.post('/api/matches/:id/act', wrap(async (req, res) => {
    const m = matchRow(req.params.id!);
    if (!m) { res.status(404).json({ error: 'No such match.' }); return; }
    const { revision, action } = req.body as { revision: number; action: Record<string, unknown> };
    const before = await mtg.matchState(m.engine_match_id, 0, 0);
    const offered = (before.decision?.actions ?? []).find((a: any) => a.id === action?.id);
    const r = await mtg.act(m.engine_match_id, revision, action);
    const me = (before.players ?? []).find((p: any) => p.isHuman);
    const isCommanderCast = !!offered?.cardId && (me?.commanders ?? []).some((c: any) => c.cardId === offered.cardId) && String(action?.id).startsWith('play:');
    recordEvent(ctx.db, m.id, 'action', { id: action?.id, label: offered?.label ?? action?.id, accepted: r.ok, error: r.error ?? null, revision, turn: before.turn, phase: before.phase, isCommanderCast });
    if (before.decision) {
      const concept = conceptFor(before.decision.type, { stackSize: (before.stack ?? []).length, myTurn: before.activePlayerId === before.humanPlayerId, phase: before.phase });
      if (r.ok) bump(ctx.db, concept, 'practiced');
      else if (!/earlier position/.test(r.error ?? '')) bump(ctx.db, concept, 'misunderstood', r.error ?? undefined);
      if (isCommanderCast && (me?.commanders?.[0]?.timesCast ?? 0) > 0) bump(ctx.db, 'commander-tax', 'practiced');
    }
    res.status(r.ok ? 200 : 409).json(r);
  }));

  app.post('/api/matches/:id/automation', wrap(async (req, res) => {
    const m = matchRow(req.params.id!);
    if (!m) { res.status(404).json({ error: 'No such match.' }); return; }
    res.json(await mtg.setAutomation(m.engine_match_id, req.body ?? {}));
  }));

  app.post('/api/matches/:id/coach-mode', (req, res) => {
    const mode = String(req.body?.coachMode ?? '');
    if (!['teach', 'hints', 'practice'].includes(mode)) { res.status(400).json({ error: 'Coach mode is teach, hints or practice.' }); return; }
    ctx.db.prepare('UPDATE matches SET coach_mode = ? WHERE id = ?').run(mode, req.params.id!);
    res.json({ coachMode: mode });
  });

  app.post('/api/matches/:id/concede', wrap(async (req, res) => {
    const m = matchRow(req.params.id!);
    if (!m) { res.status(404).json({ error: 'No such match.' }); return; }
    await mtg.concede(m.engine_match_id);
    res.json({ ok: true });
  }));

  app.post('/api/matches/:id/tutor', wrap(async (req, res) => {
    const m = matchRow(req.params.id!);
    if (!m) { res.status(404).json({ error: 'No such match.' }); return; }
    const { question, revision, cardId, sinceSeq, cardRef } = req.body as { question: Question; revision: number; cardId?: number; sinceSeq?: number; cardRef?: string };
    const state = await mtg.matchState(m.engine_match_id, 0, 0);
    if (question !== 'explain-card' && !answersCurrentDecision(state, Number(revision))) {
      res.status(409).json({ error: 'The position changed since you asked; ask again for the current position.', stale: true, revision: state.revision });
      return;
    }
    const s = getDeck(ctx.db, m.deck_id);
    const kit = mtg.tutorKit(s ? await loadDeck(s) : null);
    const answer = await ask(kit, model, state, question, { cardId, sinceSeq, cardRef, coachMode: m.coach_mode });
    recordEvent(ctx.db, m.id, 'tutor', { question, revision, headline: answer.explanation?.headline ?? null, recommendedActionId: answer.recommendation?.actionId ?? null, source: answer.recommendation?.source ?? null });
    if (question === 'why') bump(ctx.db, 'timing', 'misunderstood', answer.explanation?.headline);
    res.json(answer);
  }));

  app.get('/api/matches/:id/review', wrap(async (req, res) => {
    const m = matchRow(req.params.id!);
    if (!m) { res.status(404).json({ error: 'No such match.' }); return; }
    const s = getDeck(ctx.db, m.deck_id);
    const guide = s ? await mtg.guide(await loadDeck(s)) : null;
    res.json(review(ctx.db, m.id, guide));
  }));

  app.get('/api/matches', (_req, res) => {
    res.json(ctx.db.prepare('SELECT m.id, m.deck_id AS deckId, d.name AS deckName, m.mode, m.coach_mode AS coachMode, m.created_at AS createdAt, m.ended_at AS endedAt, m.outcome FROM matches m LEFT JOIN decks d ON d.id = m.deck_id ORDER BY m.created_at DESC LIMIT 30').all());
  });

  app.get('/api/learning', (_req, res) => { res.json(profile(ctx.db)); });

  // ------------------------------------------------------------------ the built client
  const dist = join(dirname(fileURLToPath(import.meta.url)), '../client/dist');
  if (existsSync(dist)) {
    app.use(express.static(dist));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(join(dist, 'index.html')));
  }

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    res.status(500).json({ error: err.message });
  });
  return app;
}

/**
 * A revision answers the open decision if it was published while that decision was open: the
 * bridge republishes the same choice when only the log or board redraws, and that must not make a
 * question or a click "stale".
 */
export function answersCurrentDecision(state: Record<string, any>, revision: number): boolean {
  const now = Number(state.revision ?? 0);
  if (!state.decision) return revision === now;
  const since = Number(state.decisionSince ?? now);
  return revision >= since && revision <= now;
}
