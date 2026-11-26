const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  await p.goto('file://' + __dirname + '/sample-plan.html');
  await p.pdf({ path: __dirname + '/sample-plan.pdf', format: 'Letter', margin: { top: '0.6in', bottom: '0.6in', left: '0.6in', right: '0.6in' } });
  await b.close();
})();
