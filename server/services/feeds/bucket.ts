/**
 * The discovery "bucket" a feed shortlist round is filed under.
 *
 * A shortlist round is not a place to look: its question is composed each day
 * from the leads free models and Brain's rules kept, and lists them by
 * address. It is a bucket only so `harvest` resolves the round, closes it and
 * counts what it found, exactly as for every other round.
 */
import type { SearchBucket } from '../cash/discovery.ts';

export const FEED_SHORTLIST_BUCKET: SearchBucket = Object.freeze({
  id: 'feed-shortlist',
  mechanism: 'EXISTING_BUYING_SIGNAL',
  title: 'Verify the leads the feeds shortlisted today',
  question:
    'Which of the published leads listed below show a business that would pay this operation, soon, for one finished piece of digital work?',
});
