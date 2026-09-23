/**
 * The source material Brain generates puzzles from, and the rights it holds in
 * each piece of it.
 *
 * ---------------------------------------------------------------------------
 * Rights are a constant, because research must never be able to establish them
 * ---------------------------------------------------------------------------
 *
 * Every other fact in this kernel arrives through the evidence gate. This one
 * cannot, and the reason is worth stating plainly: a claim that a word list is
 * free to use commercially is a legal position about a specific artifact in
 * this repository, and no amount of reading published sources establishes what
 * *this* repository is allowed to sell. A model that could write a rights row
 * would eventually write a confident one, and the first anybody would hear of
 * it is a takedown.
 *
 * So a corpus is a **shipped constant** whose rights are declared in code,
 * beside the bytes, and reviewed when they change. `services/puzzle/compile.ts`
 * refuses to compile anything from a corpus whose rights are `UNKNOWN` — the
 * unknown is never the favourable assumption (invariant 39), at the one field
 * where being wrong is somebody else's property.
 *
 * ---------------------------------------------------------------------------
 * There is no route by which a person's corpus arrives, and that is v1
 * ---------------------------------------------------------------------------
 *
 * Importing a licensed clue bank or a bought lexicon is a real and obvious
 * next capability, and it is deliberately absent rather than half-built: it
 * needs a rights record somebody signs, a provenance chain per entry, and an
 * answering transition when a licence lapses. A table with nothing that could
 * honestly fill it is the *mechanism nothing calls* this repository keeps
 * correcting. `services/puzzle/capabilities.ts` reports it as MISSING and
 * names what it would take, which is what makes its absence visible instead of
 * quiet.
 */

/**
 * What this repository may do with a corpus.
 *
 * `UNKNOWN` exists and is never a default that lets anything through: it is
 * what a corpus reads while somebody is still establishing its position, and
 * a corpus in that state compiles nothing at all. `NON_COMMERCIAL` is a
 * settled answer with the same practical consequence and a different meaning —
 * *we checked and may not sell this* — and the two must not read the same,
 * for §30's reason at a new column.
 */
export const CORPUS_RIGHTS = [
  'PUBLIC_DOMAIN',
  'OWNED',
  'LICENSED_COMMERCIAL',
  'NON_COMMERCIAL',
  'UNKNOWN',
] as const;
export type CorpusRights = (typeof CORPUS_RIGHTS)[number];

/** The three that may reach a product a person could sell. */
const SELLABLE: Readonly<Record<CorpusRights, boolean>> = Object.freeze({
  PUBLIC_DOMAIN: true,
  OWNED: true,
  LICENSED_COMMERCIAL: true,
  NON_COMMERCIAL: false,
  UNKNOWN: false,
});

export function mayCompileCommercially(rights: CorpusRights): boolean {
  return SELLABLE[rights];
}

export interface Corpus {
  id: string;
  title: string;
  /** What this is, in the words somebody deciding whether to trust it needs. */
  description: string;
  rights: CorpusRights;
  /** Why the rights read the way they do. Never derived, never inferred. */
  rightsBasis: string;
  language: string;
  /** Words, upper case, letters only — the shape every generator expects. */
  words: readonly string[];
  /** Short texts for the formats that need a passage rather than a word. */
  passages: readonly string[];
}

/*
 * Assembled for this repository rather than copied from anywhere.
 *
 * Individual English words carry no rights; a particular curated *selection*
 * of them can, which is why this list was written here rather than taken from
 * a published word list, and why the rights read OWNED rather than
 * PUBLIC_DOMAIN. The distinction matters: PUBLIC_DOMAIN would be a claim about
 * somebody else's artifact, and OWNED is a statement about this one.
 */
const COMMON_WORDS: readonly string[] = Object.freeze([
  'ANCHOR', 'ARBOUR', 'AUTUMN', 'BAKERY', 'BALLAD', 'BANNER', 'BARLEY', 'BASKET',
  'BEACON', 'BELFRY', 'BIRDIE', 'BISHOP', 'BLAZER', 'BONNET', 'BOTTLE', 'BOULDER',
  'BRIDGE', 'BUCKET', 'BUNDLE', 'BUTTON', 'CABBAGE', 'CACTUS', 'CAMERA', 'CANDLE',
  'CANYON', 'CARAVAN', 'CARPET', 'CASTLE', 'CAVERN', 'CELLAR', 'CHALET', 'CHEESE',
  'CHERRY', 'CHISEL', 'CIRCUS', 'CLOVER', 'COBALT', 'COMPASS', 'COPPER', 'CORNER',
  'COTTAGE', 'CRATER', 'CRAYON', 'CRUMPET', 'CURTAIN', 'CUSHION', 'CYMBAL', 'DAGGER',
  'DAHLIA', 'DAMSON', 'DAPPLE', 'DESERT', 'DIAMOND', 'DOLPHIN', 'DONKEY', 'DRAGON',
  'DRAWER', 'ECLIPSE', 'EMBER', 'ENGINE', 'FALCON', 'FATHOM', 'FENNEL', 'FERRET',
  'FIDDLE', 'FLAGON', 'FLOWER', 'FOREST', 'FOSSIL', 'FURROW', 'GALLEY', 'GARDEN',
  'GARNET', 'GEYSER', 'GINGER', 'GLACIER', 'GOBLET', 'GRANITE', 'GRAVEL', 'GROTTO',
  'HAMLET', 'HAMMER', 'HARBOUR', 'HARVEST', 'HAZEL', 'HEATHER', 'HELMET', 'HERALD',
  'HOLLOW', 'HORNET', 'ICICLE', 'INDIGO', 'ISLAND', 'JASMINE', 'JERSEY', 'JUNGLE',
  'JUNIPER', 'KETTLE', 'KITTEN', 'LADDER', 'LAGOON', 'LANTERN', 'LATTICE', 'LAUREL',
  'LEDGER', 'LEMON', 'LIZARD', 'LOBSTER', 'LUPINE', 'MAGNET', 'MALLET', 'MANGO',
  'MANTLE', 'MARBLE', 'MARIGOLD', 'MEADOW', 'MELODY', 'MERCURY', 'MIRROR', 'MITTEN',
  'MONSOON', 'MORTAR', 'MUSKET', 'NECTAR', 'NEEDLE', 'NETTLE', 'NUTMEG', 'OBSIDIAN',
  'ORCHARD', 'ORCHID', 'OTTER', 'OYSTER', 'PADDLE', 'PALACE', 'PANTRY', 'PARSLEY',
  'PASTEL', 'PEBBLE', 'PELICAN', 'PEPPER', 'PEWTER', 'PIGEON', 'PILLAR', 'PISTON',
  'PLATEAU', 'PLOVER', 'POCKET', 'POPLAR', 'PRAIRIE', 'PUDDLE', 'PUMPKIN', 'QUARRY',
  'QUIVER', 'RABBIT', 'RADISH', 'RAFTER', 'RAVINE', 'RIBBON', 'RIPPLE', 'RIVER',
  'ROBIN', 'ROSTER', 'RUDDER', 'SADDLE', 'SAFFRON', 'SALMON', 'SANDAL', 'SAPLING',
  'SATCHEL', 'SCARLET', 'SEAGULL', 'SHOVEL', 'SILVER', 'SLATE', 'SPARROW', 'SPIRAL',
  'SPRUCE', 'STABLE', 'STATUE', 'STREAM', 'SUMMIT', 'SUNSET', 'TABLET', 'TALON',
  'TANGLE', 'TEAPOT', 'TEMPLE', 'THIMBLE', 'THISTLE', 'THUNDER', 'TIMBER', 'TOFFEE',
  'TRELLIS', 'TROUT', 'TULIP', 'TUNNEL', 'TURRET', 'VALLEY', 'VELVET', 'VESSEL',
  'VIOLET', 'WAGON', 'WALNUT', 'WEAVER', 'WHISTLE', 'WILLOW', 'WINDOW', 'WINTER',
  'WONDER', 'YARROW', 'YONDER', 'ZEPHYR', 'ZINNIA',
]);

/*
 * Traditional English proverbs.
 *
 * Chosen because they have no identifiable author and have been in circulation
 * for centuries, which is what makes PUBLIC_DOMAIN a statement somebody can
 * check rather than an assumption. A modern quotation would be a rights
 * question, and this kernel's whole position is that it does not answer those
 * by guessing.
 */
const PROVERBS: readonly string[] = Object.freeze([
  'A STITCH IN TIME SAVES NINE',
  'STILL WATERS RUN DEEP',
  'MANY HANDS MAKE LIGHT WORK',
  'A ROLLING STONE GATHERS NO MOSS',
  'THE EARLY BIRD CATCHES THE WORM',
  'EVERY CLOUD HAS A SILVER LINING',
  'ACTIONS SPEAK LOUDER THAN WORDS',
  'FORTUNE FAVOURS THE BOLD',
  'A WATCHED POT NEVER BOILS',
  'MAKE HAY WHILE THE SUN SHINES',
  'BETTER LATE THAN NEVER',
  'LOOK BEFORE YOU LEAP',
  'GREAT OAKS FROM LITTLE ACORNS GROW',
  'NECESSITY IS THE MOTHER OF INVENTION',
  'THE PROOF OF THE PUDDING IS IN THE EATING',
  'DO NOT COUNT YOUR CHICKENS BEFORE THEY HATCH',
]);

export const CORPORA: Readonly<Record<string, Corpus>> = Object.freeze({
  'common-english-v1': Object.freeze({
    id: 'common-english-v1',
    title: 'Common English nouns, v1',
    description:
      'Ordinary English nouns of six to nine letters, written for this repository. Used by ' +
      'the word search and anagram generators as the set words are drawn from.',
    rights: 'OWNED' as CorpusRights,
    rightsBasis:
      'Assembled here rather than copied from any published list. Individual English words ' +
      'carry no rights and a curated selection of them can, so the position stated is about ' +
      'this artifact rather than about somebody else’s.',
    language: 'en',
    words: COMMON_WORDS,
    passages: Object.freeze([] as string[]),
  }),
  'traditional-proverbs-v1': Object.freeze({
    id: 'traditional-proverbs-v1',
    title: 'Traditional English proverbs, v1',
    description:
      'Short proverbial sentences with no identifiable author, long in general circulation. ' +
      'Used by the cryptogram generator as the plaintext it enciphers.',
    rights: 'PUBLIC_DOMAIN' as CorpusRights,
    rightsBasis:
      'Anonymous traditional sayings in circulation for centuries, with no identifiable ' +
      'author and no subsisting term. Deliberately not modern quotations, which would be a ' +
      'rights question this kernel refuses to answer by assumption.',
    language: 'en',
    words: Object.freeze([] as string[]),
    passages: PROVERBS,
  }),
  /*
   * Deliberately empty, and deliberately present.
   *
   * A crossword needs a clue bank, and this repository holds none it may sell
   * from. Leaving the corpus out entirely would make the gap invisible: the
   * crossword format would simply have no generator and read as unbuilt, when
   * what is actually true is that the machinery exists and the *rights* do
   * not. It reads UNKNOWN, so nothing compiles from it, and
   * `services/puzzle/capabilities.ts` names it as the thing that would unlock
   * the format.
   */
  'crossword-clue-bank': Object.freeze({
    id: 'crossword-clue-bank',
    title: 'Crossword clue bank',
    description:
      'The answer-and-clue pairs a crossword is built from. This repository holds none: a ' +
      'clue bank is either licensed, bought, or written by an editor, and each of those is a ' +
      'person’s decision with a rights record behind it.',
    rights: 'UNKNOWN' as CorpusRights,
    rightsBasis:
      'Nothing has been established. Not a judgement that a clue bank may not be used — a ' +
      'statement that nobody has supplied one whose position is known, which is a different ' +
      'fact with a different remedy.',
    language: 'en',
    words: Object.freeze([] as string[]),
    passages: Object.freeze([] as string[]),
  }),
});

export function corpus(id: string): Corpus | null {
  return Object.prototype.hasOwnProperty.call(CORPORA, id) ? (CORPORA[id] ?? null) : null;
}

export function corpusIds(): string[] {
  return Object.keys(CORPORA);
}

/**
 * Strings that must never appear in a generated grid, in any direction.
 *
 * A screen rather than a lexicon, and short on purpose. The failure a word
 * search actually has is an accidental offensive string formed by filler
 * letters crossing a placed word — a real defect that reaches a printed page
 * and that no amount of checking the *word list* catches, because the word was
 * never placed. What is here is the small set of unambiguous cases; it is not
 * a claim to screen everything, and `services/puzzle/validate.ts` reports what
 * it checked rather than pronouncing a grid clean.
 */
export const PROHIBITED_STRINGS: readonly string[] = Object.freeze([
  'ARSE', 'BASTARD', 'BITCH', 'BOLLOCK', 'CUNT', 'DAMN', 'DICK', 'FUCK',
  'NIGGER', 'PISS', 'PRICK', 'SHIT', 'SLUT', 'TWAT', 'WANK', 'WHORE',
]);
