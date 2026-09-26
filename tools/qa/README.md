# QA harness

Headless checks for the attract-mode camera and the track generator
(see `docs/QUALITY_PLAN.md`). They need Playwright and a local server:

```sh
npx http-server -p 8123 -c-1 .     # from the repo root
node tools/qa/lint-shots.js        # every demo shot sampled at 60 Hz: ranges, NaNs, jumps
node tools/qa/audit.js 60          # generation metrics over 60 seeds
node tools/qa/contact-sheet.js out 0.5 2415047377   # all 146 shots as image sheets
```

Set `CHROMIUM=/path/to/chrome` if Playwright's bundled browser is not
installed, and `QA_URL` if the server is elsewhere.

The engine hooks they use are `DriveMode.demoPin(idx,p)`,
`DriveMode.lintShots()` and `DriveMode.auditTrack(seed)`.
