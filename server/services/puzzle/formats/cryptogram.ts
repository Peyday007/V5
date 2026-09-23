/**
 * Cryptogram: a public-domain passage under a substitution cipher.
 *
 * ---------------------------------------------------------------------------
 * The check this format cannot make, stated first
 * ---------------------------------------------------------------------------
 *
 * A cryptogram's solution is unique in practice and not provably: some other
 * assignment of letters might also read as English, and establishing that none
 * does would mean searching 26! mappings against a definition of English
 * nobody has. So **this format does not claim uniqueness**, the way sudoku and
 * maze do, and `limitation` says so where a reader will see it.
 *
 * What it does establish is every property that is actually checkable: the
 * cipher is a bijection, no letter stands for itself, deciphering the printed
 * ciphertext with the printed key yields exactly the printed plaintext, and
 * the passage came from a corpus whose rights this repository holds. Claiming
 * the checkable things and naming the one that is not is a better contract
 * than a `unique: true` nothing tested.
 *
 * ---------------------------------------------------------------------------
 * Why rights are checked here at all
 * ---------------------------------------------------------------------------
 *
 * This is the one format whose content is somebody's writing rather than a
 * pattern. A word search made of ordinary nouns raises no question; a
 * cryptogram of a modern quotation is a reproduction of a literary work on a
 * page somebody is selling. So the passage comes only from
 * `domain/puzzleCorpora.ts`, whose rights are a reviewed constant, and
 * `services/puzzle/compile.ts` refuses a corpus whose position is UNKNOWN.
 */
import {
  bandFor,
  check,
  Rng,
  sha256,
  stringParam,
  verdictFrom,
  type PuzzleArtifact,
  type PuzzleCheck,
  type PuzzleFormat,
  type PuzzleSpec,
  type PuzzleVerdict,
} from './engine.ts';
import { corpus } from '../../../domain/puzzleCorpora.ts';
import type { PuzzleDifficulty } from '../../../domain/types.ts';

export const CRYPTOGRAM_KEY = 'cryptogram';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * A derangement of the alphabet: a permutation with no fixed point.
 *
 * No fixed point matters for a real reason rather than a stylistic one — a
 * letter that stands for itself is a free answer, and enough of them turn a
 * puzzle into a reading exercise. Retrying until the shuffle happens to have
 * none is the simple correct approach and terminates quickly: a random
 * permutation is a derangement about 37% of the time, so the expected number
 * of attempts is under three.
 */
function derangement(rng: Rng): Map<string, string> {
  const source = [...ALPHABET];
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const shuffled = rng.shuffle(source);
    if (shuffled.every((letter, index) => letter !== source[index])) {
      const map = new Map<string, string>();
      source.forEach((letter, index) => map.set(letter, shuffled[index] as string));
      return map;
    }
  }
  throw new Error('No derangement of the alphabet was found, which should be impossible.');
}

function apply(text: string, map: ReadonlyMap<string, string>): string {
  let out = '';
  for (const ch of text) out += map.get(ch) ?? ch;
  return out;
}

function render(spec: PuzzleSpec): PuzzleArtifact {
  const intended = (spec.parameters['difficulty'] as PuzzleDifficulty | undefined) ?? 'MEDIUM';
  const source = corpus(spec.corpusId);
  if (!source) throw new Error(`No corpus named ${spec.corpusId}.`);
  if (source.passages.length === 0) {
    throw new Error(
      `The corpus ${spec.corpusId} holds no passages, so a cryptogram cannot be built from it.`,
    );
  }
  const rng = new Rng(`${spec.seed}:cryptogram`);
  /*
   * The passage is walked rather than sampled where the caller supplied an
   * index, which is what lets a corpus of sixteen produce sixteen distinct
   * cryptograms in sixteen attempts. Sampling gets there too and needs about
   * fifty, every one of the extras refused as a duplicate of something already
   * held — see `specFor`. The fallback is the sample, so a caller with a bare
   * seed and no index still works.
   */
  const raw = spec.parameters['index'];
  const index = typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : null;
  const plain = (
    index === null
      ? (rng.pick(source.passages) as string)
      : (source.passages[index % source.passages.length] as string)
  ).toUpperCase();
  const map = derangement(rng);
  const cipher = apply(plain, map);

  /*
   * One letter given away, on the difficulty bands that ask for it. A starter
   * is the difference between a puzzle somebody finishes and one they put
   * down, and which letter is given is chosen from the ciphertext rather than
   * the plaintext so the hint is about what they can see.
   */
  const starters = intended === 'EASY' ? 2 : intended === 'MEDIUM' ? 1 : 0;
  const cipherLetters = [...new Set([...cipher].filter((ch) => ALPHABET.includes(ch)))];
  const given = rng.shuffle(cipherLetters).slice(0, starters);
  const hints = given.map((cipherLetter) => {
    const plainLetter = [...map.entries()].find(([, to]) => to === cipherLetter)?.[0] ?? '?';
    return `${cipherLetter} = ${plainLetter}`;
  });

  const usedPlain = [...ALPHABET].filter((letter) => plain.includes(letter));
  return {
    formatKey: CRYPTOGRAM_KEY,
    instructions:
      'Each letter has been replaced by another letter, the same one throughout. No letter ' +
      'stands for itself. Work out the original text.' +
      (stringParam(spec, 'note', '') ? ` ${stringParam(spec, 'note', '')}` : ''),
    grid: [cipher],
    prompts: hints.length > 0 ? [`Given: ${hints.join(', ')}`] : [],
    solution: [plain],
    /*
     * The key is the substitution table restricted to the letters that
     * actually occur, because a table listing all twenty-six would tell a
     * reader which letters the passage does not use — which is a clue the
     * puzzle did not intend to give.
     */
    answerKey: [
      plain,
      usedPlain.map((letter) => `${map.get(letter) ?? '?'}→${letter}`).join(' '),
    ],
    intendedDifficulty: intended,
  };
}

function validate(artifact: PuzzleArtifact): PuzzleVerdict {
  const checks: PuzzleCheck[] = [];
  const cipher = artifact.grid[0] ?? '';
  const plain = artifact.solution[0] ?? '';
  const keyLine = artifact.answerKey[1] ?? '';

  checks.push(
    check(
      'there is a ciphertext and a plaintext',
      cipher.length > 0 && plain.length > 0 && cipher.length === plain.length,
      cipher.length === plain.length
        ? `${cipher.length} characters.`
        : `The ciphertext is ${cipher.length} characters and the plaintext is ${plain.length}, ` +
          'so one is not an enciphering of the other.',
    ),
  );
  if (cipher.length === 0 || cipher.length !== plain.length) {
    return verdictFrom(checks, null, sha256(`cryptogram:${plain}`));
  }

  /*
   * The substitution derived from the two texts rather than read from the key.
   *
   * Walking the pair position by position is what catches a cipher that is not
   * a consistent substitution at all — the same plain letter enciphered two
   * ways, or two plain letters collapsed onto one cipher letter, either of
   * which makes the puzzle unsolvable while looking entirely normal.
   */
  const forward = new Map<string, string>();
  const backward = new Map<string, string>();
  let consistent = true;
  let fixedPoints = 0;
  for (let i = 0; i < plain.length; i += 1) {
    const p = plain[i] as string;
    const c = cipher[i] as string;
    if (!ALPHABET.includes(p)) {
      if (p !== c) consistent = false;
      continue;
    }
    if (!ALPHABET.includes(c)) {
      consistent = false;
      continue;
    }
    if (p === c) fixedPoints += 1;
    const already = forward.get(p);
    if (already !== undefined && already !== c) consistent = false;
    const back = backward.get(c);
    if (back !== undefined && back !== p) consistent = false;
    forward.set(p, c);
    backward.set(c, p);
  }

  checks.push(
    check(
      'the cipher is a consistent one-to-one substitution',
      consistent,
      consistent
        ? `${forward.size} letter(s) substituted, each one way throughout, and no two onto one.`
        : 'The same letter is enciphered two ways, or two letters share a cipher letter, so ' +
          'the puzzle cannot be solved as a substitution.',
    ),
  );
  checks.push(
    check(
      'no letter stands for itself',
      fixedPoints === 0,
      fixedPoints === 0
        ? 'Every letter changed.'
        : `${fixedPoints} position(s) where the cipher letter is the plain letter, which the ` +
          'instructions promise cannot happen.',
    ),
  );

  /*
   * The printed key applied to the printed ciphertext. This is the check that
   * would fail if the key were transcribed from a different instance, which is
   * how answer keys go wrong in a book of a hundred puzzles.
   */
  const table = new Map<string, string>();
  let keyReadable = keyLine.length > 0;
  for (const pair of keyLine.split(/\s+/).filter(Boolean)) {
    const match = /^([A-Z])→([A-Z])$/.exec(pair);
    if (!match) {
      keyReadable = false;
      continue;
    }
    table.set(match[1] as string, match[2] as string);
  }
  const decoded = keyReadable
    ? [...cipher].map((ch) => (ALPHABET.includes(ch) ? (table.get(ch) ?? '?') : ch)).join('')
    : '';
  checks.push(
    check(
      'the printed key deciphers the printed text',
      keyReadable && decoded === plain,
      keyReadable
        ? decoded === plain
          ? 'Applying the key to the ciphertext produced the stated solution exactly.'
          : 'Applying the key to the ciphertext does not produce the stated solution.'
        : 'The key could not be read as a substitution table.',
    ),
  );

  /*
   * Difficulty from what the solver is given: a short passage with few
   * distinct letters and a starter is easy; a long one with no starter and a
   * flat letter distribution is not. Read off the artifact, not asserted.
   */
  const distinct = new Set([...plain].filter((ch) => ALPHABET.includes(ch))).size;
  const starters = (artifact.prompts[0] ?? '').match(/[A-Z] = [A-Z]/g)?.length ?? 0;
  const letters = [...plain].filter((ch) => ALPHABET.includes(ch)).length;
  const score = distinct / 26 + (letters < 40 ? 0.2 : 0) - starters * 0.15;
  const measured: PuzzleDifficulty = bandFor(score, [0.45, 0.65, 0.85]);

  return verdictFrom(checks, measured, sha256(`cryptogram:${plain}`));
}

export const CRYPTOGRAM: PuzzleFormat = {
  key: CRYPTOGRAM_KEY,
  title: 'Cryptogram',
  authoring: 'GENERATED',
  requiresHumanEdit: false,
  limitation:
    'Uniqueness is NOT established and is not claimed: proving no other letter assignment ' +
    'reads as English would mean searching 26! mappings against a definition of English ' +
    'nobody has. What is proved is that the cipher is a one-to-one substitution with no ' +
    'letter standing for itself, and that the printed key deciphers the printed text to the ' +
    'printed solution. The passage comes only from a corpus whose rights are a reviewed ' +
    'constant, because this is the one format whose content is somebody’s writing.',
  render,
  validate,
  /*
   * A cryptogram is a passage under a cipher, and two ciphers of one passage
   * are one puzzle to anybody solving it — `canonicalise` hashes the
   * plaintext for exactly that reason. So the catalog is the corpus, and
   * saying so here is what stops the generator being asked for forty every
   * pass and refusing the same sixteen as duplicates for ever.
   */
  catalogCeiling: (corpusId) => corpus(corpusId)?.passages.length ?? 0,
};
