import { useEffect, useState } from 'react';
import { DecksPage } from './pages/Decks.tsx';
import { ImportPage } from './pages/Import.tsx';
import { GuidePage } from './pages/Guide.tsx';
import { PlayPage } from './pages/Play.tsx';
import { ReviewPage } from './pages/Review.tsx';
import { LearningPage } from './pages/Learning.tsx';
import { AboutPage } from './pages/About.tsx';

/** A tiny hash router: My decks → import/review → deck guide → guided practice → review. */
export function navigate(to: string) { window.location.hash = to; }

function useRoute(): string[] {
  const read = () => window.location.hash.replace(/^#\/?/, '').split('?')[0]!.split('/').filter(Boolean);
  const [r, setR] = useState(read);
  useEffect(() => {
    const on = () => { setR(read()); window.scrollTo(0, 0); };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return r;
}

export function App() {
  const route = useRoute();
  const [head, a, b] = route;
  let page;
  if (!head) page = <DecksPage />;
  else if (head === 'import') page = <ImportPage deckId={a} />;
  else if (head === 'decks' && a && b === 'edit') page = <ImportPage deckId={a} />;
  else if (head === 'decks' && a) page = <GuidePage deckId={a} />;
  else if (head === 'play' && a) page = <PlayPage key={a} matchId={a} />; // a new match must not show the previous one's board
  else if (head === 'review' && a) page = <ReviewPage matchId={a} />;
  else if (head === 'learning') page = <LearningPage />;
  else if (head === 'about') page = <AboutPage />;
  else page = <DecksPage />;
  const playing = head === 'play';
  return (
    <div className={playing ? 'app app-playing' : 'app'}>
      <header className="topbar">
        <a className="brand" href="#/">Deck Tutor</a>
        <nav>
          <a href="#/" className={!head ? 'on' : ''}>My decks</a>
          <a href="#/learning" className={head === 'learning' ? 'on' : ''}>Learning</a>
          <a href="#/about" className={head === 'about' ? 'on' : ''}>About</a>
        </nav>
      </header>
      <main>{page}</main>
    </div>
  );
}
