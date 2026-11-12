// The single source of every listing's words, prices and files.
// tools/build-listings.mjs turns this into listings.csv + LISTINGS.md and checks Etsy's limits;
// tools/build-images.mjs reads it for the listing images.

export const CATEGORY = 'Toys & Games > Games & Puzzles > Puzzles > Word & Number Puzzles';
export const CATEGORY_ID = 12626;
export const CATEGORY_FALLBACK = 'Paper & Party Supplies > Paper > Stationery > Design & Templates > Worksheets (id 12471)';

export const LICENCE =
  'PERSONAL-USE LICENSE: Print as many copies as you like for yourself, your family, and non-commercial use in your own classroom, church group or care community. Please do not resell, share, upload or redistribute the file or the puzzles, in print or digital form.';

const FOOTER = (files) => `
━━━━━━━━━━━━━━━━━━
★ HOW IT WORKS ★
This is a DIGITAL DOWNLOAD. Nothing will be shipped.
1. Buy — Etsy confirms payment.
2. Download — go to You › Purchases and reviews on Etsy (or open the link in your Etsy receipt email) and tap Download Files.
3. Print — on any home printer, or at a local print/copy shop, as many times as you need.

★ FILES ★
${files.map((f) => `• ${f.name} — ${f.pages} pages, ${f.kb} KB`).join('\n')}
US Letter (8.5" × 11"). Printing on A4? Choose "Fit to page" / "Scale to fit" in your print dialog.

★ GOOD TO KNOW ★
• Colors on screen may vary slightly from your printer.
• Puzzles are created and checked by our own puzzle software, and laid out by us. The listing photos show the real pages you will receive.
• Because this is an instant download, returns are not accepted — but if a file will not open or print, message us and we will fix it or refund you.

★ ${LICENCE}

© 2026. Thank you for visiting our shop!`;

export const PRODUCTS = [
  {
    slug: 'large-print-christmas-sudoku',
    name: 'Large Print Christmas Sudoku',
    short: 'Christmas Sudoku',
    theme: 'holiday',
    count: '50 puzzles',
    price: 3.99,
    title: 'Large Print Christmas Sudoku Printable, 50 Puzzles Easy to Expert, Holiday Puzzle Book for Seniors, Instant Download PDF with Solutions',
    tags: ['large print sudoku', 'christmas sudoku', 'holiday puzzles', 'sudoku printable', 'gift for seniors', 'christmas printable', 'puzzle book pdf', 'sudoku for adults', 'stocking stuffer', 'brain games', 'christmas activity', 'grandparent gift', 'printable puzzles'],
    lead: [
      '🎄 A cozy Christmas puzzle book you can print tonight! 50 large print sudoku puzzles — one big, bold grid per page — for relaxing holiday afternoons, by the fire or after dinner.',
      'Perfect as a little extra gift for grandparents, parents and puzzle lovers: print it, staple or hole-punch it, and tuck it in with a card and a nice pencil.',
    ],
    bullets: [
      '50 classic 9×9 sudoku puzzles, ONE per page, in large print',
      'Ordered from Easy to Expert: 21 Easy, 21 Medium, 8 Expert',
      'Every puzzle has exactly ONE solution — each one was proved by a solver, so there are no broken puzzles',
      'Festive cover page + how-to-play page',
      'Full solutions at the back (6 per page)',
      '62 pages, US Letter 8.5" × 11"',
    ],
    images: ['01-hero', '02-inside', '03-big-print', '04-what-you-get', '05-solutions', '06-instant-download'],
  },
  {
    slug: 'large-print-sudoku-100',
    name: 'Large Print Sudoku: 100 Puzzles',
    short: '100 Sudoku Puzzles',
    theme: 'classic',
    count: '100 puzzles',
    price: 4.49,
    title: '100 Large Print Sudoku Puzzles Printable, Easy to Expert, One Per Page, Sudoku Book for Seniors and Adults, Instant Download PDF',
    tags: ['large print sudoku', 'sudoku printable', 'sudoku puzzles', 'sudoku book', 'sudoku for seniors', 'puzzle book pdf', 'easy to hard sudoku', 'brain games', 'gift for seniors', 'printable puzzles', 'sudoku for adults', 'senior activities', 'logic puzzles'],
    lead: [
      '100 large print sudoku puzzles, one big, easy-to-read grid per page — print the whole book or just the pages you want, as often as you like.',
      'Great for anyone who finds newspaper sudoku too small: large digits, thick box lines and plenty of room to pencil in your notes.',
    ],
    bullets: [
      '100 classic 9×9 sudoku puzzles, ONE per page, in large print',
      'Easy to Expert, in order of difficulty: 42 Easy, 42 Medium, 16 Expert',
      'Every puzzle has exactly ONE solution — proved by a solver, never guessed',
      'Cover page + how-to-play page',
      'Full solutions at the back (6 per page)',
      '120 pages, US Letter 8.5" × 11"',
    ],
    images: ['01-hero', '02-inside', '03-big-print', '04-what-you-get', '05-solutions', '06-instant-download'],
  },
  {
    slug: 'easy-sudoku-for-beginners',
    name: 'Easy Sudoku for Beginners',
    short: 'Easy Sudoku',
    theme: 'classic',
    count: '60 easy puzzles',
    price: 3.49,
    title: 'Easy Sudoku for Beginners Printable, 60 Large Print Puzzles, One Per Page, Easy Sudoku for Seniors and Kids, Instant Download PDF',
    tags: ['easy sudoku', 'beginner sudoku', 'large print sudoku', 'sudoku printable', 'sudoku for seniors', 'sudoku for kids', 'easy puzzles', 'printable puzzles', 'puzzle book pdf', 'brain games', 'gift for seniors', 'senior activities', 'homeschool puzzles'],
    lead: [
      'New to sudoku, or just want a gentle, relaxing puzzle? 60 EASY large print sudoku puzzles, one big grid per page, with a simple how-to-play page to get started.',
      'A lovely first puzzle book for beginners, older kids learning logic, and seniors who want a calm daily brain workout.',
    ],
    bullets: [
      '60 Easy 9×9 sudoku puzzles, ONE per page, in large print',
      'Every puzzle was measured as Easy by solving it, not by guessing',
      'Every puzzle has exactly ONE solution — proved by a solver',
      'How-to-play page for first-timers',
      'Full solutions at the back (6 per page)',
      '73 pages, US Letter 8.5" × 11"',
    ],
    images: ['01-hero', '02-inside', '03-big-print', '04-what-you-get', '05-solutions', '06-instant-download'],
  },
  {
    slug: 'expert-sudoku',
    name: 'Expert Sudoku',
    short: 'Expert Sudoku',
    theme: 'classic',
    count: '60 expert puzzles',
    price: 3.49,
    title: 'Expert Sudoku Printable, 60 Hard Sudoku Puzzles, Large Print One Per Page, Challenging Sudoku Book for Adults, Instant Download PDF',
    tags: ['expert sudoku', 'hard sudoku', 'difficult sudoku', 'sudoku printable', 'large print sudoku', 'sudoku for adults', 'sudoku book', 'challenging puzzles', 'puzzle book pdf', 'logic puzzles', 'brain games', 'gift for dad', 'printable puzzles'],
    lead: [
      'Finished every puzzle in the newspaper? 60 EXPERT sudoku puzzles for experienced solvers — printed large, one per page, so you can focus on the logic, not squinting.',
      'Every puzzle has exactly one solution, so you can always solve it with logic — no guessing required.',
    ],
    bullets: [
      '60 Expert 9×9 sudoku puzzles, ONE per page, in large print',
      'Every puzzle measured as Expert by actually solving it',
      'Every puzzle has exactly ONE solution — proved by a solver',
      'Full solutions at the back (6 per page)',
      '73 pages, US Letter 8.5" × 11"',
    ],
    images: ['01-hero', '02-inside', '03-big-print', '04-what-you-get', '05-solutions', '06-instant-download'],
  },
  {
    slug: 'large-print-christmas-word-search',
    name: 'Large Print Christmas Word Search',
    short: 'Christmas Word Search',
    theme: 'holiday',
    count: '40 puzzles',
    price: 3.99,
    title: 'Large Print Christmas Word Search Printable, 40 Holiday Puzzles, Word Search for Seniors and Adults, Instant Download PDF with Answers',
    tags: ['xmas word search', 'large print puzzles', 'word search seniors', 'word find printable', 'holiday word search', 'christmas printable', 'puzzle book pdf', 'gift for seniors', 'christmas activity', 'word puzzles', 'senior activities', 'stocking stuffer', 'christmas games'],
    lead: [
      '🎄 40 festive word search puzzles in LARGE PRINT — big, bold letters on a 15 × 15 grid, one puzzle per page, with a tick-box word list underneath.',
      'Twelve holiday themes, from Christmas Eve, Holiday Baking and Deck the Halls to Winter Birds, Caroling and Happy New Year. A thoughtful printable gift for seniors, and a hit for holiday gatherings and activity groups.',
    ],
    bullets: [
      '40 Christmas & winter word searches, ONE per page, large print',
      '14 words per puzzle, 560 words in all, across 12 holiday themes',
      'Words run forwards, backwards, up, down and diagonally',
      'Every grid checked by software: each listed word appears exactly once — no missing words, no double answers',
      'Answer key at the back with the hidden words highlighted (4 per page)',
      '53 pages, US Letter 8.5" × 11"',
    ],
    images: ['01-hero', '02-inside', '03-big-print', '04-what-you-get', '05-solutions', '06-instant-download'],
  },
  {
    slug: 'christmas-activity-pack',
    name: 'Christmas Activity Pack',
    short: 'Christmas Activity Pack',
    theme: 'kids',
    count: '32 activities',
    price: 3.49,
    title: 'Christmas Activity Pack for Kids Printable, Word Search, Mazes and Easy Sudoku, 32 Holiday Puzzles, Instant Download PDF with Answers',
    tags: ['christmas activities', 'kids christmas', 'christmas printable', 'christmas mazes', 'kids word search', 'activity pages', 'holiday activities', 'christmas games', 'classroom party', 'stocking stuffer', 'travel activities', 'kids puzzles', 'winter break fun'],
    lead: [
      '🎅 32 printable Christmas puzzles to keep kids happily busy — on winter break, at the kids\' table, on long car rides and during the countdown to Christmas.',
      'Print one page or the whole pack, as many times as you need for your family. Great for classroom holiday parties too (your own classroom, non-commercial).',
    ],
    bullets: [
      '12 Christmas word searches (big letters, 8 words each; words run only across, down and diagonally down — kid friendly)',
      '12 holiday mazes, from small and easy to bigger and twistier — every maze has exactly one way through',
      '8 easy sudoku puzzles with big grids — each has exactly one solution',
      'Answers for everything at the back',
      '43 pages, US Letter 8.5" × 11"',
      'Suggested ages: about 6–12 (younger children with a little help)',
    ],
    images: ['01-hero', '02-inside', '03-big-print', '04-what-you-get', '05-solutions', '06-instant-download'],
  },
  {
    slug: 'large-print-mazes-for-adults',
    name: 'Large Print Mazes for Adults',
    short: 'Mazes for Adults',
    theme: 'classic',
    count: '40 mazes',
    price: 3.49,
    title: 'Large Print Mazes for Adults Printable, 40 Relaxing Mazes Easy to Challenging, Maze Book for Seniors, Instant Download PDF with Solutions',
    tags: ['mazes for adults', 'maze printable', 'large print mazes', 'maze book', 'mazes for seniors', 'puzzle book pdf', 'brain games', 'relaxing puzzles', 'printable puzzles', 'senior activities', 'gift for seniors', 'maze puzzles', 'activity book'],
    lead: [
      '40 relaxing mazes for grown-ups, printed large with thick, dark lines — one maze per page, starting gently and growing bigger and more winding as you go.',
      'Every maze is a "perfect" maze: no loops, exactly one route from START to FINISH, walked and checked by software.',
    ],
    bullets: [
      '40 mazes, ONE per page, large print with bold lines',
      'Grows from 10 × 13 to 29 × 36 cells: gentle to challenging',
      'Exactly one way through every maze',
      'Solutions at the back, route drawn in red (4 per page)',
      '53 pages, US Letter 8.5" × 11"',
    ],
    images: ['01-hero', '02-inside', '03-big-print', '04-what-you-get', '05-solutions', '06-instant-download'],
  },
  {
    slug: 'large-print-puzzle-bundle',
    name: 'Large Print Puzzle Bundle',
    short: 'Puzzle Bundle',
    theme: 'holiday',
    count: '310 puzzles',
    price: 9.99,
    bundle: ['large-print-christmas-sudoku', 'large-print-sudoku-100', 'easy-sudoku-for-beginners', 'expert-sudoku', 'large-print-christmas-word-search'],
    title: 'Large Print Puzzle Bundle, 310 Printable Puzzles, Sudoku Easy to Expert and Christmas Word Search, Gift for Seniors, Instant Download PDF',
    tags: ['puzzle bundle', 'large print sudoku', 'sudoku printable', 'xmas word search', 'gift for seniors', 'puzzle book pdf', 'sudoku bundle', 'brain games', 'christmas printable', 'sudoku for seniors', 'printable puzzles', 'senior activities', 'holiday puzzles'],
    lead: [
      '🎁 Our five large print puzzle books in one download — 310 puzzles, all one per page — for less than half the price of buying them separately.',
      'Enough puzzles for the whole winter. A generous printable gift for grandparents, parents and puzzle-loving friends, and a great resource for activity directors (non-commercial use in your own care community).',
    ],
    bullets: [
      'Large Print Christmas Sudoku — 50 puzzles, Easy to Expert',
      'Large Print Sudoku — 100 puzzles, Easy to Expert',
      'Easy Sudoku for Beginners — 60 Easy puzzles',
      'Expert Sudoku — 60 Expert puzzles',
      'Large Print Christmas Word Search — 40 puzzles',
      'No puzzle repeats across the five books; every sudoku has exactly one solution; every book has its solutions at the back',
    ],
    images: ['01-hero', '02-inside', '04-what-you-get', '03-big-print', '06-instant-download'],
  },
];

export function description(p, files) {
  return `${p.lead.join('\n\n')}

★ WHAT YOU GET ★
${p.bullets.map((b) => `• ${b}`).join('\n')}
${FOOTER(files)}`;
}
