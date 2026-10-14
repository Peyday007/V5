import Anthropic from '@anthropic-ai/sdk';

/**
 * The optional language model behind live coaching. It only ever explains and recommends from
 * the viewer-safe context it is given; nothing it returns changes game state, and a recommended
 * action is applied only if the person chooses it and the engine still offers it.
 */
export interface CoachModel {
  readonly configured: boolean;
  readonly label: string;
  /** Returns parsed JSON matching the schema, or throws. */
  json(system: string, user: string, schema: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
}

export class UnconfiguredModel implements CoachModel {
  readonly configured = false;
  readonly label = 'not configured';
  async json(): Promise<unknown> {
    throw new Error('No language model is configured (set ANTHROPIC_API_KEY on the server).');
  }
}

export class AnthropicCoach implements CoachModel {
  readonly configured = true;
  private client: Anthropic;

  constructor(apiKey: string, private model: string) {
    this.client = new Anthropic({ apiKey, maxRetries: 1 });
  }

  get label(): string { return this.model; }

  async json(system: string, user: string, schema: Record<string, unknown>, timeoutMs = 45_000): Promise<unknown> {
    const response = await this.client.beta.messages.create(
      {
        model: this.model,
        max_tokens: 4000,
        // Coaching is latency-sensitive: a person is waiting mid-game.
        output_config: { effort: 'low', format: { type: 'json_schema', schema } },
        // On a safety decline, re-run on Anthropic's recommended fallback model rather than fail.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system,
        messages: [{ role: 'user', content: user }],
      },
      { timeout: timeoutMs },
    );
    if (response.stop_reason === 'refusal') throw new Error('The model declined to answer this question.');
    if (response.stop_reason === 'max_tokens') throw new Error('The model\'s answer was cut off.');
    const text = response.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    return JSON.parse(text);
  }

  /** Reads card names from a photo. Names only; the person confirms each one. */
  async vision(image: Buffer, mediaType: string, prompt: string): Promise<string[]> {
    const response = await this.client.beta.messages.create(
      {
        model: this.model,
        max_tokens: 2000,
        output_config: { effort: 'low', format: { type: 'json_schema', schema: { type: 'object', properties: { names: { type: 'array', items: { type: 'string' } } }, required: ['names'], additionalProperties: false } } },
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType as 'image/png', data: image.toString('base64') } },
          { type: 'text', text: prompt },
        ] }],
      },
      { timeout: 60_000 },
    );
    if (response.stop_reason === 'refusal') return [];
    const text = response.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    return (JSON.parse(text) as { names: string[] }).names;
  }
}

export interface VisionModel {
  vision(image: Buffer, mediaType: string, prompt: string): Promise<string[]>;
}

export function createCoachModel(apiKey: string | null, model: string): CoachModel {
  return apiKey ? new AnthropicCoach(apiKey, model) : new UnconfiguredModel();
}
