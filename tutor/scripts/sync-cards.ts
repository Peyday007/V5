/**
 * Downloads Scryfall's Oracle Cards and Rulings bulk files and the current Comprehensive Rules
 * into the local cache. Scryfall asks that gameplay data be refreshed weekly or after a set
 * release, not more often; the server also offers this from the interface.
 */
import { createContext } from '../server/context.ts';

const ctx = createContext();
const cards = await ctx.catalog.sync((m) => console.log('[cards]', m));
console.log('[cards]', cards);
const rules = await ctx.rules.sync();
console.log('[rules]', rules);
