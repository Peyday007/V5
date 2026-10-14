import { createContext } from './context.ts';
import { createApp } from './app.ts';

const ctx = createContext();
const app = createApp(ctx);
app.listen(ctx.config.port, '127.0.0.1', () => {
  const cat = ctx.catalog.status();
  console.log(`[tutor] http://127.0.0.1:${ctx.config.port}  cards=${cat.cards} rules=${ctx.rules.info().effective ?? 'not loaded'} model=${ctx.config.anthropicKey ? ctx.config.model : 'not configured'}`);
  if (cat.cards === 0) console.log('[tutor] The card catalog is empty: run `npm run cards:sync` (downloads Scryfall bulk data and the Comprehensive Rules).');
});
