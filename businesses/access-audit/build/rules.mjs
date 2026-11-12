// Plain-English explanations and concrete fixes for the axe-core rules that
// small-business sites fail most often. Anything not listed falls back to
// axe-core's own help text and help URL, so no rule is ever silently dropped.

export const WCAG_NAMES = {
  '1.1.1': 'Non-text Content', '1.2.2': 'Captions (Prerecorded)', '1.3.1': 'Info and Relationships',
  '1.3.5': 'Identify Input Purpose', '1.4.1': 'Use of Color', '1.4.2': 'Audio Control', '1.4.3': 'Contrast (Minimum)',
  '1.4.4': 'Resize Text', '1.4.10': 'Reflow', '1.4.11': 'Non-text Contrast', '1.4.12': 'Text Spacing',
  '2.1.1': 'Keyboard', '2.1.2': 'No Keyboard Trap', '2.2.1': 'Timing Adjustable', '2.2.2': 'Pause, Stop, Hide',
  '2.4.1': 'Bypass Blocks', '2.4.2': 'Page Titled', '2.4.3': 'Focus Order', '2.4.4': 'Link Purpose (In Context)',
  '2.4.6': 'Headings and Labels', '2.4.7': 'Focus Visible', '2.4.11': 'Focus Not Obscured (Minimum)',
  '2.5.3': 'Label in Name', '2.5.8': 'Target Size (Minimum)', '3.1.1': 'Language of Page', '3.1.2': 'Language of Parts',
  '3.3.2': 'Labels or Instructions', '4.1.1': 'Parsing', '4.1.2': 'Name, Role, Value', '4.1.3': 'Status Messages',
};

/** axe tags such as "wcag143" -> "1.4.3" */
export function criteriaFromTags(tags) {
  const out = [];
  for (const t of tags) {
    const m = /^wcag(\d)(\d)(\d+)$/.exec(t);
    if (m) out.push(`${m[1]}.${m[2]}.${m[3]}`);
  }
  return [...new Set(out)];
}

export function levelFromTags(tags) {
  if (tags.some((t) => /^wcag2(1|2)?aa$/.test(t))) return 'AA';
  if (tags.some((t) => /^wcag2(1|2)?a$/.test(t))) return 'A';
  if (tags.includes('best-practice')) return 'best practice';
  return '';
}

export const RULES = {
  'image-alt': {
    plain: 'An image has no text alternative, so a blind visitor using a screen reader hears nothing (or the file name) instead of what the picture shows.',
    fix: 'Add a short alt attribute that says what the image communicates: <img src="crown.jpg" alt="Porcelain crown on a lower molar">. If the image is purely decorative, use alt="" so screen readers skip it.',
  },
  'role-img-alt': {
    plain: 'An element presented as an image (role="img") has no accessible name.',
    fix: 'Give it aria-label="what the image shows", or if decorative remove role="img" and add aria-hidden="true".',
  },
  'svg-img-alt': {
    plain: 'An SVG icon or graphic marked as an image has no text alternative.',
    fix: 'Add <title>Description</title> as the first child of the <svg> and aria-labelledby pointing to it, or aria-hidden="true" if it is decorative.',
  },
  'input-image-alt': {
    plain: 'An image used as a button has no text alternative, so its purpose is not announced.',
    fix: 'Add alt text describing the action: <input type="image" src="go.png" alt="Search">.',
  },
  'color-contrast': {
    plain: 'Text is too faint against its background. People with low vision, older visitors and anyone on a phone in sunlight may not be able to read it. WCAG AA requires a contrast ratio of at least 4.5:1 for normal text and 3:1 for large text.',
    fix: 'Darken the text or lighten the background until the ratio reaches 4.5:1 (3:1 for text 24px+ or 18.66px+ bold). The exact colours and measured ratio are listed per element below; a free checker such as WebAIM\'s contrast checker shows a passing shade.',
  },
  'link-name': {
    plain: 'A link has no readable text (often an icon-only link such as a social-media logo or a linked image without alt), so a screen reader announces only "link".',
    fix: 'Put visible text inside the link, or add an accessible name: <a href="https://facebook.com/…" aria-label="Our Facebook page"><svg aria-hidden="true">…</svg></a>.',
  },
  'button-name': {
    plain: 'A button has no readable name (often an icon-only menu, close or arrow button), so a screen-reader user cannot tell what it does.',
    fix: 'Add text or an aria-label: <button aria-label="Open menu"><svg aria-hidden="true">…</svg></button>.',
  },
  label: {
    plain: 'A form field has no label tied to it. Screen readers announce just "edit text", and placeholder text disappears as soon as someone types.',
    fix: 'Associate a visible label: <label for="email">Email</label> <input id="email" type="email" autocomplete="email">. If a visible label is impossible, add aria-label="Email".',
  },
  'select-name': {
    plain: 'A drop-down menu has no label, so its purpose is not announced.',
    fix: 'Add <label for="qty">Quantity</label> with a matching id on the <select>, or aria-label="Quantity".',
  },
  'label-title-only': {
    plain: 'A form field is labelled only by a tooltip (title attribute), which many users never see.',
    fix: 'Add a visible <label for="…"> element.',
  },
  'html-has-lang': {
    plain: 'The page does not declare its language, so screen readers may read English text with the wrong pronunciation rules.',
    fix: 'Set the language on the root element: <html lang="en">.',
  },
  'html-lang-valid': {
    plain: 'The page declares a language code that is not valid.',
    fix: 'Use a valid code, for example <html lang="en"> or <html lang="en-US">.',
  },
  'document-title': {
    plain: 'The page has no title, which is the first thing a screen reader announces and what appears in browser tabs.',
    fix: 'Add <title>Page name – Business name</title> inside <head>.',
  },
  'frame-title': {
    plain: 'An embedded frame (map, video, booking widget) has no title, so its purpose is not announced.',
    fix: 'Add a title: <iframe src="…maps…" title="Map to our office"></iframe>.',
  },
  'aria-hidden-focus': {
    plain: 'Something hidden from screen readers (aria-hidden="true") still contains links or buttons a keyboard user can tab to, so focus lands on elements that are announced as nothing.',
    fix: 'Remove aria-hidden from containers with interactive content, or make the inner controls unfocusable (tabindex="-1", or the inert attribute) while they are hidden.',
  },
  'aria-required-children': {
    plain: 'An element uses an ARIA role (e.g. a menu or list) without the child elements that role requires, so assistive technology misreports its structure.',
    fix: 'Either add the required child roles (e.g. role="menuitem" inside role="menu") or remove the ARIA role and use plain HTML lists and links.',
  },
  'aria-required-parent': {
    plain: 'An element uses an ARIA role that must sit inside a particular parent role, but it does not.',
    fix: 'Wrap it in the required parent role, or remove the role and use native HTML.',
  },
  'aria-allowed-attr': {
    plain: 'An element uses an ARIA attribute that is not allowed for its role, which can confuse assistive technology.',
    fix: 'Remove the attribute or change the element to one where it is valid.',
  },
  'aria-valid-attr-value': {
    plain: 'An ARIA attribute has an invalid value (for example aria-controls pointing at an id that does not exist).',
    fix: 'Correct the value so it references a real id or uses an allowed token.',
  },
  'aria-prohibited-attr': {
    plain: 'An ARIA attribute such as aria-label is used on an element where it is not supported, so it is likely ignored.',
    fix: 'Move the label to a supported element or replace it with visible text.',
  },
  'aria-command-name': {
    plain: 'A custom button/link (role="button" or role="link") has no accessible name.',
    fix: 'Add visible text or aria-label describing the action.',
  },
  'aria-input-field-name': {
    plain: 'A custom input (e.g. a slider or combobox built with ARIA) has no accessible name.',
    fix: 'Add aria-label or aria-labelledby pointing to its visible label.',
  },
  'aria-toggle-field-name': {
    plain: 'A custom toggle (checkbox/switch built with ARIA) has no accessible name.',
    fix: 'Add aria-label or aria-labelledby.',
  },
  'aria-dialog-name': { plain: 'A dialog/pop-up has no accessible name.', fix: 'Add aria-labelledby pointing to the dialog\'s heading.' },
  'list': {
    plain: 'A list (<ul> or <ol>) contains something other than list items, so screen readers miscount or misread it.',
    fix: 'Make every direct child of <ul>/<ol> an <li> (wrap other elements inside an <li>).',
  },
  'listitem': {
    plain: 'A list item (<li>) is not inside a list, so its grouping is lost for screen-reader users.',
    fix: 'Wrap <li> elements in a <ul> or <ol>.',
  },
  'definition-list': { plain: 'A definition list contains invalid children.', fix: 'Only use <dt>, <dd> (or <div> wrapping them) inside <dl>.' },
  'duplicate-id-aria': {
    plain: 'Two elements share the same id, and that id is used to connect a label or description, so the wrong text may be announced.',
    fix: 'Give each element a unique id and update the matching for= / aria-labelledby references.',
  },
  'nested-interactive': {
    plain: 'A clickable control is nested inside another clickable control, so keyboard and screen-reader users cannot reach or identify one of them.',
    fix: 'Separate them so no link or button sits inside another link or button.',
  },
  'meta-viewport': {
    plain: 'The page blocks pinch-zoom on phones, so people with low vision cannot enlarge text.',
    fix: 'Remove maximum-scale=1 / user-scalable=no: <meta name="viewport" content="width=device-width, initial-scale=1">.',
  },
  'meta-refresh': { plain: 'The page reloads or redirects itself on a timer.', fix: 'Remove the timed <meta http-equiv="refresh"> and use a server-side redirect.' },
  'scrollable-region-focusable': {
    plain: 'A scrolling box cannot be reached with the keyboard, so keyboard users cannot scroll its content.',
    fix: 'Add tabindex="0" (and an aria-label) to the scrollable container, or make sure it contains a focusable element.',
  },
  'link-in-text-block': {
    plain: 'A link inside a paragraph is distinguished from surrounding text only by colour, which people with colour-blindness cannot see.',
    fix: 'Underline links in body text: a { text-decoration: underline; }.',
  },
  'video-caption': { plain: 'A video has no captions track.', fix: 'Add <track kind="captions" src="captions.vtt" srclang="en" label="English"> to the <video>.' },
  'autocomplete-valid': {
    plain: 'A form field has an invalid autocomplete value, so browsers and assistive tools cannot fill it automatically.',
    fix: 'Use a valid token such as autocomplete="email", "tel", "given-name" or "postal-code".',
  },
  'target-size': {
    plain: 'A tap target is smaller than 24×24 CSS pixels with too little spacing, making it hard to hit for people with tremors or on a phone.',
    fix: 'Make the clickable area at least 24×24px (padding counts), or add space around it.',
  },
  'empty-heading': { plain: 'A heading tag contains no text, so screen-reader users navigating by headings hit a blank.', fix: 'Remove the empty heading tag or put the heading text inside it.' },
  'heading-order': {
    plain: 'Heading levels skip (e.g. an H2 followed by an H4), which makes the page outline confusing for people who navigate by headings.',
    fix: 'Use heading levels in order (H1 → H2 → H3) and style them with CSS rather than picking a level for its size.',
  },
  'page-has-heading-one': { plain: 'The page has no main (H1) heading.', fix: 'Mark the page\'s main title as <h1>.' },
  'landmark-one-main': { plain: 'The page has no main landmark, so screen-reader users cannot jump straight to the content.', fix: 'Wrap the primary content in <main>…</main>.' },
  'region': {
    plain: 'Some content sits outside any landmark (header, nav, main, footer), so screen-reader users who move by landmarks can miss it.',
    fix: 'Place all content inside <header>, <nav>, <main> or <footer> (or an element with an equivalent role).',
  },
  'bypass': {
    plain: 'There is no way to skip the repeated navigation, so keyboard users must tab through every menu item on every page.',
    fix: 'Add a skip link as the first focusable element: <a class="skip" href="#main">Skip to content</a> and <main id="main">.',
  },
  'landmark-unique': { plain: 'Two landmarks of the same type have the same name, so they cannot be told apart.', fix: 'Give each one a distinct aria-label (e.g. "Main menu", "Footer menu").' },
  'landmark-no-duplicate-banner': { plain: 'The page has more than one top-level header (banner).', fix: 'Keep a single top-level <header>; nested headers inside <article>/<section> are fine.' },
  'landmark-no-duplicate-contentinfo': { plain: 'The page has more than one top-level footer.', fix: 'Keep a single top-level <footer>.' },
  'landmark-complementary-is-top-level': { plain: 'A sidebar (aside) landmark is nested inside another landmark.', fix: 'Move the <aside> so it is not inside <main> or another landmark, or remove its role.' },
  'image-redundant-alt': { plain: 'Image alt text repeats the text next to it, so screen readers announce it twice.', fix: 'Use alt="" when the adjacent text already says the same thing.' },
  'tabindex': { plain: 'An element uses a positive tabindex, which overrides the natural keyboard order and usually makes focus jump around unpredictably.', fix: 'Use tabindex="0" or remove it, and order the HTML source the way it should be read.' },
  'empty-table-header': { plain: 'A table header cell is empty.', fix: 'Put text in the header cell or use <td> if it is not a header.' },
  'frame-focusable-content': { plain: 'An embedded frame with focusable content has tabindex="-1", so keyboard users cannot reach it.', fix: 'Remove tabindex="-1" from the <iframe>.' },
};

export const CUSTOM = {
  'focus-not-visible': {
    plain: 'When a keyboard user tabs onto these elements nothing visibly changes, so they cannot see where they are on the page.',
    fix: 'Do not remove the browser outline. Add a clear focus style, e.g. a:focus-visible, button:focus-visible, input:focus-visible { outline: 3px solid #1a5fb4; outline-offset: 2px; }.',
    wcag: ['2.4.7'], impact: 'serious', level: 'AA',
  },
  'no-skip-link': {
    plain: 'The first thing the Tab key reaches is not a "skip to content" link, so keyboard users must tab through the whole header and menu on every page.',
    fix: 'Add <a class="skip-link" href="#main">Skip to main content</a> as the first element in <body>, visible on focus, and id="main" on <main>.',
    wcag: ['2.4.1'], impact: 'moderate', level: 'A',
  },
  'reflow-horizontal-scroll': {
    plain: 'At a 320px-wide screen (a small phone, or a desktop zoomed to 400%) the page scrolls sideways, so people who zoom must scroll in two directions to read each line.',
    fix: 'Find the over-wide element listed below and give it max-width: 100% (images, iframes, tables: max-width:100%; height:auto; or wrap tables in a scroll container).',
    wcag: ['1.4.10'], impact: 'serious', level: 'AA',
  },
  'keyboard-trap': {
    plain: 'Pressing Tab repeatedly keeps cycling inside a small group of elements and never reaches the rest of the page.',
    fix: 'Make sure any widget that captures focus (menus, pop-ups, chat widgets) releases it on Tab/Escape.',
    wcag: ['2.1.2'], impact: 'critical', level: 'A',
  },
};
