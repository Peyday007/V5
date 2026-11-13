/**
 * Deterministic reading of one passage: where it splits, what kind of thing
 * it says, and which words carry its subject.
 *
 * No model. These are cue phrases a person actually uses when they state a
 * goal, float an idea, give something up or finish it — the cheap, auditable
 * floor the plan in docs/HISTORICAL-MEMORY.md puts under every judgment. A
 * model reads more, and is spent where a person decides to go further (an
 * approved idea enters Russell's own pipeline); nothing here is a model.
 *
 * Kinds describe what the *person* is doing in a passage, so they are read from
 * the person's own words. An assistant passage gets facets (what it is about)
 * and terms (its subject), never a kind: an answer listing ten business ideas
 * is not ten ambitions.
 */

export const PASSAGE_KINDS = [
  'GOAL',
  'IDEA',
  'BUSINESS',
  'FINANCIAL',
  'CREATIVE',
  'PROJECT',
  'QUESTION',
  'DECISION',
  'COMMITMENT',
  'PLAN',
  'PROGRESS',
  'OBSTACLE',
  'REJECTION',
  'PAUSE',
  'COMPLETION',
  'DIRECTION_CHANGE',
  'PERSONAL',
] as const;
export type PassageKind = (typeof PASSAGE_KINDS)[number];

/** Movie School's facets (§10 of the objective): what a passage is about, in film. */
export const FILM_FACETS = [
  'FILM_OPINION',
  'DIRECTING',
  'SCREENWRITING',
  'CHARACTER_THEME',
  'FILM_CONCEPT',
  'CREATIVE_STANDARD',
  'EXERCISE',
  'PROJECT_REVISION',
] as const;
export type FilmFacet = (typeof FILM_FACETS)[number];

export type Domain = 'FILM' | 'ENGINEERING' | 'BUSINESS' | 'FINANCE' | 'CREATIVE' | 'LEARNING' | 'PERSONAL';

export type ObstacleCategory = 'MONEY' | 'SKILL' | 'TIME' | 'TECHNOLOGY' | 'PEOPLE' | 'CONFIDENCE' | 'OTHER';

// ---------------------------------------------------------------------------
// Segmentation
// ---------------------------------------------------------------------------
const MAX_PASSAGE = 1200;
const MIN_PASSAGE = 60;

/**
 * Paragraph-sized pieces, in order.
 *
 * A fenced code block stays whole (up to the cap); tiny paragraphs are joined
 * to their neighbour so a passage is a thought rather than a line; a long
 * paragraph is cut at sentence ends.
 */
export function segment(text: string): string[] {
  const blocks: string[] = [];
  const fence = /```[\s\S]*?```/g;
  let last = 0;
  for (const match of text.matchAll(fence)) {
    const before = text.slice(last, match.index);
    blocks.push(...before.split(/\n\s*\n/));
    blocks.push(match[0]);
    last = (match.index ?? 0) + match[0].length;
  }
  blocks.push(...text.slice(last).split(/\n\s*\n/));

  const merged: string[] = [];
  for (const raw of blocks) {
    const block = raw.trim();
    if (!block) continue;
    const prior = merged[merged.length - 1];
    if (prior !== undefined && (prior.length < MIN_PASSAGE || block.length < MIN_PASSAGE) && prior.length + block.length < MAX_PASSAGE && !block.startsWith('```') && !prior.startsWith('```')) {
      merged[merged.length - 1] = `${prior}\n\n${block}`;
    } else {
      merged.push(block);
    }
  }

  const out: string[] = [];
  for (const block of merged) {
    if (block.length <= MAX_PASSAGE) {
      out.push(block);
      continue;
    }
    let current = '';
    for (const sentence of block.split(/(?<=[.!?])\s+/)) {
      if (current && current.length + sentence.length + 1 > MAX_PASSAGE) {
        out.push(current);
        current = '';
      }
      if (sentence.length > MAX_PASSAGE) {
        for (let i = 0; i < sentence.length; i += MAX_PASSAGE) out.push(sentence.slice(i, i + MAX_PASSAGE));
        continue;
      }
      current = current ? `${current} ${sentence}` : sentence;
    }
    if (current) out.push(current);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Terms
// ---------------------------------------------------------------------------
const STOP = new Set(
  (
    'the a an and or but if then than so to of in on at by for with from into onto about as is are was were be been being ' +
    'it its this that these those there here what which who whom whose when where why how all any both each few more most other ' +
    'some such no nor not only own same too very can will just don should now i me my mine myself we our ours you your yours ' +
    'he him his she her they them their theirs do does did doing have has had having would could might must shall may also ' +
    'get got gets getting make made makes making like want wants wanted need needs know think thinking thought really ' +
    'yes yeah okay ok sure thanks thank please let lets one two three way ways thing things something anything everything ' +
    'lot lots much many well good great better best new use used using able going go goes went see say said tell told ' +
    'give take put keep still even ever never always maybe probably actually basically something someone somebody anyone ' +
    'time times day days year years month week today tomorrow yesterday right left back up down out over under again ' +
    'help helps helped work works worked working start started try trying tried look looking feel kind sort type part ' +
    'chatgpt gpt assistant answer question questions example examples point points idea ideas also however therefore ' +
    'would like http https www com'
  ).split(/\s+/),
);

export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9'\s-]/g, ' ')
    .split(/[\s-]+/)
    .map((word) => word.replace(/^'+|'+$/g, '').replace(/'s$/, ''))
    .filter((word) => word.length >= 3 && word.length <= 30 && !STOP.has(word) && !/^\d+$/.test(word));
}

/**
 * Candidate subject terms: content words and adjacent content-word pairs.
 *
 * A pair ("short film", "passive income") names a subject more precisely than
 * either word, so both are offered and the archive's own frequencies decide.
 */
export function termsOf(text: string): string[] {
  const words = tokens(text);
  const out = new Set<string>();
  for (let i = 0; i < words.length; i += 1) {
    out.add(words[i]!);
    if (i + 1 < words.length) out.add(`${words[i]} ${words[i + 1]}`);
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// Kinds
// ---------------------------------------------------------------------------
/** "I want to know…" is a question, not an ambition. */
const INFORMATIONAL_WANT = /\bi (?:want|would like|'d like|wanna) to (?:know|understand|ask|see if|check|confirm|clarify|make sure|find out (?:if|whether|what)|double check|verify|get your|hear)\b/i;

const CUES: Record<Exclude<PassageKind, 'CREATIVE' | 'BUSINESS' | 'FINANCIAL' | 'PERSONAL'>, RegExp> = {
  GOAL: /\b(?:my (?:goal|dream|ambition|mission|aim) (?:is|was)|i (?:want|wanna|would like|'d like|hope|plan|intend|aim|aspire|dream) to|i'?m (?:planning|hoping|trying|aiming) to|one day i|someday i|eventually i|long[- ]term,? i|by (?:the end of|next) (?:the )?(?:year|month|summer)|i really want)\b/i,
  IDEA: /\b(?:what if (?:i|we|there|you)|i (?:have|had) (?:an?|this|my|one)(?: [\w-]+){0,2} (?:idea|concept|thought)|my idea|here'?s (?:an|my) idea|idea for (?:a|an|my)|i (?:could|should) (?:build|make|create|start|write|launch|sell|open)|how about (?:i|we)|i was thinking (?:about|of) (?:making|building|starting|creating|writing|doing|launching|opening)|imagine (?:a|an|if))\b/i,
  PROJECT: /\b(?:my (?:project|app|film|movie|short|business|book|channel|website|site|startup|game|script|screenplay|company|brand|store|podcast|album|novel|course|product)|i'?m (?:building|making|writing|developing|creating|filming|shooting|working on|designing|launching))\b/i,
  QUESTION: /\b(?:should i|would it be (?:smart|wise|worth)|is it worth|do you think i should|which (?:one|option) should|what would you do|how (?:do|can|should) i (?:start|get|become|make|build|learn))\b/i,
  DECISION: /\b(?:i(?:'ve| have)? decided|i'?m (?:deciding|torn) (?:between|whether)|trying to decide|can'?t decide|i chose|i'?m choosing|option (?:a|b|1|2)|or should i)\b/i,
  COMMITMENT: /\b(?:i'?m going to|i will (?:definitely|actually|make|build|finish|start|do)|i(?:'ve| have) committed|i'?m (?:committed|serious|dedicated) (?:to|about)|from now on|starting (?:today|tomorrow|now|this week)|no matter what|i promise(?:d)? myself)\b/i,
  PLAN: /\b(?:(?:my|the|a|our) (?:plan|roadmap|schedule|timeline|strategy|game plan)|step (?:one|1)|first,? i(?:'ll| will)|next steps?|milestones?)\b/i,
  PROGRESS: /\b(?:i (?:finished|completed|launched|shipped|built|wrote|filmed|shot|published|released|started|made|sold|earned|recorded|edited)|i(?:'ve| have) (?:finished|completed|launched|built|written|started|made|been working on|filmed|shot|sold|earned)|i just (?:finished|launched|built|wrote|shot|filmed|made))\b/i,
  OBSTACLE: /\b(?:but i (?:can'?t|cannot|can not|don'?t (?:have|know)|do not (?:have|know))|the (?:problem|issue|obstacle|catch) is|i'?m (?:stuck|blocked|struggling)|can'?t afford|cannot afford|no money|not enough (?:money|time|funds|budget|skill)|(?:don'?t|do not) know how to|too (?:expensive|hard|difficult|risky)|i lack|i don'?t have the|holding me back|what'?s stopping me)\b/i,
  REJECTION: /\b(?:i'?m (?:not|no longer) (?:interested|going to|doing|pursuing)|forget (?:it|about (?:it|that|this))|scrap (?:it|that|this)|(?:decided|chose) (?:not to|against)|giving up on|gave up on|i(?:'m| am) done with|not worth it|abandon(?:ed|ing)? (?:it|the|this|that))\b/i,
  PAUSE: /\b(?:on hold|back ?burner|(?:shelve|shelved|shelving) (?:it|this|that)|pause (?:it|this|that)|paused|revisit (?:it|this|that) later|not (?:right )?now,? (?:but|maybe)|maybe later|some other time|come back to (?:it|this|that))\b/i,
  COMPLETION: /\b(?:it'?s (?:done|finished|live|launched|out|published|complete)|i (?:finished|completed|launched|shipped|published|released) (?:it|the|my)|(?:finally|officially) (?:done|finished|launched|released))\b/i,
  DIRECTION_CHANGE: /\b(?:instead,? i|changed my mind|i'?m pivoting|pivot(?:ing)? to|rather than|switch(?:ing|ed)? (?:to|from)|new direction|on second thought|actually,? (?:i|let'?s) (?:want|think|go))\b/i,
};

const DOMAIN_CUES: Record<Domain, RegExp> = {
  FILM: /\b(?:film|films|movie|movies|cinema|cinematic|director|directing|directed|screenplay|screenwriting|script|scene|scenes|shot|shots|cinematography|filmmaking|filmmaker|short film|feature|editing|storyboard|actor|actors|casting|a24|criterion|kubrick|tarantino|nolan|scorsese|spielberg|villeneuve|fincher|lynch|kurosawa|tarkovsky|letterboxd)\b/i,
  ENGINEERING: /\b(?:code|coding|software|app|api|database|server|deploy|github|typescript|javascript|python|react|backend|frontend|program|programming|bug|repo|brain|automation|agent|agents|claude|llm)\b/i,
  BUSINESS: /\b(?:business|startup|company|revenue|customers?|clients?|market|marketing|sell|selling|sales|profit|monetiz\w*|side hustle|pricing|subscription|saas|brand|ecommerce|e-commerce|shopify|etsy|amazon fba|dropshipping|agency|freelanc\w*|niche|lead|leads|outreach)\b/i,
  FINANCE: /\b(?:invest\w*|stocks?|crypto|bitcoin|portfolio|savings|passive income|real estate|dividends?|retire\w*|budget\w*|net worth|interest rate|index fund|roth|401k|trading|options|\$\s?\d[\d,]*)\b/i,
  CREATIVE: /\b(?:story|stories|novel|book|song|songs|album|music|painting|art|artwork|comic|poem|poetry|character|characters|game design|design|photography|youtube|channel|video|videos|podcast|write|writing)\b/i,
  LEARNING: /\b(?:learn|learning|study|studying|course|class|school|college|degree|practice|skill|skills|master|tutorial|lesson|lessons)\b/i,
  PERSONAL: /\b(?:health|fitness|gym|workout|diet|sleep|relationship|girlfriend|boyfriend|family|friends?|move to|moving|apartment|travel|habit|habits|mental|therapy|meditat\w*)\b/i,
};

const FACET_CUES: Record<FilmFacet, RegExp> = {
  FILM_OPINION: /\b(?:i (?:loved|hated|liked|disliked|thought|felt|enjoyed|rewatched|watched)|my favou?rite (?:film|movie|director|scene)|overrated|underrated|masterpiece|the best (?:film|movie|scene)|(?:film|movie) (?:was|is) (?:so|really|great|terrible|amazing|boring))\b/i,
  DIRECTING: /\b(?:direct(?:ing|or|ed|orial)|blocking|shot list|coverage|mise[- ]en[- ]sc[eè]ne|camera (?:movement|angle|placement)|lens|framing|composition|lighting|long take|tracking shot|close[- ]up|wide shot)\b/i,
  SCREENWRITING: /\b(?:screenplay|screenwriting|script|act (?:one|two|three|1|2|3|i|ii|iii)|three[- ]act|structure|beat sheet|logline|dialogue|outline|treatment|inciting incident|midpoint|climax|plot)\b/i,
  CHARACTER_THEME: /\b(?:character(?:s)?|arc|protagonist|antagonist|theme|themes|motif|symbolism|backstory|motivation|subtext)\b/i,
  FILM_CONCEPT: /\b(?:(?:film|movie|short|story|script) ideas?|idea for a (?:film|movie|short|story|script)|(?:a|my) (?:film|movie|short film|story) (?:about|where|in which)|premise|what if a)\b/i,
  CREATIVE_STANDARD: /\b(?:i (?:prefer|like|love|want|hate) (?:films|movies|stories|when (?:a )?(?:film|movie)s?)|my (?:style|aesthetic|taste|voice)|tone|i always want|it has to feel|i can'?t stand)\b/i,
  EXERCISE: /\b(?:exercise|practice|assignment|drill|homework|study (?:plan|guide)|learning (?:plan|objective|goal)|lesson|curriculum|watch list|watchlist)\b/i,
  PROJECT_REVISION: /\b(?:rewrite|rewriting|revision|revise|redraft|new draft|second draft|next draft|changed the (?:ending|beginning|opening|script|story)|cut (?:the|that) scene|new version)\b/i,
};

const OBSTACLE_CUES: Record<Exclude<ObstacleCategory, 'OTHER'>, RegExp> = {
  MONEY: /\b(?:money|afford|expensive|budget|funds|funding|capital|cost|costs|broke|cash|pay for|loan)\b/i,
  SKILL: /\b(?:(?:don'?t|do not) know how|skill|skills|experience|learn how|not good at|no idea how|expertise|technical)\b/i,
  TIME: /\b(?:time|busy|schedule|hours|deadline|school|job takes)\b/i,
  TECHNOLOGY: /\b(?:tool|tools|software|equipment|camera|computer|technology|tech|api|platform|doesn'?t exist|not possible yet|code|coding|build it)\b/i,
  PEOPLE: /\b(?:team|partner|co-?founder|crew|actors|nobody|no one|alone|help from|hire)\b/i,
  CONFIDENCE: /\b(?:scared|afraid|fear|nervous|confidence|doubt|imposter|anxious|not sure i can)\b/i,
};

export interface PassageReading {
  kinds: PassageKind[];
  facets: FilmFacet[];
  domains: Domain[];
  obstacles: ObstacleCategory[];
  /** 0..1: how plainly this passage states an intention of the person's own. */
  cueStrength: number;
}

export function domainsOf(text: string): Domain[] {
  return (Object.keys(DOMAIN_CUES) as Domain[]).filter((domain) => DOMAIN_CUES[domain].test(text));
}

export function obstaclesOf(text: string): ObstacleCategory[] {
  const found = (Object.keys(OBSTACLE_CUES) as Exclude<ObstacleCategory, 'OTHER'>[]).filter((c) => OBSTACLE_CUES[c].test(text));
  return found.length > 0 ? found : ['OTHER'];
}

export function readPassage(text: string, role: string): PassageReading {
  const domains = domainsOf(text);
  const facets = domains.includes('FILM') ? FILM_FACETS.filter((facet) => FACET_CUES[facet].test(text)) : [];
  if (role !== 'USER') {
    return { kinds: [], facets, domains, obstacles: [], cueStrength: 0 };
  }
  const kinds = new Set<PassageKind>();
  for (const [kind, cue] of Object.entries(CUES) as [keyof typeof CUES, RegExp][]) {
    if (cue.test(text)) kinds.add(kind);
  }
  if (kinds.has('GOAL') && INFORMATIONAL_WANT.test(text) && !/\b(?:my goal|dream|ambition)\b/i.test(text)) {
    // "I want to know what this means" — a question asked in the grammar of a want.
    const stripped = text.replace(INFORMATIONAL_WANT, ' ');
    if (!CUES.GOAL.test(stripped)) kinds.delete('GOAL');
  }
  const intentional = ['GOAL', 'IDEA', 'PROJECT', 'COMMITMENT', 'PLAN', 'PROGRESS', 'DECISION'].some((k) => kinds.has(k as PassageKind));
  if (intentional) {
    if (domains.includes('BUSINESS')) kinds.add('BUSINESS');
    if (domains.includes('FINANCE')) kinds.add('FINANCIAL');
    if (domains.includes('FILM') || domains.includes('CREATIVE')) kinds.add('CREATIVE');
    if (domains.includes('PERSONAL')) kinds.add('PERSONAL');
  }
  const obstacles = kinds.has('OBSTACLE') ? obstaclesOf(text) : [];
  let cueStrength = 0;
  if (kinds.has('COMMITMENT')) cueStrength += 0.35;
  if (kinds.has('GOAL')) cueStrength += 0.3;
  if (kinds.has('PROJECT')) cueStrength += 0.25;
  if (kinds.has('IDEA')) cueStrength += 0.2;
  if (kinds.has('PLAN')) cueStrength += 0.15;
  if (kinds.has('PROGRESS')) cueStrength += 0.2;
  if (kinds.has('DECISION')) cueStrength += 0.1;
  if (/\b(?:my dream|always wanted|for years|my whole life|really want|seriously)\b/i.test(text)) cueStrength += 0.2;
  return { kinds: [...kinds], facets, domains, obstacles, cueStrength: Math.min(1, cueStrength) };
}

/** The kinds that make a passage a candidate idea of the person's own. */
export const IDEA_SEEDING_KINDS: readonly PassageKind[] = ['GOAL', 'IDEA', 'PROJECT', 'COMMITMENT', 'PLAN', 'DECISION', 'QUESTION'];

/**
 * The one sentence in a passage that carries its cue — the idea's own words.
 */
export function cueSentence(text: string): string {
  const sentences = text.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/);
  const all = Object.values(CUES);
  const hit = sentences.find((s) => all.some((cue) => cue.test(s) && !INFORMATIONAL_WANT.test(s)));
  return (hit ?? sentences[0] ?? text).trim();
}

/** Space-padded, so `LIKE '% GOAL %'` matches a whole word on both backends. */
export function padded(words: readonly string[]): string {
  return words.length === 0 ? ' ' : ` ${words.join(' ')} `;
}
