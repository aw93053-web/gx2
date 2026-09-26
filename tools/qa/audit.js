/* Generation audit over N seeds via DriveMode.auditTrack. Usage:
     node audit.js [n=60] [out.json]
   Prints the mean/min/max of every metric, the feature emission histogram
   by lap decile, and sample biome|palette pairs. */
const fs = require('fs');
const { launch } = require('./common');
(async () => {
  const n = +(process.argv[2] || 60), out = process.argv[3] || 'audit.json';
  const { browser, page, errors } = await launch(320, 180);
  await page.waitForFunction(() => !!(window.DriveMode && window.DriveMode.auditTrack), null, { timeout: 30000 });
  await page.waitForTimeout(800);
  const res = await page.evaluate(n => {
    window.ZS_stopDemoTimers && window.ZS_stopDemoTimers();
    try { window.DriveMode.exit(); } catch (e) {}
    const r = [];
    for (let i = 0; i < n; i++) r.push(window.DriveMode.auditTrack((Math.imul(i + 1, 2654435761) >>> 0) || 1));
    return r;
  }, n);
  fs.writeFileSync(out, JSON.stringify(res, null, 1));
  const keys = Object.keys(res[0]).filter(k => typeof res[0][k] === 'number' && k !== 'seed');
  for (const k of keys) {
    const v = res.map(r => r[k]).filter(x => typeof x === 'number');
    console.log(k.padEnd(16), 'mean', (v.reduce((a, b) => a + b, 0) / v.length).toFixed(2), 'min', Math.min(...v), 'max', Math.max(...v));
  }
  const bins = new Array(10).fill(0);
  for (const r of res) for (const f of (r.featLog || [])) bins[Math.min(9, Math.floor(+f.split('@')[1] * 10))]++;
  console.log('feature emissions by lap decile:', bins.join(' '));
  const pairs = [...new Set(res.map(r => r.biome + '|' + r.themeName))];
  console.log('biome|palette:', pairs.slice(0, 16).join(', '));
  const bad = res.filter(r => r.error);
  if (bad.length) console.log('build errors:', bad.slice(0, 5));
  await browser.close();
  process.exit(bad.length || errors.length ? 1 : 0);
})();
