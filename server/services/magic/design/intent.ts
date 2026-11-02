/**
 * Rough idea -> structured intent. Deterministic keyword reading: no model, no
 * network. What the words do not say is left unset or recorded as an
 * assumption, never invented.
 */
import { ARCHETYPES, MAGIC_COLORS, type Archetype, type MagicColor, type MagicFormat } from '../../../domain/magicTypes.ts';
import type { Role } from '../analysis/tags.ts';
import type { DesignIntent, HardConstraint, Risk, Speed, WinEngine } from './types.ts';

const has = (t: string, re: RegExp) => re.test(t);

const ARCHETYPE_WORDS: [Archetype, RegExp][] = [
  ['aggro', /\baggro|aggressive|beatdown\b/],
  ['control', /\bcontrol|counterspell|permission\b/],
  ['midrange', /\bmidrange\b/],
  ['tempo', /\btempo\b/],
  ['combo', /\bcombo\b/],
  ['defensive', /\bdefensive|defence|defense|fortress|stop threats|protect(ive)?\b/],
  ['political', /\bpolitic|group hug|deal-making|monarch\b/],
  ['go-wide', /\bgo[- ]wide|tokens?|swarm\b/],
  ['sacrifice', /\bsacrifice|aristocrats?\b/],
  ['recursion', /\brecursion|reanimat|graveyard\b/],
  ['life-drain', /\blife[- ]?drain|drain\b/],
  ['tribal', /\btribal|typal\b/],
  ['artifacts', /\bartifacts?\b/],
  ['budget', /\bbudget|cheap|inexpensive\b/],
];

const ENGINE_WORDS: [WinEngine, RegExp][] = [
  ['lifedrain', /\bdrain|life ?loss|each opponent loses\b/],
  ['combat', /\bcombat|attack|beatdown|aggro\b/],
  ['combo', /\bcombo\b/],
  ['tokens', /\btokens?|go[- ]wide|swarm\b/],
  ['alt-win', /\balternate win|alt[- ]win\b/],
  ['artifacts', /\bartifacts?\b/],
  ['sacrifice', /\bsacrifice|aristocrats?\b/],
];

const PREFERENCE_WORDS: [Role, RegExp][] = [
  ['lifegain', /\blife ?gain|gain life|lifelink\b/],
  ['removal', /\bremoval|stop (threats|creatures)|ways to stop|answers?\b/],
  ['counter', /\bcounterspells?|counter\b/],
  ['draw', /\bcard draw|draw cards?|card advantage\b/],
  ['ramp', /\bramp|mana rocks?|early mana\b/],
  ['sweeper', /\bwraths?|board wipes?|sweepers?\b/],
  ['protection', /\bprotection|hexproof|indestructible\b/],
  ['recursion', /\brecursion|reanimat\b/],
  ['tutor', /\btutors?\b/],
];

const COLOR_WORDS: [MagicColor, RegExp][] = [
  ['W', /\bwhite\b/], ['U', /\bblue\b/], ['B', /\bblack\b/], ['R', /\bred\b/], ['G', /\bgreen\b/],
];

export function parseBudgetCents(text: string): number | null {
  const m = /(?:under|below|max(?:imum)?|budget(?: of)?|at most|up to|less than)\s*\$\s?(\d{1,6})(?:\.(\d{1,2}))?/.exec(text)
    ?? /\$\s?(\d{1,6})(?:\.(\d{1,2}))?\s*(?:budget|max|total)/.exec(text);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || 0);
}

function readFormat(t: string): MagicFormat | null {
  if (/\bcommander|edh\b/.test(t)) return 'COMMANDER';
  if (/\bstandard\b/.test(t)) return 'STANDARD';
  return null;
}

export interface Reading {
  format: MagicFormat | null;
  archetypes: Archetype[];
  speed: Speed | null;
  defensive: boolean;
  curve: 'high' | 'low' | null;
  earlyMana: boolean;
  winEngines: WinEngine[];
  preferences: Role[];
  colors: MagicColor[];
  excluded: string[];
  budgetCents: number | null;
  ownedOnly: boolean;
  risk: Risk | null;
  opponents: number | null;
}

export function readUtterance(raw: string): Reading {
  const t = raw.toLowerCase();
  const defensive = has(t, /\bdefensive|defen[cs]e|fortress|stop (threats|creatures)|ways to stop\b/);
  const fast = has(t, /\b(finish|win|close)[^.,;]{0,30}\b(quickly|fast|quick)\b|\bfast\b|\bquick(ly)?\b|\bturbo\b/);
  const slow = has(t, /\bslow|grindy|long game|late game\b/);
  const archetypes = ARCHETYPE_WORDS.filter(([, re]) => re.test(t)).map(([a]) => a);
  const winEngines = ENGINE_WORDS.filter(([, re]) => re.test(t)).map(([e]) => e);
  const excluded = [...raw.matchAll(/\b(?:no|without|exclude|never (?:play|include))\s+([A-Z][A-Za-z0-9',-]*(?:\s+[A-Z0-9][A-Za-z0-9',-]*)*)/g)].map((m) => m[1]!.trim());
  return {
    format: readFormat(t),
    archetypes: archetypes.filter((a, i) => archetypes.indexOf(a) === i),
    speed: fast ? 'fast' : slow ? 'slow' : null,
    defensive,
    curve: has(t, /\bhigh curve|top[- ]heavy|big spells|expensive spells\b/) ? 'high' : has(t, /\blow curve|cheap spells\b/) ? 'low' : null,
    earlyMana: has(t, /\bearly mana|ramp|mana rocks?|fast mana\b/),
    winEngines,
    preferences: PREFERENCE_WORDS.filter(([, re]) => re.test(t)).map(([r]) => r),
    colors: COLOR_WORDS.filter(([, re]) => re.test(t)).map(([c]) => c),
    excluded,
    budgetCents: parseBudgetCents(t),
    ownedOnly: has(t, /\bonly (cards )?i own|owned only|from my collection\b/),
    risk: has(t, /\bconsisten|reliab|never stumble\b/) ? 'consistency' : has(t, /\bhigh power|cedh|max power|explosive\b/) ? 'power' : null,
    opponents: has(t, /\b1v1|one on one|duel\b/) ? 1 : null,
  };
}

const uniq = <T>(xs: T[]) => xs.filter((x, i) => xs.indexOf(x) === i);

export function constraintsOf(i: DesignIntent): HardConstraint[] {
  const out: HardConstraint[] = [{ kind: 'format', format: i.format }];
  if (i.budgetCents !== null) out.push({ kind: 'budget', cents: i.budgetCents });
  return out;
}

/** The first reading of a rough idea. */
export function parseIdea(idea: string): DesignIntent {
  const r = readUtterance(idea);
  const assumptions: string[] = [];
  const format = r.format ?? 'COMMANDER';
  if (!r.format) assumptions.push('Format not stated: assuming Commander.');
  const opponents = r.opponents ?? (format === 'COMMANDER' ? 3 : 1);
  if (r.opponents === null) assumptions.push(`Opponents not stated: assuming ${opponents}.`);
  const risk: Risk = r.risk ?? 'balanced';
  if (!r.risk) assumptions.push('Risk preference not stated: balancing consistency and power.');
  if (r.budgetCents === null) assumptions.push('No budget stated: price is not a constraint.');
  const archetypes = r.archetypes.length ? r.archetypes : (['custom'] as Archetype[]);
  const intent: DesignIntent = {
    idea,
    revision: 1,
    format,
    primaryOutcome: r.defensive && !r.speed ? 'survive' : r.speed === 'fast' || r.winEngines.length ? 'win' : 'unspecified',
    archetypes: archetypes.filter((a) => (ARCHETYPES as readonly string[]).includes(a)),
    speed: r.speed,
    defensive: r.defensive,
    curve: r.curve,
    earlyMana: r.earlyMana,
    winEngines: r.winEngines,
    secondaryPreferences: r.preferences,
    hardConstraints: [],
    weights: {
      consistency: risk === 'consistency' ? 2 : 1,
      speed: r.speed === 'fast' ? 2 : 1,
      interaction: r.defensive ? 2 : 1,
      closing: r.speed === 'fast' || r.winEngines.length ? 2 : 1,
    },
    risk,
    collection: r.ownedOnly ? 'owned-only' : 'any',
    budgetCents: r.budgetCents,
    opponents,
    playstyle: archetypes.join(', '),
    assumptions,
    resolved: [],
    history: [{ revision: 1, utterance: idea }],
  };
  intent.hardConstraints = [
    ...constraintsOf(intent),
    ...(r.colors.length ? [{ kind: 'colors', colors: r.colors } as HardConstraint] : []),
    ...r.excluded.map((name) => ({ kind: 'exclude', name }) as HardConstraint),
    ...(r.ownedOnly ? [{ kind: 'owned-only' } as HardConstraint] : []),
  ];
  return intent;
}

/** Iterative refinement: a new utterance is read and merged over the intent. */
export function refineIntent(intent: DesignIntent, utterance: string): DesignIntent {
  const r = readUtterance(utterance);
  const next: DesignIntent = JSON.parse(JSON.stringify(intent));
  next.revision = intent.revision + 1;
  if (r.format) next.format = r.format;
  next.archetypes = uniq([...next.archetypes.filter((a) => a !== 'custom'), ...r.archetypes]);
  if (next.archetypes.length === 0) next.archetypes = ['custom'];
  if (r.speed) next.speed = r.speed;
  if (r.defensive) next.defensive = true;
  if (r.curve) next.curve = r.curve;
  if (r.earlyMana) next.earlyMana = true;
  next.winEngines = uniq([...next.winEngines, ...r.winEngines]);
  next.secondaryPreferences = uniq([...next.secondaryPreferences, ...r.preferences]);
  if (r.budgetCents !== null) next.budgetCents = r.budgetCents;
  if (r.risk) next.risk = r.risk;
  if (r.opponents !== null) next.opponents = r.opponents;
  if (r.ownedOnly) next.collection = 'owned-only';
  next.hardConstraints = [
    ...constraintsOf(next),
    ...next.hardConstraints.filter((c) => c.kind === 'exclude' || c.kind === 'colors'),
    ...r.excluded.filter((n) => !next.hardConstraints.some((c) => c.kind === 'exclude' && c.name === n)).map((name) => ({ kind: 'exclude', name }) as HardConstraint),
    ...(r.colors.length ? [{ kind: 'colors', colors: r.colors } as HardConstraint] : []),
    ...(next.collection === 'owned-only' ? [{ kind: 'owned-only' } as HardConstraint] : []),
  ];
  next.weights = {
    consistency: next.risk === 'consistency' ? 2 : 1,
    speed: next.speed === 'fast' ? 2 : 1,
    interaction: next.defensive ? 2 : 1,
    closing: next.speed === 'fast' || next.winEngines.length ? 2 : 1,
  };
  next.primaryOutcome = next.defensive && !next.speed ? 'survive' : next.speed === 'fast' || next.winEngines.length ? 'win' : next.primaryOutcome;
  next.playstyle = next.archetypes.join(', ');
  next.history = [...intent.history, { revision: next.revision, utterance }];
  void MAGIC_COLORS;
  return next;
}
