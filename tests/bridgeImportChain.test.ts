import { describe, expect, it } from 'vitest';
import { parseTranscript } from '../server/services/bridge/import.ts';

const node = (id: string, parent: string | null, children: string[], role?: string, text?: string) => ({
  id,
  parent,
  children,
  message: role ? { author: { role }, content: { parts: [text ?? id] } } : null,
});

describe('conversation import fidelity', () => {
  it('follows current_node into a non-last sibling', () => {
    const conversation = {
      title: 'Edited',
      current_node: 'a1',
      mapping: {
        root: node('root', null, ['q1', 'q2']),
        q1: node('q1', 'root', ['a1'], 'user', 'first question'),
        a1: node('a1', 'q1', [], 'assistant', 'first answer'),
        q2: node('q2', 'root', [], 'user', 'edited question'),
      },
    };
    const parsed = parseTranscript({ body: JSON.stringify(conversation) });
    expect(parsed.messages.map((m) => m.content)).toEqual(['first question', 'first answer']);
    expect(parsed.notes.join(' ')).toMatch(/branches/);
  });

  it('falls back to the last child without current_node', () => {
    const conversation = {
      mapping: {
        root: node('root', null, ['q1', 'q2']),
        q1: node('q1', 'root', [], 'user', 'old'),
        q2: node('q2', 'root', [], 'user', 'new'),
      },
    };
    const parsed = parseTranscript({ body: JSON.stringify(conversation) });
    expect(parsed.messages.map((m) => m.content)).toEqual(['new']);
  });

  it('reports conversations it did not read', () => {
    const one = (id: string) => ({
      mapping: { root: node('root', null, ['q'], undefined), q: node('q', 'root', [], 'user', id) },
    });
    const parsed = parseTranscript({ body: JSON.stringify([one('a'), one('b'), one('c')]) });
    expect(parsed.messages.map((m) => m.content)).toEqual(['a']);
    expect(parsed.notes.join(' ')).toMatch(/2 were not/);
  });

  it('keeps a preamble as an UNKNOWN message at ordinal 0', () => {
    const parsed = parseTranscript({ body: 'Context line\nYou: hi' });
    expect(parsed.messages).toHaveLength(2);
    expect(parsed.messages[0]).toMatchObject({ ordinal: 0, role: 'UNKNOWN', content: 'Context line' });
    expect(parsed.messages[1]?.ordinal).toBe(1);
    expect(parsed.notes.length).toBeGreaterThan(0);
  });
});
