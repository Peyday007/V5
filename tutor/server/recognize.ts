import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { createWorker, type Worker } from 'tesseract.js';
import type { CardCatalog } from './games/mtg/catalog.ts';
import { normName } from './games/mtg/catalog.ts';
import { parseLine } from './decks/parse.ts';
import type { CoachModel, VisionModel } from './tutor/llm.ts';

/**
 * Reading a decklist screenshot or a photo of cards. The result is always a proposal shown to
 * the person, line by line, editable — recognition never adds a card by itself. OCR runs locally
 * (tesseract.js, English model fetched once into the data directory); when a vision-capable
 * model is configured it may be used for card photos, labelled as such.
 */
export interface RecognizedLine {
  text: string;
  quantity: number;
  name: string;
  status: 'exact' | 'close' | 'unreadable';
  candidates: string[];
  confidence: number;
}

let worker: Promise<Worker> | null = null;

function getWorker(dataDir: string): Promise<Worker> {
  if (!worker) {
    const cachePath = join(dataDir, 'ocr');
    mkdirSync(cachePath, { recursive: true });
    worker = createWorker('eng', 1, { cachePath });
  }
  return worker;
}

export async function recognizeImage(opts: { image: Buffer; kind: 'decklist' | 'cards'; catalog: CardCatalog; dataDir: string }): Promise<{ engine: string; lines: RecognizedLine[]; rawText: string }> {
  const w = await getWorker(opts.dataDir);
  const { data } = await w.recognize(opts.image);
  const raw = data.text ?? '';
  const textLines = raw.split('\n').map((l) => l.replace(/[|_~]+/g, ' ').replace(/\s+/g, ' ').trim()).filter((l) => l.length >= 3);
  const lines: RecognizedLine[] = [];
  const seen = new Set<string>();
  for (const t of textLines) {
    const p = parseLine(t);
    if (!p) continue;
    const name = p.name.replace(/[^\p{L}\p{N}' ,\-/:.!?&]/gu, '').trim();
    if (name.length < 3) continue;
    const exact = opts.catalog.exact(name);
    let status: RecognizedLine['status'];
    let candidates: string[];
    if (exact.length) { status = 'exact'; candidates = [exact[0]!.card.name]; }
    else {
      candidates = opts.catalog.suggest(name, 4);
      status = candidates.length ? 'close' : 'unreadable';
    }
    // For card photos the rules text and type lines also OCR; keep only lines that look like names.
    if (opts.kind === 'cards' && status === 'unreadable') continue;
    const key = normName(candidates[0] ?? name);
    if (opts.kind === 'cards' && seen.has(key)) continue;
    seen.add(key);
    lines.push({ text: t, quantity: p.quantity, name, status, candidates, confidence: Math.round(data.confidence ?? 0) });
  }
  return { engine: 'tesseract.js (local OCR)', lines, rawText: raw };
}

/** Card photos read by a configured vision model: names only, still confirmed by the person. */
export async function recognizeWithModel(model: CoachModel, image: Buffer, mediaType: string): Promise<string[]> {
  if (!model.configured || !('vision' in model)) return [];
  const names = await (model as CoachModel & VisionModel)
    .vision(image, mediaType, 'List the exact English card names visible in this photo of Magic: The Gathering cards, one per card. Do not guess names that are not readable.');
  return names;
}
