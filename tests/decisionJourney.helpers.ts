import { capture } from '../server/services/russell/judgment.ts';

/** An idea captured in a conversation, the way a Russell turn captures one. */
export async function captureCandidate(projectId: string, conversationId: string): Promise<string> {
  const outcome = await capture({
    title: 'Cut the interview footage down to a ten-minute assembly',
    statement: 'Assemble the strongest ten minutes from the recorded interviews into a first cut.',
    projectId,
    visibility: 'SHARED',
    conversationId,
  });
  return outcome.candidate!.id;
}
