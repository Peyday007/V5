/**
 * CHECK-1: the requirement-map checklist names every field and status the code defines,
 * and the statuses appear in the code's order. Both lists are read from the code.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { REQUIREMENT_STATUSES } from '../server/domain/factoryProgram.ts';

const checklist = readFileSync(new URL('../docs/FACTORY-PROGRAMS-CHECKLIST.md', import.meta.url), 'utf8');
const source = readFileSync(new URL('../server/domain/factoryProgram.ts', import.meta.url), 'utf8');

/** Field names declared in `interface ProgramRequirement`, read from the source text. */
function requirementFields(): string[] {
  const start = source.indexOf('export interface ProgramRequirement {');
  const end = source.indexOf('\n}\n', start);
  const body = source.slice(start, end);
  const names: string[] = [];
  let depth = 0;
  for (const line of body.split('\n').slice(1)) {
    const code = line.trim();
    if (depth === 0) {
      const match = /^([a-zA-Z]+)\??:/.exec(code);
      if (match) names.push(match[1]!);
    }
    depth += (line.match(/[{[(]/g) ?? []).length - (line.match(/[}\])]/g) ?? []).length;
  }
  return names;
}

const listedIn = (doc: string, name: string): boolean => doc.includes(`\`${name}\``);
const listed = (name: string): boolean => listedIn(checklist, name);

/** Every field and status the code defines that `doc` fails to name. */
function omissions(doc: string): string[] {
  return [...requirementFields(), ...REQUIREMENT_STATUSES].filter((name) => !listedIn(doc, name));
}

describe('requirement-map checklist', () => {
  const sixteen = [
    'key', 'kind', 'title', 'subsystem', 'source', 'behavior', 'inputs', 'outputs',
    'constraints', 'dependsOn', 'interactsWith', 'existing', 'missingWork', 'paths',
    'verification', 'ambiguities',
  ];

  it('reads a real field list from the code', () => {
    const fields = requirementFields();
    for (const name of sixteen) expect(fields).toContain(name);
  });

  it('names every field of a requirement in the code', () => {
    for (const name of requirementFields()) expect(listed(name), `missing field ${name}`).toBe(true);
    for (const name of sixteen) expect(listed(name), `missing field ${name}`).toBe(true);
  });

  it('lists every status, in the order the code defines them, each with a meaning', () => {
    let from = checklist.indexOf('## Requirement statuses');
    expect(from).toBeGreaterThan(-1);
    for (const status of REQUIREMENT_STATUSES) {
      const at = checklist.indexOf(`\`${status}\` — `, from);
      expect(at, `status ${status} missing or out of order`).toBeGreaterThan(-1);
      from = at;
      const line = checklist.slice(at).split('\n')[0]!;
      expect(line.length, `status ${status} has no meaning`).toBeGreaterThan(status.length + 10);
    }
  });

  it('carries the two strings the named checks look for', () => {
    expect(checklist).toContain('missingWork');
    expect(checklist).toContain('INTEGRATED');
  });

  it('fails when a field or a status is removed (the check is real)', () => {
    expect(omissions(checklist)).toEqual([]);
    const without = checklist.replaceAll('`missingWork`', 'x').replaceAll('`NOT_DONE`', 'x');
    expect(omissions(without)).toEqual(['missingWork', 'NOT_DONE']);
  });
});
