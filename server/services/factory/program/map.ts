/**
 * The requirement map, checked against the source it claims to describe.
 *
 * A map is a proposal — an architect's reading of the specification — and it is
 * never trusted on its say-so. Every requirement must cite source items that
 * exist; every normative item must be cited by some requirement; two
 * requirements claiming the same clause must either agree (and one is a
 * duplicate) or disagree (and the disagreement is a conflict a person sees);
 * every ambiguity the source contains must be carried as an ambiguity rather
 * than resolved silently; and a revision of an approved map may add, never
 * drop, and never redefine what a person approved.
 */
import type {
  ProgramIssue,
  ProgramIssueCode,
  ProgramRequirement,
  ProgramValidation,
  RequirementCheck,
  RequirementMap,
  RequirementPriority,
  SourceItem,
} from '../../../domain/factoryProgram.ts';
import { REQUIREMENT_PRIORITIES } from '../../../domain/factoryProgram.ts';

export class ProgramMapError extends Error {}

const KEY = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;

function strings(value: unknown, what: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new ProgramMapError(`${what} must be a list of strings.`);
  }
  return (value as string[]).map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

function text(value: unknown, what: string, fallback = ''): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') throw new ProgramMapError(`${what} must be text.`);
  return value.trim();
}

function parseCheck(raw: unknown, where: string): RequirementCheck {
  if (typeof raw !== 'object' || raw === null) throw new ProgramMapError(`${where} is not an object.`);
  const check = raw as Record<string, unknown>;
  const statement = check.statement === undefined ? {} : { statement: text(check.statement, `${where}.statement`) };
  if (check.kind === 'HTTP') {
    const path = text(check.path, `${where}.path`);
    const expectStatus = Number(check.expectStatus ?? 200);
    return {
      kind: 'HTTP',
      path,
      expectStatus,
      ...(check.expectText === undefined ? {} : { expectText: text(check.expectText, `${where}.expectText`) }),
      ...statement,
    };
  }
  if (check.kind === 'BUNDLE_TEXT') return { kind: 'BUNDLE_TEXT', text: text(check.text, `${where}.text`), ...statement };
  if (check.kind === 'PROBE') {
    const args = check.args;
    if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) {
      throw new ProgramMapError(`${where}.args must be an object.`);
    }
    return {
      kind: 'PROBE',
      probe: text(check.probe, `${where}.probe`),
      ...(args === undefined ? {} : { args: args as Record<string, string | number | boolean> }),
      ...statement,
    };
  }
  throw new ProgramMapError(`${where}.kind must be HTTP, BUNDLE_TEXT or PROBE.`);
}

/** Parse a map from JSON-shaped data. Shape errors throw; meaning is judged by `validateRequirementMap`. */
export function parseRequirementMap(input: unknown): RequirementMap {
  if (typeof input !== 'object' || input === null) throw new ProgramMapError('The map is not an object.');
  const record = input as Record<string, unknown>;
  if (!Array.isArray(record.requirements)) throw new ProgramMapError('The map has no `requirements` list.');
  const requirements = record.requirements.map((raw, index): ProgramRequirement => {
    const where = `requirements[${index}]`;
    if (typeof raw !== 'object' || raw === null) throw new ProgramMapError(`${where} is not an object.`);
    const r = raw as Record<string, unknown>;
    const kind = r.kind === undefined ? 'CAPABILITY' : r.kind;
    if (kind !== 'CAPABILITY' && kind !== 'INTERACTION') throw new ProgramMapError(`${where}.kind must be CAPABILITY or INTERACTION.`);
    const existingRaw = r.existing;
    let existing: ProgramRequirement['existing'] = null;
    if (existingRaw !== undefined && existingRaw !== null) {
      if (typeof existingRaw !== 'object') throw new ProgramMapError(`${where}.existing must be an object.`);
      const e = existingRaw as Record<string, unknown>;
      existing = { paths: strings(e.paths, `${where}.existing.paths`), evidence: text(e.evidence, `${where}.existing.evidence`) };
    }
    const ambiguities = Array.isArray(r.ambiguities)
      ? r.ambiguities.map((a, j) => {
          if (typeof a !== 'object' || a === null) throw new ProgramMapError(`${where}.ambiguities[${j}] is not an object.`);
          const amb = a as Record<string, unknown>;
          const interpretation = amb.interpretation === null || amb.interpretation === undefined
            ? null
            : text(amb.interpretation, `${where}.ambiguities[${j}].interpretation`);
          return {
            item: text(amb.item, `${where}.ambiguities[${j}].item`),
            question: text(amb.question, `${where}.ambiguities[${j}].question`),
            interpretation: interpretation === '' ? null : interpretation,
            resolvedBy: amb.resolvedBy === undefined || amb.resolvedBy === null ? null : text(amb.resolvedBy, 'resolvedBy'),
          };
        })
      : [];
    return {
      key: text(r.key, `${where}.key`),
      kind,
      title: text(r.title, `${where}.title`),
      subsystem: text(r.subsystem, `${where}.subsystem`, 'general') || 'general',
      source: strings(r.source, `${where}.source`),
      quote: r.quote === undefined || r.quote === null ? null : text(r.quote, `${where}.quote`) || null,
      behavior: text(r.behavior, `${where}.behavior`),
      inputs: strings(r.inputs, `${where}.inputs`),
      outputs: strings(r.outputs, `${where}.outputs`),
      constraints: strings(r.constraints, `${where}.constraints`),
      dependsOn: strings(r.dependsOn, `${where}.dependsOn`),
      interactsWith: strings(r.interactsWith, `${where}.interactsWith`),
      existing,
      missingWork: text(r.missingWork, `${where}.missingWork`),
      paths: strings(r.paths, `${where}.paths`),
      verification: Array.isArray(r.verification)
        ? r.verification.map((c, j) => parseCheck(c, `${where}.verification[${j}]`))
        : [],
      ambiguities,
      ...(r.priority === undefined || r.priority === null ? {} : { priority: text(r.priority, `${where}.priority`) as RequirementPriority }),
      ...(r.prepared === true ? { prepared: true } : {}),
    };
  });
  const context = Array.isArray(record.context)
    ? record.context.map((raw, index) => {
        if (typeof raw !== 'object' || raw === null) throw new ProgramMapError(`context[${index}] is not an object.`);
        const c = raw as Record<string, unknown>;
        return { item: text(c.item, `context[${index}].item`), reason: text(c.reason, `context[${index}].reason`) };
      })
    : [];
  return { requirements, context };
}

/**
 * A starting map: one requirement per normative item, its behavior the item's
 * own words, and no verification — so it validates as UNVERIFIABLE until an
 * architect says how each would be checked on production. It exists so the
 * architect starts from a map that already omits nothing.
 */
export function skeletonMap(items: SourceItem[]): RequirementMap {
  const requirements: ProgramRequirement[] = [];
  const context: RequirementMap['context'] = [];
  for (const item of items) {
    if (!item.normative) {
      context.push({ item: item.id, reason: 'States nothing that must be true (no obligation word, no normative lead-in).' });
      continue;
    }
    requirements.push({
      key: `REQ-${item.id.slice(2)}`,
      kind: 'CAPABILITY',
      title: item.text.replace(/\s+/g, ' ').slice(0, 90),
      subsystem: item.section[0] ?? 'general',
      source: [item.id],
      quote: null,
      behavior: item.text.replace(/\s+/g, ' '),
      inputs: [],
      outputs: [],
      constraints: [],
      dependsOn: [],
      interactsWith: [],
      existing: null,
      missingWork: '',
      paths: [],
      verification: [],
      ambiguities: item.ambiguityMarkers.map((marker) => ({
        item: item.id,
        question: `The source says "${marker}" — which reading is meant?`,
        interpretation: null,
      })),
    });
  }
  return { requirements, context };
}

const normalize = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function issue(list: ProgramIssue[], code: ProgramIssueCode, subject: string, detail: string): void {
  list.push({ code, subject, detail });
}

function checkProblems(check: RequirementCheck): string | null {
  if (check.kind === 'HTTP') {
    if (!check.path.startsWith('/') || check.path.startsWith('//') || check.path.includes('..')) return 'an HTTP check needs a path on this Brain beginning with one "/"';
    if (!Number.isInteger(check.expectStatus) || check.expectStatus < 100 || check.expectStatus > 599) return 'an HTTP check needs a real status';
    return null;
  }
  if (check.kind === 'BUNDLE_TEXT') return check.text.length >= 3 ? null : 'a bundle check needs at least three characters of text';
  return /^[a-z][a-z0-9._-]{2,80}$/.test(check.probe) ? null : 'a probe is named in lower case, e.g. "factory.program.ledger"';
}

/** Find a cycle in a key → dependencies graph, or null. */
export function findCycle(graph: Map<string, string[]>): string[] | null {
  const state = new Map<string, 'VISITING' | 'DONE'>();
  const path: string[] = [];
  const visit = (node: string): string[] | null => {
    const seen = state.get(node);
    if (seen === 'DONE') return null;
    if (seen === 'VISITING') return [...path.slice(path.indexOf(node)), node];
    state.set(node, 'VISITING');
    path.push(node);
    for (const next of graph.get(node) ?? []) {
      if (!graph.has(next)) continue;
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    path.pop();
    state.set(node, 'DONE');
    return null;
  };
  for (const node of graph.keys()) {
    const cycle = visit(node);
    if (cycle) return cycle;
  }
  return null;
}

/** Every edge a requirement has to another: its dependencies and, for an interaction, its participants. */
export function edgesOf(requirement: ProgramRequirement, extra: Map<string, string[]> = new Map()): string[] {
  return [...new Set([...requirement.dependsOn, ...requirement.interactsWith, ...(extra.get(requirement.key) ?? [])])];
}

/**
 * Judge a map against its source.
 *
 * `previous`, when given, is the map a person already approved: a revision may
 * add requirements and edges, but every approved requirement must still be
 * there, with the same behavior and the same verification, and every approved
 * relationship must survive. That is "Factory may decide how, never what".
 */
export function validateRequirementMap(
  items: SourceItem[],
  map: RequirementMap,
  options: { previous?: RequirementMap | null; extraEdges?: Map<string, string[]> } = {},
): ProgramValidation {
  const errors: ProgramIssue[] = [];
  const warnings: ProgramIssue[] = [];
  const byId = new Map(items.map((item) => [item.id, item]));
  const keys = new Map<string, ProgramRequirement>();

  for (const requirement of map.requirements) {
    if (!KEY.test(requirement.key)) {
      issue(errors, 'DUPLICATE_KEY', requirement.key || '(blank)', 'A requirement key is a stable identifier: letters, digits, dot, dash or underscore, starting with a letter.');
      continue;
    }
    if (keys.has(requirement.key)) issue(errors, 'DUPLICATE_KEY', requirement.key, `Two requirements share the key ${requirement.key}.`);
    keys.set(requirement.key, requirement);
  }

  const citedBy = new Map<string, ProgramRequirement[]>();
  for (const requirement of map.requirements) {
    const subject = requirement.key;
    if (requirement.source.length === 0) {
      issue(errors, 'SOURCE_ITEM_UNKNOWN', subject, 'A requirement cites no source item, so nothing says the owner asked for it.');
    }
    for (const id of requirement.source) {
      const item = byId.get(id);
      if (!item) {
        issue(errors, 'SOURCE_ITEM_UNKNOWN', subject, `Cites ${id}, which the source does not contain.`);
        continue;
      }
      citedBy.set(id, [...(citedBy.get(id) ?? []), requirement]);
    }
    if (requirement.quote !== null) {
      const texts = requirement.source.map((id) => byId.get(id)?.text ?? '');
      if (!texts.some((t) => t.includes(requirement.quote!))) {
        issue(errors, 'QUOTE_NOT_IN_SOURCE', subject, `Its quote is not verbatim in ${requirement.source.join(', ')}.`);
      }
    }
    if (requirement.priority !== undefined && !(REQUIREMENT_PRIORITIES as readonly string[]).includes(requirement.priority)) {
      issue(errors, 'INVALID_PRIORITY', subject, `Priority ${String(requirement.priority)} is not one of ${REQUIREMENT_PRIORITIES.join(', ')}.`);
    }
    if (requirement.behavior.length < 8) issue(errors, 'NO_BEHAVIOR', subject, 'It does not say what observable behavior is required.');
    if (requirement.verification.length === 0) {
      issue(errors, 'UNVERIFIABLE', subject, 'It has no verification condition, so nothing could show it was done.');
    }
    requirement.verification.forEach((check, index) => {
      const problem = checkProblems(check);
      if (problem) issue(errors, 'INVALID_CHECK', subject, `verification[${index}]: ${problem}.`);
    });
    if (requirement.existing) {
      if (requirement.existing.paths.length === 0 || requirement.existing.evidence.length < 8) {
        issue(errors, 'EXISTING_WITHOUT_EVIDENCE', subject, 'Claims an existing implementation without naming the files and the evidence; a name or a title is not evidence.');
      }
    } else if (requirement.missingWork.length < 8 || requirement.paths.length === 0) {
      issue(errors, 'NO_WORK_DECLARED', subject, 'Nothing implements it yet, and it names no missing work and no files that work would change.');
    }
    if (requirement.existing && requirement.missingWork.length >= 8 && requirement.paths.length === 0) {
      issue(errors, 'NO_WORK_DECLARED', subject, 'It names missing work beyond the existing implementation but no files that work would change.');
    }
    for (const dependency of [...requirement.dependsOn, ...requirement.interactsWith]) {
      if (!keys.has(dependency)) issue(errors, 'UNKNOWN_DEPENDENCY', subject, `Depends on ${dependency}, which the map does not define.`);
      if (dependency === requirement.key) issue(errors, 'DEPENDENCY_CYCLE', subject, 'It depends on itself.');
    }
    if (requirement.kind === 'INTERACTION' && requirement.interactsWith.length < 2) {
      issue(errors, 'INTERACTION_NEEDS_PARTICIPANTS', subject, 'An interaction names at least two requirements whose implementations must work together.');
    }
    // An ambiguity in a cited item has to be carried, not resolved by omission.
    for (const id of requirement.source) {
      const item = byId.get(id);
      if (!item || item.ambiguityMarkers.length === 0) continue;
      const carriedHere = requirement.ambiguities.some((a) => a.item === id);
      if (!carriedHere) {
        issue(errors, 'AMBIGUITY_HIDDEN', subject, `${id} says ${item.ambiguityMarkers.map((m) => `"${m}"`).join(', ')}; the requirement must carry that ambiguity (with a proposed reading or none) instead of silently choosing one.`);
      }
    }
    for (const ambiguity of requirement.ambiguities) {
      if (!byId.has(ambiguity.item)) issue(errors, 'SOURCE_ITEM_UNKNOWN', subject, `Its ambiguity cites ${ambiguity.item}, which the source does not contain.`);
      if (ambiguity.interpretation === null) {
        warnings.push({ code: 'AMBIGUITY_HIDDEN', subject, detail: `Open question on ${ambiguity.item}: ${ambiguity.question} (blocks this requirement until a person answers).` });
      }
    }
  }

  const graph = new Map(map.requirements.map((r) => [r.key, edgesOf(r, options.extraEdges)]));
  const cycle = findCycle(graph);
  if (cycle) issue(errors, 'DEPENDENCY_CYCLE', cycle[0]!, `Requirements depend on each other in a circle: ${cycle.join(' → ')}.`);

  // Omissions: a normative item no requirement cites and no context entry may excuse.
  const context = new Map(map.context.map((entry) => [entry.item, entry.reason]));
  for (const item of items) {
    const cited = citedBy.has(item.id);
    if (context.has(item.id)) {
      if (item.normative) {
        issue(errors, 'CONTEXT_IS_NORMATIVE', item.id, `${item.id} (line ${item.lineStart}) states an obligation and cannot be set aside as context: "${item.text.slice(0, 120)}"`);
      }
      continue;
    }
    if (!cited) {
      issue(item.normative ? errors : warnings, 'OMITTED_REQUIREMENT', item.id,
        `${item.id} (line ${item.lineStart}) is cited by no requirement${item.normative ? '' : ' and not marked as context'}: "${item.text.slice(0, 120)}"`);
    }
  }
  for (const id of context.keys()) if (!byId.has(id)) issue(errors, 'SOURCE_ITEM_UNKNOWN', id, `Context cites ${id}, which the source does not contain.`);

  // Duplicates and conflicting interpretations of the same clause.
  for (const [id, citing] of citedBy) {
    for (let i = 0; i < citing.length; i += 1) {
      for (let j = i + 1; j < citing.length; j += 1) {
        const a = citing[i]!;
        const b = citing[j]!;
        const disjointClauses = a.quote !== null && b.quote !== null && !a.quote.includes(b.quote) && !b.quote.includes(a.quote);
        if (disjointClauses) continue;
        // An interaction cites the clauses of what it joins; that is a relationship, not a reading.
        if (a.kind !== b.kind) continue;
        const sameSources = [...a.source].sort().join() === [...b.source].sort().join();
        if (!sameSources) continue;
        if (normalize(a.behavior) === normalize(b.behavior)) {
          issue(errors, 'DUPLICATE_REQUIREMENT', `${a.key}/${b.key}`, `${a.key} and ${b.key} state the same behavior for ${id}; one requirement, implemented once.`);
        } else {
          issue(errors, 'CONFLICTING_INTERPRETATION', `${a.key}/${b.key}`,
            `${a.key} and ${b.key} read ${id} differently ("${a.behavior.slice(0, 80)}" vs "${b.behavior.slice(0, 80)}"). Split the clause with exact quotes, or carry it as one requirement with an ambiguity a person answers.`);
        }
      }
    }
  }

  // A revision may not drop, redefine, or disconnect what a person approved.
  if (options.previous) {
    for (const before of options.previous.requirements) {
      const after = keys.get(before.key);
      if (!after) {
        issue(errors, 'REQUIREMENT_DROPPED', before.key, `${before.key} was approved and is missing from the revision. Only a person removes a requirement.`);
        continue;
      }
      if (normalize(after.behavior) !== normalize(before.behavior) || JSON.stringify(after.verification) !== JSON.stringify(before.verification) || after.source.join() !== before.source.join()) {
        issue(errors, 'REQUIREMENT_REDEFINED', before.key, `${before.key}'s source, behavior or verification differs from what was approved. Only a person changes what a requirement means.`);
      }
      for (const edge of edgesOf(before)) {
        if (!edgesOf(after, options.extraEdges).includes(edge)) {
          issue(errors, 'RELATIONSHIP_LOST', before.key, `${before.key} → ${edge} was approved and the revision loses it.`);
        }
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}
