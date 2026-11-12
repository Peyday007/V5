/**
 * Role tags from oracle data plus curated, machine-testable rules.
 *
 * Every rule is a pattern over a card's printed type line or oracle text, with
 * an id, so a tag can be traced to the rule that produced it. A tag proposed by
 * anything else (a model, a person's guess) is a PROPOSAL and is never counted
 * until `acceptProposals` finds it satisfies one of these rules.
 */
export const ROLES = [
  'land', 'ramp', 'draw', 'removal', 'sweeper', 'counter', 'lifegain', 'drain', 'threat', 'finisher', 'engine', 'protection', 'tutor', 'recursion',
] as const;
export type Role = (typeof ROLES)[number];

export const THREAT_TYPES = ['creature', 'artifact', 'enchantment', 'planeswalker', 'spell', 'any'] as const;
export type AnswerType = (typeof THREAT_TYPES)[number];

export interface TaggableCard {
  name: string;
  typeLine: string;
  oracleText?: string;
  cmc?: number;
}

export interface TagRule {
  id: string;
  role: Role;
  test: (card: TaggableCard) => boolean;
}

const text = (c: TaggableCard) => (c.oracleText ?? '').toLowerCase();
const type = (c: TaggableCard) => c.typeLine.toLowerCase();
const isLand = (c: TaggableCard) => /\bland\b/.test(type(c));

export const TAG_RULES: readonly TagRule[] = [
  { id: 'land.type', role: 'land', test: isLand },
  { id: 'ramp.add-mana', role: 'ramp', test: (c) => !isLand(c) && /\badd \{?[wubrgc0-9]|add (one|two|three) mana|adds? an amount of/.test(text(c)) },
  { id: 'ramp.fetch-land', role: 'ramp', test: (c) => !isLand(c) && /search your library for (up to \w+ |a |an )?(basic )?(land|forest|plains|island|swamp|mountain)[^.]*onto the battlefield/.test(text(c)) },
  { id: 'draw.draw-cards', role: 'draw', test: (c) => /\bdraws? (a|an|two|three|four|x|\d+) cards?\b|\bdraw a card\b/.test(text(c)) },
  { id: 'draw.impulse', role: 'draw', test: (c) => /exile the top (card|\w+ cards) of your library[^.]*you may (play|cast)/.test(text(c)) },
  { id: 'removal.destroy-exile', role: 'removal', test: (c) => !isLand(c) && /(destroy|exile) target|deals? \w+ damage to (any target|target creature)|target creature gets -\d+\/-\d+|return target [^.]* to its owner's hand/.test(text(c)) },
  { id: 'sweeper.all', role: 'sweeper', test: (c) => /(destroy|exile) all |each creature|deals? \d+ damage to each (creature|opponent and each creature)|all creatures get -\d+\/-\d+/.test(text(c)) && !/all creatures you control/.test(text(c)) },
  { id: 'counter.counter-spell', role: 'counter', test: (c) => /counter target (spell|activated|triggered|noncreature|creature spell)/.test(text(c)) },
  { id: 'lifegain.gain', role: 'lifegain', test: (c) => /you gain \w+ life|gain life equal|lifelink/.test(text(c)) },
  { id: 'drain.loses-life', role: 'drain', test: (c) => /each (opponent|other player) loses \w+ life|target (opponent|player) loses \w+ life|loses life equal/.test(text(c)) },
  { id: 'threat.creature', role: 'threat', test: (c) => /\bcreature\b/.test(type(c)) && (c.cmc ?? 0) >= 2 },
  { id: 'finisher.big', role: 'finisher', test: (c) => /\bcreature\b/.test(type(c)) && (/\b(trample|flying|menace|haste|double strike|infect)\b/.test(text(c)) || (c.cmc ?? 0) >= 6) },
  { id: 'finisher.win', role: 'finisher', test: (c) => /you win the game|extra turn|each opponent loses \d+ life/.test(text(c)) },
  { id: 'engine.repeatable', role: 'engine', test: (c) => /(^|\n)(at the beginning of|whenever|\{t\}:)/.test(text(c)) && !/\bcreature\b/.test(type(c)) },
  { id: 'protection.protect', role: 'protection', test: (c) => /hexproof|indestructible|protection from|regenerate|phase out/.test(text(c)) },
  { id: 'tutor.search', role: 'tutor', test: (c) => !isLand(c) && /search your library for (a|an|up to \w+) (?!basic land)/.test(text(c)) },
  { id: 'recursion.return', role: 'recursion', test: (c) => /return (target|up to \w+|all|a) [^.]*from your graveyard/.test(text(c)) },
];

export interface TagResult {
  roles: Role[];
  ruleIds: string[];
}

export function tagCard(card: TaggableCard): TagResult {
  const roles = new Set<Role>();
  const ruleIds: string[] = [];
  for (const rule of TAG_RULES) {
    if (rule.test(card)) {
      roles.add(rule.role);
      ruleIds.push(rule.id);
    }
  }
  return { roles: [...roles], ruleIds };
}

/** Which kinds of permanent or spell this card's answer text can address. */
export function answerTypes(card: TaggableCard): AnswerType[] {
  const t = text(card);
  if (!/(destroy|exile|counter|return|deals? \w+ damage|gets -\d+\/-\d+)/.test(t)) return [];
  const out = new Set<AnswerType>();
  if (/target creature|each creature|all creatures|any target|target (nonland )?permanent/.test(t)) out.add('creature');
  if (/target artifact|artifact or|target (nonland )?permanent/.test(t)) out.add('artifact');
  if (/target enchantment|enchantment or|target (nonland )?permanent/.test(t)) out.add('enchantment');
  if (/target planeswalker|any target|target (nonland )?permanent/.test(t)) out.add('planeswalker');
  if (/counter target (spell|noncreature|creature spell)/.test(t)) out.add('spell');
  if (/target (nonland )?permanent|destroy all|exile all/.test(t)) out.add('any');
  return [...out];
}

/** A proposal (from a model or a person) is accepted only if a rule agrees. */
export function acceptProposals(
  card: TaggableCard,
  proposed: Role[],
): { accepted: Role[]; rejected: Role[] } {
  const verified = new Set(tagCard(card).roles);
  return {
    accepted: proposed.filter((r) => verified.has(r)),
    rejected: proposed.filter((r) => !verified.has(r)),
  };
}
