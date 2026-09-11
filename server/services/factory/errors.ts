/**
 * One error type for the factory's own refusals.
 *
 * Separate from `ContractError` because that one means *this contract cannot be
 * accepted*, and these mean *this operation cannot be performed* — a repository
 * Brain cannot read, a report that does not parse, a sha that does not exist. The
 * HTTP surface maps them differently and conflating them made a 422 out of an
 * outage once already.
 */
export class FactoryError extends Error {
  readonly detail: Record<string, unknown>;
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = 'FactoryError';
    this.detail = detail;
  }
}
