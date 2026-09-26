/* Runs DriveMode.lintShots() and fails on any non-finite camera value.
   Usage: node lint-shots.js */
const { launch } = require('./common');
(async () => {
  const { browser, page, errors } = await launch(320, 180);
  await page.waitForFunction(() => !!(window.DriveMode && window.DriveMode.lintShots), null, { timeout: 30000 });
  const r = await page.evaluate(() => window.DriveMode.lintShots());
  console.log(JSON.stringify(r, null, 1));
  await browser.close();
  process.exit(r.nonFinite.length || errors.length ? 1 : 0);
})();
