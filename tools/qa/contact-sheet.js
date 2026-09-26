/* Contact sheet of every attract-mode camera shot, frozen at one progress
   point with DriveMode.demoPin. Usage:
     node contact-sheet.js <out-prefix> [p=0.5] [seed]
   Writes <out-prefix>_0.png, _1.png ... (50 shots per sheet). */
const { launch, demoOn } = require('./common');
(async () => {
  const out = process.argv[2] || 'sheet', P = +(process.argv[3] || 0.5), seed = +(process.argv[4] || 0);
  const { browser, page, errors } = await launch(480, 270);
  await demoOn(page, seed);
  const n = await page.evaluate(() => window.DriveMode.demoShots().shots);
  const shots = [];
  for (let i = 0; i < n; i++) {
    await page.evaluate(([i, p]) => window.DriveMode.demoPin(i, p), [i, P]);
    await page.waitForTimeout(350);
    shots.push((await page.screenshot({ type: 'jpeg', quality: 70 })).toString('base64'));
  }
  const cols = 10, tw = 240, th = 135;
  const comp = await browser.newPage({ viewport: { width: cols * tw, height: 5 * th } });
  await comp.setContent('<style>body{margin:0}</style><canvas id=c></canvas>');
  for (let r0 = 0; r0 * cols < n; r0 += 5) {
    const chunk = shots.slice(r0 * cols, (r0 + 5) * cols);
    await comp.setViewportSize({ width: cols * tw, height: Math.ceil(chunk.length / cols) * th });
    await comp.evaluate(async ([chunk, cols, tw, th, base]) => {
      const c = document.getElementById('c'); c.width = cols * tw; c.height = Math.ceil(chunk.length / cols) * th;
      const g = c.getContext('2d');
      for (let i = 0; i < chunk.length; i++) {
        const im = new Image(); im.src = 'data:image/jpeg;base64,' + chunk[i]; await im.decode();
        const x = (i % cols) * tw, y = Math.floor(i / cols) * th; g.drawImage(im, x, y, tw, th);
        g.fillStyle = '#000'; g.fillRect(x, y, 34, 16); g.fillStyle = '#ff0'; g.font = 'bold 13px monospace';
        g.fillText(String(base + i), x + 3, y + 13);
      }
    }, [chunk, cols, tw, th, r0 * cols]);
    await comp.screenshot({ path: `${out}_${r0 / 5}.png` });
  }
  if (errors.length) console.log('page errors:\n' + errors.join('\n'));
  await browser.close();
  process.exit(errors.length ? 1 : 0);
})();
