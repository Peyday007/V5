/**
 * A generated architecture large enough to be a real test of a program: six
 * interdependent subsystems of twenty requirements each, six cross-subsystem
 * interactions, requirements that share a file across subsystems, eighteen
 * requirements an existing implementation already answers, one ambiguity with a
 * proposed reading and one nobody may answer but a person.
 *
 * Every requirement is verified by a bundle marker `marker:<KEY>`, so a test's
 * fake production can say exactly which requirements behave.
 */
import type { ProgramRequirement, RequirementMap } from '../../server/domain/factoryProgram.ts';
import { extractSourceItems } from '../../server/services/factory/program/spec.ts';

export const SUBSYSTEMS = [
  { code: 'ING', name: 'Ingest' },
  { code: 'MOD', name: 'Model' },
  { code: 'QNT', name: 'Quant' },
  { code: 'LED', name: 'Ledger' },
  { code: 'WEB', name: 'Web' },
  { code: 'OPS', name: 'Ops' },
] as const;

export const PER_SUBSYSTEM = 20;
export const EXISTING_AT = [2, 9, 15];

const pad = (n: number): string => String(n).padStart(2, '0');

export function largeSpecification(): { source: string; map: RequirementMap } {
  const lines: string[] = ['# Brain Master Architecture (reliability fixture)', ''];
  for (const s of SUBSYSTEMS) {
    lines.push(`## ${s.name}`, '', `${s.name} capabilities:`, '');
    for (let n = 1; n <= PER_SUBSYSTEM; n += 1) {
      const extra = s.code === 'ING' && n === 7 ? ' as appropriate' : s.code === 'MOD' && n === 3 ? ' within a limit that is TBD' : '';
      lines.push(`- ${s.code}-${pad(n)}: The ${s.name} subsystem must produce result ${n} of kind ${s.code.toLowerCase()}${extra}.`);
    }
    lines.push('');
  }
  lines.push('## Interactions', '', 'Interaction list:', '');
  for (let n = 1; n <= 6; n += 1) {
    lines.push(`- X-${pad(n)}: Results of ${SUBSYSTEMS[n - 1]!.name} must be consumed correctly by ${SUBSYSTEMS[n % 6]!.name}.`);
  }
  lines.push('', '## Notes', '', 'This document is a reliability fixture.', '');
  const source = lines.join('\n');
  const items = extractSourceItems(source);
  const itemFor = (prefix: string): string => {
    const found = items.find((i) => i.text.startsWith(`- ${prefix}:`));
    if (!found) throw new Error(`fixture: no item ${prefix}`);
    return found.id;
  };

  const requirements: ProgramRequirement[] = [];
  SUBSYSTEMS.forEach((s, index) => {
    for (let n = 1; n <= PER_SUBSYSTEM; n += 1) {
      const key = `${s.code}-${pad(n)}`;
      const dependsOn: string[] = [];
      if (n > 1 && n % 4 !== 1) dependsOn.push(`${s.code}-${pad(n - 1)}`);
      if (index > 0 && n % 5 === 0) dependsOn.push(`${SUBSYSTEMS[index - 1]!.code}-${pad(n)}`);
      const existing = EXISTING_AT.includes(n);
      const shared = (s.code === 'MOD' || s.code === 'QNT') && n % 10 === 0;
      requirements.push({
        key,
        kind: 'CAPABILITY',
        title: `${s.name} result ${n}`,
        subsystem: s.name,
        source: [itemFor(key)],
        quote: null,
        behavior: `${s.name} produces result ${n} of kind ${s.code.toLowerCase()} for its consumers.`,
        inputs: [`${s.name} input ${n}`],
        outputs: [`${s.code.toLowerCase()} result ${n}`],
        constraints: n % 3 === 0 ? ['idempotent by key'] : [],
        dependsOn,
        interactsWith: [],
        existing: existing ? { paths: [`server/${s.code.toLowerCase()}/existing${n}.ts`], evidence: `server/${s.code.toLowerCase()}/existing${n}.ts produces it today` } : null,
        missingWork: existing ? '' : `Implement ${s.name} result ${n}.`,
        paths: existing ? [] : [`server/${s.code.toLowerCase()}/cap${n}.ts`, ...(shared ? ['server/shared/contracts.ts'] : [])],
        verification: [{ kind: 'BUNDLE_TEXT', text: `marker:${key}` }],
        ambiguities:
          key === 'ING-07'
            ? [{ item: itemFor(key), question: 'Which handling does "as appropriate" mean?', interpretation: 'Handle it the way the existing ingest path does.' }]
            : key === 'MOD-03'
              ? [{ item: itemFor(key), question: 'What is the limit?', interpretation: null }]
              : [],
      });
    }
  });
  for (let n = 1; n <= 6; n += 1) {
    const from = SUBSYSTEMS[n - 1]!;
    const to = SUBSYSTEMS[n % 6]!;
    const key = `X-${pad(n)}`;
    requirements.push({
      key,
      kind: 'INTERACTION',
      title: `${from.name} → ${to.name}`,
      subsystem: 'Interactions',
      source: [itemFor(key)],
      quote: null,
      behavior: `A result newly produced by ${from.name} is consumed correctly by ${to.name}.`,
      inputs: [],
      outputs: [],
      constraints: [],
      dependsOn: [],
      interactsWith: [`${from.code}-${pad(3 * n)}`, `${to.code}-${pad(3 * n + 1)}`],
      existing: null,
      missingWork: `Wire ${from.name} results into ${to.name}.`,
      paths: [`server/interactions/x${n}.ts`],
      verification: [{ kind: 'BUNDLE_TEXT', text: `marker:${key}` }],
      ambiguities: [],
    });
  }
  const cited = new Set(requirements.flatMap((r) => r.source));
  const context = items.filter((i) => !cited.has(i.id)).map((i) => ({ item: i.id, reason: 'a heading lead-in or note' }));
  return { source, map: { requirements, context } };
}
