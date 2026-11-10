/**
 * A constructed ChatGPT export in the export's own tree shape, shared by the
 * historical-memory suites. Mechanism fixtures only — never evidence that
 * anybody's real history was recovered.
 */
export type Turn = [role: 'user' | 'assistant', text: string, at: string];

/** A conversation in the export's own tree shape. */
export function exportConversation(
  id: string,
  title: string,
  turns: Turn[],
  extra: { gizmo?: string; branchAt?: number; branchText?: string; image?: boolean; file?: boolean } = {},
): Record<string, unknown> {
  const mapping: Record<string, unknown> = {};
  const root = `${id}-root`;
  mapping[root] = { id: root, parent: null, children: [], message: null };
  let parent = root;
  turns.forEach(([role, text, at], index) => {
    const nodeId = `${id}-n${index}`;
    const parts: unknown[] = [text];
    const metadata: Record<string, unknown> = {};
    if (extra.image && index === 0) {
      parts.unshift({ content_type: 'image_asset_pointer', asset_pointer: `file-service://file-IMG${id}`, size_bytes: 120, width: 64, height: 48 });
    }
    if (extra.file && index === 0) {
      metadata.attachments = [{ id: `file-DOC${id}`, name: 'treatment.pdf', mime_type: 'application/pdf', size: 900 }];
    }
    mapping[nodeId] = {
      id: nodeId,
      parent,
      children: [],
      message: {
        id: nodeId,
        author: { role },
        content: { content_type: extra.image && index === 0 ? 'multimodal_text' : 'text', parts },
        create_time: Date.parse(at) / 1000,
        metadata,
      },
    };
    (mapping[parent] as { children: string[] }).children.push(nodeId);
    // An edited prompt: a sibling of the node at branchAt, left behind.
    if (extra.branchAt === index && extra.branchText) {
      const alt = `${id}-alt${index}`;
      mapping[alt] = {
        id: alt,
        parent,
        children: [],
        message: { id: alt, author: { role }, content: { content_type: 'text', parts: [extra.branchText] }, create_time: Date.parse(at) / 1000 - 5 },
      };
      (mapping[parent] as { children: string[] }).children.unshift(alt);
    }
    parent = nodeId;
  });
  return {
    id,
    conversation_id: id,
    title,
    create_time: Date.parse(turns[0]![2]) / 1000,
    update_time: Date.parse(turns[turns.length - 1]![2]) / 1000,
    mapping,
    current_node: parent,
    gizmo_id: extra.gizmo ?? null,
  };
}

/** A small history with real shapes in it: a commitment, a forgotten idea, outcomes. */
export function history(): Record<string, unknown>[] {
  const film = (n: number, month: string, user: string): Record<string, unknown> =>
    exportConversation(`film-${n}`, `Short film session ${n}`, [
      ['user', user, `${month}-03T10:00:00Z`],
      ['assistant', 'Here are thoughts on the screenplay structure, the protagonist arc and camera blocking for your short film.', `${month}-03T10:01:00Z`],
    ]);
  return [
    film(1, '2025-06', "I'm going to make my short film this summer about a lighthouse keeper. My dream is to direct films."),
    film(2, '2025-07', 'I finished the second draft of my screenplay for the lighthouse short film. The protagonist arc works now.'),
    film(3, '2025-08', "I'm going to shoot the lighthouse short film in September. I want to learn camera blocking for the screenplay."),
    film(4, '2025-09', 'I just filmed the first scenes of the lighthouse short film! The camera blocking was hard.'),
    film(5, '2025-10', 'I loved Paris, Texas — the long takes. My style for the short film should feel like that, quiet and patient.'),
    film(6, '2025-11', "I've been working on the edit of the lighthouse short film and the screenplay rewrite."),
    exportConversation(
      'idea-1',
      'Random late night thought',
      [
        ['user', 'What if I opened a tiny ceramics studio that rents kiln time to beginners? I have always wanted to do that, but the problem is I cannot afford a kiln.', '2024-03-02T01:00:00Z'],
        ['assistant', 'That is a lovely idea; kiln rental businesses exist in many cities.', '2024-03-02T01:01:00Z'],
      ],
      { branchAt: 0, branchText: 'What if I opened a pottery place?', image: true },
    ),
    exportConversation('idea-2', 'Dropshipping', [
      ['user', 'I want to start a dropshipping store selling phone cases to earn passive income.', '2024-05-01T10:00:00Z'],
      ['assistant', 'Here is how dropshipping works.', '2024-05-01T10:01:00Z'],
    ]),
    exportConversation('idea-3', 'Store update', [
      ['user', "I'm giving up on the dropshipping phone cases store — not worth it.", '2024-06-01T10:00:00Z'],
      ['assistant', 'Understood.', '2024-06-01T10:01:00Z'],
    ]),
    exportConversation('idea-4', 'Podcast', [
      ['user', 'I want to launch a podcast interviewing local skateboard shop owners.', '2024-07-01T10:00:00Z'],
      ['assistant', 'Great idea.', '2024-07-01T10:01:00Z'],
      ['user', "Let's put the skateboard podcast on hold until school ends.", '2024-07-01T10:05:00Z'],
    ], { file: true }),
    exportConversation('idea-5', 'App idea', [
      ['user', 'My idea: an app that reminds roommates whose turn it is for chores. But I do not know how to code it.', '2024-09-09T10:00:00Z'],
      ['assistant', 'You could prototype it with no-code tools.', '2024-09-09T10:01:00Z'],
    ], { gizmo: 'g-p-roommates' }),
    exportConversation('q-1', 'Quick question', [
      ['user', 'I want to know what the capital of Australia is.', '2024-10-01T10:00:00Z'],
      ['assistant', 'Canberra.', '2024-10-01T10:01:00Z'],
    ]),
  ];
}

