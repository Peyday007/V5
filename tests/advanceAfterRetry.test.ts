/**
 * A completion's packet advance survives a database that did not answer.
 *
 * The released-image verification after a restart saw a verification complete
 * and its packet left with the question unsettled and no synthesis queued: the
 * advance hit a contended pool and was swallowed. It is retried now, briefly,
 * and only for the database's own "not now" — any other error is a defect and
 * is not retried.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const advancePacket = vi.fn();
vi.mock('../server/services/research/packetRunner.ts', () => ({ advancePacket }));

const { advanceAfter } = await import('../server/mcp/tools.ts');

afterEach(() => {
  advancePacket.mockReset();
  vi.restoreAllMocks();
});

describe('advanceAfter', () => {
  it('retries an advance the database could not answer, and stops once it lands', async () => {
    const busy = Object.assign(new Error('timeout exceeded when trying to connect'), {});
    advancePacket.mockRejectedValueOnce(busy).mockRejectedValueOnce(busy).mockResolvedValueOnce(undefined);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    await advanceAfter({ orchestrationId: 'orc_x' }, [0, 0, 0]);
    expect(advancePacket).toHaveBeenCalledTimes(3);
    expect(logged).not.toHaveBeenCalled();
  });

  it('does not retry an error that is not the database being busy', async () => {
    advancePacket.mockRejectedValue(new Error('a real defect'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    await advanceAfter({ orchestrationId: 'orc_x' }, [0, 0, 0]);
    expect(advancePacket).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalledOnce();
  });

  it('gives up after its bounded waits and logs, never throwing into the completion', async () => {
    advancePacket.mockRejectedValue(new Error('timeout exceeded when trying to connect'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(advanceAfter({ orchestrationId: 'orc_x' }, [0, 0])).resolves.toBeUndefined();
    expect(advancePacket).toHaveBeenCalledTimes(3);
  });

  it('does nothing for an item outside a packet', async () => {
    await advanceAfter({ orchestrationId: null });
    expect(advancePacket).not.toHaveBeenCalled();
  });
});
