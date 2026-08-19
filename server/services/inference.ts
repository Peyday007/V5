/**
 * Filename inference (section 7).
 *
 * The very first session is a folder of PDFs that were named by hand over
 * months. The platform has to reconstruct project state from those names alone,
 * so every decision taken here appends a plain-language line to `reasons`: the
 * import panel shows its working instead of asking the user to trust a guess.
 *
 * Nothing in here throws. An unreadable name simply produces an unknown,
 * ambiguous result — the file still gets stored, it just waits for a human.
 */
import path from 'node:path';
import {
  DEFAULT_VERSION_POLICY,
  type DocumentType,
  type InferenceResult,
  type Layer,
  type VersionPolicy,
} from '../domain/types.ts';
import { buildCanonicalName } from '../domain/naming.ts';
import { extractVersionToken, normalizeVersion, parseVersion, waveForVersion } from '../domain/version.ts';
import { getLayerBySlug, listLayers } from '../repos/layers.ts';
import { getProject } from '../repos/projects.ts';
import { layerSlugFromPath } from './storage.ts';

/** Below this the platform files nothing automatically and asks the user instead. */
export const AUTO_REGISTER_CONFIDENCE = 0.8;

/** A layer suggestion weaker than this is reported as "closest guess", not as the layer. */
const MIN_LAYER_SCORE = 0.5;

/** Grammar words that never carry layer identity. */
const STOP_WORDS = new Set(['the', 'a', 'an', 'of', 'and', 'or', 'for', 'to', 'in', 'on', 'with']);

/** Filing noise. Only dropped when no layer in the project actually uses the word. */
const NOISE_WORDS = [
  'final', 'draft', 'copy', 'version', 'revised', 'revision', 'updated', 'update',
  'report', 'document', 'doc', 'pdf', 'new', 'old', 'latest', 'clean', 'master', 'v',
];

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
}

/** Crude but symmetric stemming so `Rules` still matches `Rule`. */
function stem(word: string): string {
  if (word.length > 4 && word.endsWith('es')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s')) return word.slice(0, -1);
  return word;
}

function quoteList(items: string[]): string {
  return items.map((item) => `"${item}"`).join(', ');
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

interface CleanedName {
  text: string;
  notes: string[];
}

/**
 * Strip the things humans add to filenames — an extension, a leading date, a
 * trailing "(1)", underscores and hyphens for spaces, doubled spaces — while
 * recording each removal so the UI can explain what was ignored.
 */
function cleanFilename(filename: string): CleanedName {
  const notes: string[] = [];
  let text = path.basename(filename.trim());

  const extension = /\.[A-Za-z][A-Za-z0-9]{0,7}$/.exec(text);
  if (extension?.[0]) text = text.slice(0, -extension[0].length);

  const copyMarker = /\s*[([]\s*(?:copy\s*)?\d{1,3}\s*[)\]]\s*$/i.exec(text);
  if (copyMarker?.[0]) {
    notes.push(`Ignored the duplicate marker "${copyMarker[0].trim()}" at the end of the name.`);
    text = text.slice(0, -copyMarker[0].length);
  }

  const copyWord = /[\s_-]+copy(\s*\d{1,3})?\s*$/i.exec(text);
  if (copyWord?.[0]) {
    notes.push(`Ignored the "copy" suffix at the end of the name.`);
    text = text.slice(0, -copyWord[0].length);
  }

  const leadingDate = /^\s*[([]?\s*(\d{4}[-_. ]?\d{2}[-_. ]?\d{2}|\d{2}[-_.]\d{2}[-_.]\d{4})\s*[)\]]?[-_.\s]*/.exec(text);
  if (leadingDate?.[0] && leadingDate[1]) {
    notes.push(`Ignored the leading date "${leadingDate[1]}".`);
    text = text.slice(leadingDate[0].length);
  }

  const withSeparators = text.replace(/[_]+/g, ' ').replace(/-+/g, ' ');
  if (withSeparators !== text) {
    notes.push('Treated underscores and hyphens in the name as spaces.');
  }
  text = withSeparators.replace(/\s+/g, ' ').trim();

  return { text, notes };
}

/** Remove every `v1`, `v1G`, `v3.1` token so only the layer words are left. */
function stripVersionTokens(text: string): string {
  return text
    .replace(/(^|[\s([])[vV]\d+(?:\.\d+)?[A-Za-z]{0,3}(?=[\s)\]]|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

interface LayerScore {
  score: number;
  explanation: string;
}

/**
 * Score how well the words left over from the filename identify one layer.
 * 1.00 exact, 0.90-0.95 every layer word present, 0.70 a clear prefix or a
 * single differing word, at most 0.30 for a fragmentary overlap.
 */
function scoreLayer(layer: Layer, candidateWords: string[]): LayerScore {
  const layerWords = words(layer.name);
  if (layerWords.length === 0 || candidateWords.length === 0) return { score: 0, explanation: '' };

  if (candidateWords.join(' ') === layerWords.join(' ')) {
    return { score: 1, explanation: `The name matches the layer "${layer.name}" exactly.` };
  }

  const significant = layerWords.filter((word) => !STOP_WORDS.has(word));
  const significantStems = significant.map(stem);
  const candidateStems = candidateWords.map(stem);
  const candidateSet = new Set(candidateStems);
  const missing = significantStems.filter((word) => !candidateSet.has(word));
  const extras = candidateStems.filter((word) => !significantStems.includes(word));

  if (significant.length > 0 && missing.length === 0) {
    return extras.length === 0
      ? { score: 0.95, explanation: `The name uses exactly the words of the layer "${layer.name}".` }
      : { score: 0.9, explanation: `Every word of "${layer.name}" appears in the name.` };
  }

  const candidatePhrase = candidateStems.join(' ');
  const layerPhrase = significantStems.join(' ');
  if (candidatePhrase.length > 0 && layerPhrase.startsWith(`${candidatePhrase} `)) {
    return { score: 0.7, explanation: `The name is the opening of the layer "${layer.name}".` };
  }

  if (missing.length === 1 && significant.length >= 2) {
    return {
      score: 0.7,
      explanation: `The name matches "${layer.name}" apart from the word "${missing[0] ?? ''}".`,
    };
  }

  const matched = significantStems.length - missing.length;
  if (matched > 0) {
    return {
      score: round2(0.3 * (matched / significantStems.length)),
      explanation: `Only ${matched} of ${significantStems.length} words of "${layer.name}" appear in the name.`,
    };
  }
  return { score: 0, explanation: '' };
}

/**
 * The "nothing could be inferred" answer.
 *
 * Exported because a project-wide source legitimately has no layer to infer, and
 * saying so with the same shape as a failed inference keeps one contract rather
 * than two.
 */
export function unknownResult(reason: string): InferenceResult {
  return {
    layerId: null,
    layerName: null,
    version: null,
    documentType: null,
    canonicalName: null,
    wave: null,
    confidence: 0,
    reasons: [reason],
    ambiguous: true,
  };
}

/** Section 7's document-type rules, in the order the spec states them. */
function inferDocumentType(
  haystack: string,
  version: string | null,
  policy: VersionPolicy,
  reasons: string[],
): DocumentType {
  const lower = haystack.toLowerCase();
  if (/\baudit/.test(lower)) {
    reasons.push('The name mentions an audit, so this is an AUDIT document.');
    return 'AUDIT';
  }
  if (/\bpatch/.test(lower)) {
    reasons.push('The name mentions a patch, so this is a PATCH document.');
    return 'PATCH';
  }
  if (version && version === normalizeVersion(policy.synthesisVersion)) {
    reasons.push(`${version} is this project's synthesis version, so this is a SYNTHESIS document.`);
    return 'SYNTHESIS';
  }
  if (version && version === normalizeVersion(policy.foundationVersion)) {
    reasons.push(`${version} is this project's foundation version, so this is a FOUNDATION document.`);
    return 'FOUNDATION';
  }
  if (version && parseVersion(version).branchIndex > 0) {
    reasons.push(`${version} carries a branch suffix, so this is a sibling EXPANSION document.`);
    return 'EXPANSION';
  }
  reasons.push('Nothing in the name identifies a run type, so this is filed as REFERENCE material.');
  return 'REFERENCE';
}

function infer(projectId: string, filename: string, folderSlug: string | null): InferenceResult {
  const project = getProject(projectId);
  if (!project) return unknownResult(`No project with id ${projectId} exists, so nothing could be inferred.`);
  const policy: VersionPolicy = project.versionPolicy ?? DEFAULT_VERSION_POLICY;
  const layers = listLayers(projectId);

  const cleaned = cleanFilename(filename);
  const reasons = [...cleaned.notes];
  reasons.push(`Read the name as "${cleaned.text}".`);

  const token = extractVersionToken(cleaned.text) ?? extractVersionToken(filename);
  const version = token ? normalizeVersion(token) : null;
  if (version) {
    reasons.push(`Found the version "${version}" in the name.`);
  } else {
    reasons.push('No version token such as "v1" or "v1G" appears in the name, so the version is unknown.');
  }

  const layerVocabulary = new Set(layers.flatMap((layer) => words(layer.name)));
  const ignorable = new Set(
    [...words(project.name), ...NOISE_WORDS].filter((word) => !layerVocabulary.has(word)),
  );
  const rawCandidate = words(stripVersionTokens(cleaned.text));
  const candidateWords = rawCandidate.filter((word) => {
    if (ignorable.has(word)) return false;
    if (/^\d+$/.test(word) && !layerVocabulary.has(word)) return false;
    return true;
  });
  const droppedWords = rawCandidate.filter((word) => !candidateWords.includes(word));
  if (droppedWords.length > 0) {
    reasons.push(`Ignored ${quoteList([...new Set(droppedWords)])} — no layer in this project uses those words.`);
  }

  const scored = layers
    .map((layer) => ({ layer, ...scoreLayer(layer, candidateWords) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.layer.orderIndex - b.layer.orderIndex);

  let best = scored[0] ?? null;
  let layerScore = best?.score ?? 0;
  const runnerUp = scored[1];
  if (best && runnerUp && Math.abs(runnerUp.score - best.score) < 0.001) {
    reasons.push(
      `"${best.layer.name}" and "${runnerUp.layer.name}" fit the name equally well, so the layer is not clear from the name alone.`,
    );
    layerScore = round2(layerScore * 0.5);
  }

  if (folderSlug) {
    const folderLayer = getLayerBySlug(projectId, folderSlug);
    if (folderLayer) {
      reasons.push(
        best && best.layer.id === folderLayer.id
          ? `The file already sits in the "${folderLayer.name}" folder, which agrees with its name.`
          : `The file already sits in the "${folderLayer.name}" folder, so that is the layer.`,
      );
      best = { layer: folderLayer, score: 1, explanation: '' };
      layerScore = Math.max(layerScore, 0.95);
    }
  }

  let layer: Layer | null = null;
  if (best && layerScore >= MIN_LAYER_SCORE) {
    layer = best.layer;
    if (best.explanation) reasons.push(best.explanation);
  } else if (best) {
    reasons.push(`The closest layer is "${best.layer.name}", but the match is too weak to act on.`);
  } else {
    reasons.push('No layer in this project matches the name, so the layer is unknown.');
  }

  const documentType = inferDocumentType(cleaned.text, version, policy, reasons);
  const canonicalName = layer && version ? buildCanonicalName(layer.name, version) : null;
  const wave = version ? waveForVersion(version, policy) : null;

  const confidence = layer
    ? round2(Math.min(1, layerScore * 0.75 + (version ? 0.25 : 0)))
    : version
      ? 0.2
      : 0.05;
  const ambiguous = confidence < AUTO_REGISTER_CONFIDENCE || layer === null;

  if (canonicalName) {
    reasons.push(`That makes the canonical name "${canonicalName}".`);
  } else if (layer && !version) {
    reasons.push(`The layer is "${layer.name}" but without a version there is no canonical name yet.`);
  } else {
    reasons.push('There is not enough in the name to build a canonical name.');
  }
  reasons.push(
    ambiguous
      ? `Confidence ${Math.round(confidence * 100)}% — under the ${Math.round(AUTO_REGISTER_CONFIDENCE * 100)}% needed to file it automatically, so please confirm.`
      : `Confidence ${Math.round(confidence * 100)}% — high enough to file and register it automatically.`,
  );

  return {
    layerId: layer?.id ?? null,
    layerName: layer?.name ?? null,
    version,
    documentType,
    canonicalName,
    wave,
    confidence,
    reasons,
    ambiguous,
  };
}

/** Infer layer / version / document type from a filename. Never throws. */
export function inferFromFilename(projectId: string, filename: string): InferenceResult {
  try {
    return infer(projectId, filename, null);
  } catch (error) {
    return unknownResult(
      `Could not read "${filename}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Inference for a file that is already inside the project tree. The folder it
 * was found in is much stronger evidence than its name, which is what lets
 * SCAN & RECONCILE offer a one-click fix for hand-dropped files.
 */
export function inferForProjectFile(
  projectId: string,
  projectSlug: string,
  relativePath: string,
): InferenceResult {
  try {
    return infer(projectId, path.basename(relativePath), layerSlugFromPath(projectSlug, relativePath));
  } catch (error) {
    return unknownResult(
      `Could not read "${relativePath}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
