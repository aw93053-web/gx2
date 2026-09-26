/* Shared launcher for the QA scripts. Serve the repo root first, e.g.
     npx http-server -p 8123 -c-1 .
   Environment: QA_URL (default http://localhost:8123/race.html),
                CHROMIUM (optional executable path). */
const { chromium } = require('playwright');
const URL = process.env.QA_URL || 'http://localhost:8123/race.html';
async function launch(w, h) {
  const opts = { args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] };
  if (process.env.CHROMIUM) opts.executablePath = process.env.CHROMIUM;
  const browser = await chromium.launch(opts);
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(URL);
  return { browser, page, errors };
}
/* Start the attract demo on a fixed seed with the title overlay removed, so
   frames show the game only. */
async function demoOn(page, seed) {
  await page.waitForFunction(() => { try { return window.DriveDebug._state().demo; } catch (e) { return false; } }, null, { timeout: 30000 });
  await page.evaluate(s => {
    window.ZS_stopDemoTimers && window.ZS_stopDemoTimers();
    if (s) { window.DriveMode.exit(); window.DriveMode.start(s >>> 0, { demo: true }); }
  }, seed || 0);
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    for (const id of ['scr-title', 'title-veil', 'gx-corner', 'fps-counter', 'zs-db']) {
      const e = document.getElementById(id); if (e) e.remove();
    }
  });
}
module.exports = { launch, demoOn };
