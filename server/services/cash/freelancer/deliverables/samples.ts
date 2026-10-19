/**
 * One realistic customer task per category, with the spec a worker would
 * submit for it.
 *
 * They serve twice. `capabilities.ts` renders and verifies each one, and a
 * category is available to the job screen only if its sample passes, in this
 * process, now. And the deliverable bin shows the worker the sample for its
 * kind, because a correct example is the clearest statement of the contract.
 */
import type { DeliverableKind, DeliverableSpec } from './spec.ts';

export interface Sample {
  kind: DeliverableKind;
  brief: string;
  spec: DeliverableSpec;
}

const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const SAMPLES: Record<DeliverableKind, Sample> = {
  SPREADSHEET: {
    kind: 'SPREADSHEET',
    brief:
      'I run a small bakery. I need an Excel 12-month cash-flow budget: monthly sales with 3% growth from $18,000, ' +
      'costs (ingredients 32% of sales, rent $3,200, wages $6,500, utilities $650), monthly net and a running balance from ' +
      '$10,000, plus a summary sheet with totals and the lowest balance month. Formulas please, not hard-coded numbers.',
    spec: {
      kind: 'SPREADSHEET',
      filename: 'Bakery 12-month cash flow',
      sheets: [
        {
          name: 'Assumptions',
          columnWidths: [30, 14],
          rows: [
            [{ v: 'Assumption', bold: true, fill: '#DCE4F2' }, { v: 'Value', bold: true, fill: '#DCE4F2' }],
            ['Starting monthly sales', { v: 18000, fmt: 'currency' }],
            ['Monthly sales growth', { v: 0.03, fmt: 'percent' }],
            ['Ingredients (% of sales)', { v: 0.32, fmt: 'percent' }],
            ['Rent', { v: 3200, fmt: 'currency' }],
            ['Wages', { v: 6500, fmt: 'currency' }],
            ['Utilities', { v: 650, fmt: 'currency' }],
            ['Opening cash balance', { v: 10000, fmt: 'currency' }],
          ],
        },
        {
          name: 'Cash Flow',
          freezeRows: 1,
          columnWidths: [10, 14, 14, 12, 12, 12, 14, 14],
          rows: [
            ['Month', 'Sales', 'Ingredients', 'Rent', 'Wages', 'Utilities', 'Net', 'Balance'].map((v) => ({ v, bold: true, fill: '#DCE4F2' })),
            ...months.map((m, i) => {
              const r = i + 2;
              return [
                m,
                { f: i === 0 ? 'Assumptions!B2' : `B${r - 1}*(1+Assumptions!$B$3)`, fmt: 'currency' as const },
                { f: `B${r}*Assumptions!$B$4`, fmt: 'currency' as const },
                { f: 'Assumptions!$B$5', fmt: 'currency' as const },
                { f: 'Assumptions!$B$6', fmt: 'currency' as const },
                { f: 'Assumptions!$B$7', fmt: 'currency' as const },
                { f: `B${r}-SUM(C${r}:F${r})`, fmt: 'currency' as const },
                { f: i === 0 ? `Assumptions!$B$8+G${r}` : `H${r - 1}+G${r}`, fmt: 'currency' as const },
              ];
            }),
            [{ v: 'Total', bold: true }, ...['B', 'C', 'D', 'E', 'F', 'G'].map((c) => ({ f: `SUM(${c}2:${c}13)`, fmt: 'currency' as const, bold: true })), null],
          ],
        },
        {
          name: 'Summary',
          columnWidths: [28, 16],
          rows: [
            [{ v: 'Measure', bold: true, fill: '#DCE4F2' }, { v: 'Value', bold: true, fill: '#DCE4F2' }],
            ['Annual sales', { f: "'Cash Flow'!B14", fmt: 'currency' }],
            ['Annual net cash flow', { f: "'Cash Flow'!G14", fmt: 'currency' }],
            ['Closing balance', { f: "'Cash Flow'!H13", fmt: 'currency' }],
            ['Lowest month-end balance', { f: "MIN('Cash Flow'!H2:H13)", fmt: 'currency' }],
            ['Net margin', { f: 'B3/B2', fmt: 'percent' }],
            ['Months with negative net', { f: "COUNTIF('Cash Flow'!G2:G13,\"<0\")", fmt: 'integer' }],
          ],
        },
      ],
    },
  },
  DOCUMENT: {
    kind: 'DOCUMENT',
    brief:
      'Write a professional 2-page service proposal for a mobile dog-grooming business pitching a contract to a residential ' +
      'property manager: overview, services and pricing table, schedule, why us, next steps. Word and PDF.',
    spec: {
      kind: 'DOCUMENT',
      filename: 'Proposal - Mobile Grooming for Maple Court Residences',
      title: 'Service Proposal: On-site Pet Grooming',
      subtitle: 'Prepared for Maple Court Residences property management',
      formats: ['docx', 'pdf'],
      blocks: [
        { type: 'heading', level: 1, text: 'Overview' },
        { type: 'paragraph', text: 'We propose a **monthly on-site grooming day** for residents of Maple Court, delivered from a self-contained grooming van parked in the visitor lot. Residents book online; the property pays nothing and receives a resident amenity it can advertise.' },
        { type: 'heading', level: 1, text: 'Services and pricing' },
        { type: 'table', table: { header: ['Service', 'Duration', 'Resident price'], rows: [['Bath and brush (small dog)', '45 min', '$55'], ['Bath and brush (large dog)', '60 min', '$75'], ['Full groom with cut', '90 min', '$95'], ['Nail trim (walk-in)', '10 min', '$15']] } },
        { type: 'heading', level: 1, text: 'Schedule' },
        { type: 'bullets', items: ['First Saturday of each month, 9:00 to 17:00', 'Up to 9 appointments per day', 'Online booking opens two weeks before each visit'] },
        { type: 'heading', level: 1, text: 'Why us' },
        { type: 'bullets', items: ['Fully insured, with certificates provided before the first visit', 'Self-contained water and power: no building utilities used', 'Quiet, low-stress handling in a climate-controlled van'] },
        { type: 'heading', level: 1, text: 'Next steps' },
        { type: 'numbered', items: ['Confirm the parking location and first date', 'We send a resident flyer and booking link', 'First grooming day'] },
      ],
    },
  },
  PRESENTATION: {
    kind: 'PRESENTATION',
    brief: 'Create a 6-slide investor pitch deck in PowerPoint for a subscription meal-prep startup, with a revenue chart and a use-of-funds table.',
    spec: {
      kind: 'PRESENTATION',
      filename: 'FreshBox pitch deck',
      title: 'FreshBox',
      accent: '#2E7D5B',
      slides: [
        { layout: 'title', title: 'FreshBox', subtitle: 'Weekly meal prep for busy families — Seed round 2026' },
        { layout: 'bullets', title: 'The problem', bullets: ['Two-income households spend 6+ hours a week planning and cooking', 'Takeout costs three times as much as home cooking', 'Existing kits still require 45 minutes of preparation per meal'] },
        { layout: 'two-column', title: 'Our solution', left: ['Ready-to-heat meals, delivered Sunday', 'Menus planned around the family'], right: ['$9.50 per serving', 'Cancel any week'] },
        { layout: 'chart', title: 'Revenue plan', chart: { type: 'bar', title: 'Annual revenue (USD thousands)', categories: ['2026', '2027', '2028'], series: [{ name: 'Revenue', values: [420, 1150, 2600] }] } },
        { layout: 'table', title: 'Use of funds ($750,000)', table: { header: ['Area', 'Amount', 'Share'], rows: [['Kitchen equipment', '$260,000', '35%'], ['Marketing', '$225,000', '30%'], ['Team', '$190,000', '25%'], ['Working capital', '$75,000', '10%']] } },
        { layout: 'section', title: 'Thank you', subtitle: 'Let’s talk about the next chapter' },
      ],
    },
  },
  DATASET: {
    kind: 'DATASET',
    brief: 'Clean this messy list of supplier records (mixed date formats, duplicates, inconsistent capitalisation) into a tidy table, deliver as CSV and Excel.',
    spec: {
      kind: 'DATASET',
      filename: 'Suppliers cleaned',
      formats: ['csv', 'xlsx', 'json'],
      columns: [
        { name: 'supplier', type: 'string' },
        { name: 'country', type: 'string' },
        { name: 'first_order', type: 'date' },
        { name: 'orders', type: 'integer' },
        { name: 'annual_spend_usd', type: 'number' },
        { name: 'active', type: 'boolean' },
      ],
      rows: [
        ['Acme Packaging Ltd', 'United Kingdom', '2021-03-14', 42, 18250.5, true],
        ['Bright Foods, Inc.', 'United States', '2019-11-02', 118, 64400, true],
        ['Costa "Fresh" Produce', 'Spain', '2022-06-30', 17, 7120.25, false],
        ['Delta Logistics', 'Germany', '2020-01-09', 63, 29900, true],
        ['Evergreen Supplies', 'Canada', null, 5, 1800, false],
      ],
    },
  },
  WEBSITE: {
    kind: 'WEBSITE',
    brief: 'Build a responsive one-page landing page for a local yoga studio: hero, classes, pricing, contact section. HTML/CSS/JS files I can upload.',
    spec: {
      kind: 'WEBSITE',
      filename: 'Lotus Yoga landing page',
      files: [
        {
          path: 'index.html',
          content:
            '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>Lotus Yoga Studio</title>\n<link rel="stylesheet" href="css/style.css">\n</head>\n<body>\n<header class="hero">\n<h1>Lotus Yoga Studio</h1>\n<p>Calm, strength and community in the heart of town.</p>\n<a class="button" href="#pricing">See pricing</a>\n</header>\n<main>\n<section id="classes">\n<h2>Classes</h2>\n<ul class="cards">\n<li><h3>Vinyasa Flow</h3><p>Mon, Wed 18:00</p></li>\n<li><h3>Gentle Yoga</h3><p>Tue, Thu 10:00</p></li>\n<li><h3>Power Yoga</h3><p>Sat 09:00</p></li>\n</ul>\n</section>\n<section id="pricing">\n<h2>Pricing</h2>\n<table><tr><th>Drop-in</th><td>$18</td></tr><tr><th>10-class pass</th><td>$150</td></tr><tr><th>Monthly unlimited</th><td>$110</td></tr></table>\n</section>\n<section id="contact">\n<h2>Contact</h2>\n<form id="contact-form"><label>Name <input name="name" required></label><label>Message <textarea name="message" required></textarea></label><button type="submit">Send</button><p id="thanks" hidden>Thank you, we will be in touch.</p></form>\n</section>\n</main>\n<footer><p>&copy; 2026 Lotus Yoga Studio</p></footer>\n<script src="js/main.js"></script>\n</body>\n</html>\n',
        },
        {
          path: 'css/style.css',
          content:
            ':root { --accent: #6b4fa0; }\n* { box-sizing: border-box; }\nbody { margin: 0; font-family: system-ui, sans-serif; color: #222; line-height: 1.5; }\n.hero { background: linear-gradient(135deg, #efe8f8, #ffffff); padding: 4rem 1.5rem; text-align: center; }\n.hero h1 { font-size: clamp(2rem, 6vw, 3.5rem); margin: 0 0 .5rem; }\n.button { display: inline-block; background: var(--accent); color: #fff; padding: .75rem 1.5rem; border-radius: 999px; text-decoration: none; }\nsection { max-width: 960px; margin: 0 auto; padding: 2.5rem 1.5rem; }\n.cards { list-style: none; padding: 0; display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }\n.cards li { border: 1px solid #ddd; border-radius: 12px; padding: 1rem; }\ntable { border-collapse: collapse; width: 100%; }\nth, td { border-bottom: 1px solid #eee; padding: .6rem; text-align: left; }\nform { display: grid; gap: .75rem; max-width: 480px; }\ninput, textarea { width: 100%; padding: .5rem; }\nfooter { text-align: center; padding: 2rem; color: #666; }\n',
        },
        {
          path: 'js/main.js',
          content:
            "document.getElementById('contact-form').addEventListener('submit', (event) => {\n  event.preventDefault();\n  event.target.querySelector('button').disabled = true;\n  document.getElementById('thanks').hidden = false;\n});\n",
        },
      ],
    },
  },
  CODE: {
    kind: 'CODE',
    brief: 'I need a Python script that reads a CSV of orders (date, customer, amount) and writes a monthly sales summary CSV, with a simple test.',
    spec: {
      kind: 'CODE',
      filename: 'monthly-sales-summary',
      language: 'python',
      entry: 'summarize.py',
      files: [
        {
          path: 'summarize.py',
          content:
            '"""Summarise an orders CSV (date, customer, amount) into monthly totals."""\nimport csv\nimport sys\nfrom collections import defaultdict\n\n\ndef summarize(rows):\n    totals = defaultdict(lambda: {"orders": 0, "revenue": 0.0, "customers": set()})\n    for row in rows:\n        month = row["date"][:7]\n        totals[month]["orders"] += 1\n        totals[month]["revenue"] += float(row["amount"])\n        totals[month]["customers"].add(row["customer"].strip().lower())\n    return [\n        {"month": m, "orders": t["orders"], "revenue": round(t["revenue"], 2), "unique_customers": len(t["customers"])}\n        for m, t in sorted(totals.items())\n    ]\n\n\ndef main(source, target):\n    with open(source, newline="", encoding="utf-8") as handle:\n        result = summarize(csv.DictReader(handle))\n    with open(target, "w", newline="", encoding="utf-8") as handle:\n        writer = csv.DictWriter(handle, fieldnames=["month", "orders", "revenue", "unique_customers"])\n        writer.writeheader()\n        writer.writerows(result)\n    print(f"Wrote {len(result)} month(s) to {target}")\n\n\nif __name__ == "__main__":\n    if len(sys.argv) != 3:\n        sys.exit("usage: python summarize.py orders.csv summary.csv")\n    main(sys.argv[1], sys.argv[2])\n',
        },
        {
          path: 'test_summarize.py',
          content:
            'import unittest\n\nfrom summarize import summarize\n\n\nclass SummarizeTest(unittest.TestCase):\n    def test_groups_by_month(self):\n        rows = [\n            {"date": "2026-01-05", "customer": "Ann", "amount": "10.50"},\n            {"date": "2026-01-20", "customer": "ann ", "amount": "4.50"},\n            {"date": "2026-02-01", "customer": "Bo", "amount": "7"},\n        ]\n        self.assertEqual(\n            summarize(rows),\n            [\n                {"month": "2026-01", "orders": 2, "revenue": 15.0, "unique_customers": 1},\n                {"month": "2026-02", "orders": 1, "revenue": 7.0, "unique_customers": 1},\n            ],\n        )\n\n\nif __name__ == "__main__":\n    unittest.main()\n',
        },
        {
          path: 'README.md',
          content:
            '# Monthly sales summary\n\nReads an orders CSV with the columns `date` (YYYY-MM-DD), `customer` and `amount`, and writes one row per month.\n\n## Usage\n\n    python summarize.py orders.csv summary.csv\n\nRequires Python 3.8 or newer and no other packages.\n\n## Test\n\n    python -m unittest test_summarize.py\n',
        },
      ],
    },
  },
  GRAPHIC: {
    kind: 'GRAPHIC',
    brief: 'Design a 1080x1080 social media ad graphic for a weekend 30%-off sale at a sneaker shop, editable file plus PNG.',
    spec: {
      kind: 'GRAPHIC',
      filename: 'Kicks weekend sale 1080',
      width: 1080,
      height: 1080,
      formats: ['svg', 'png', 'pdf'],
      svg:
        '<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080" viewBox="0 0 1080 1080">' +
        '<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#14213D"/><stop offset="1" stop-color="#3A0CA3"/></linearGradient></defs>' +
        '<rect width="1080" height="1080" fill="url(#bg)"/>' +
        '<circle cx="860" cy="220" r="170" fill="#FCA311"/>' +
        '<text x="860" y="205" font-family="DejaVu Sans" font-size="96" font-weight="bold" fill="#14213D" text-anchor="middle">30%</text>' +
        '<text x="860" y="285" font-family="DejaVu Sans" font-size="56" font-weight="bold" fill="#14213D" text-anchor="middle">OFF</text>' +
        '<text x="90" y="520" font-family="DejaVu Sans" font-size="120" font-weight="bold" fill="#FFFFFF">WEEKEND</text>' +
        '<text x="90" y="650" font-family="DejaVu Sans" font-size="120" font-weight="bold" fill="#FCA311">SALE</text>' +
        '<text x="90" y="740" font-family="DejaVu Sans" font-size="44" fill="#E5E5E5">Every sneaker in store, Sat and Sun only</text>' +
        '<rect x="90" y="820" width="420" height="110" rx="55" fill="#FFFFFF"/>' +
        '<text x="300" y="892" font-family="DejaVu Sans" font-size="46" font-weight="bold" fill="#3A0CA3" text-anchor="middle">SHOP NOW</text>' +
        '<text x="990" y="1020" font-family="DejaVu Sans" font-size="36" font-weight="bold" fill="#FFFFFF" text-anchor="end">KICKS &amp; CO.</text>' +
        '</svg>',
    },
  },
  MODEL_3D: {
    kind: 'MODEL_3D',
    brief: 'Model a simple product mock-up of a cylindrical candle in a box with a lid, in cm, as OBJ/STL/glTF with a rendered image.',
    spec: {
      kind: 'MODEL_3D',
      filename: 'Candle gift box',
      units: 'cm',
      formats: ['obj', 'stl', 'gltf'],
      parts: [
        { name: 'Box base', shape: 'box', size: [10, 8, 10], position: [0, 4, 0], color: '#D9C2A3' },
        { name: 'Lid', shape: 'box', size: [10.4, 1.2, 10.4], position: [13, 0.6, 0], color: '#8C5A3C' },
        { name: 'Candle', shape: 'cylinder', size: [3.5, 7], position: [0, 11.5, 0], color: '#F4EDE4' },
        { name: 'Wick', shape: 'cylinder', size: [0.15, 1], position: [0, 15.5, 0], color: '#222222' },
        { name: 'Flame', shape: 'cone', size: [0.5, 1.5], position: [0, 16.75, 0], color: '#FFB703' },
        { name: 'Ribbon knot', shape: 'sphere', size: [1.1], position: [13, 1.9, 0], color: '#B5172F' },
      ],
    },
  },
};
