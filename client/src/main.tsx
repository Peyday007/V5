/**
 * Client entry point.
 *
 * Nothing here may know about project state: the whole application is mounted
 * blind and `Root` asks the server what is true — including which shell this
 * address wants and who is signed in. A missing `#root` is reported
 * loudly rather than silently producing a blank page, because a blank screen is
 * indistinguishable from "the project has no work left" and that ambiguity is
 * exactly what this platform exists to remove.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import Root from './Root.tsx';
import './styles.css';

const container = document.getElementById('root');

if (!container) {
  document.body.innerHTML =
    '<div class="boot-error"><h1>BRAIN COULD NOT START</h1>' +
    '<p>index.html is missing its &lt;div id="root"&gt; mount point.</p></div>';
  throw new Error('Brain could not start: #root is missing from index.html.');
}

createRoot(container).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
