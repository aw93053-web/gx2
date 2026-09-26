# ZONE STORM RACING GX — 25-Point Quality Plan

Scope: the pseudo-3D renderer's "fake" cinematic camera in attract/demo mode,
the track generator, roadside scenery placement, and biome usage.

Every point is grounded in something that was measured before any code was
changed, using the headless harness in `tools/qa/` (Chromium + Playwright):

* **Contact sheets** of all 146 attract-mode shots (`contact-sheet.js`).
* **Generation audit** over 60 seeds (`audit.js`, backed by
  `DriveMode.auditTrack(seed)`).

## Baseline evidence (before changes)

| Metric (60 seeds) | Baseline | What it means |
|---|---|---|
| Distinct tree species per 150-segment stretch, per side | **7.05** of 12 | Palm beside conifer beside baobab: the "random objects" look |
| Tree hue spread inside a stretch | **36.6°** | Trees in one stretch look like different plants |
| Buildings with no neighbour within 40 segments | **10.5 %** | Lone houses dropped in the wilderness |
| Feature emissions by lap decile | `119 100 102 101 111 89 83 47 27 99` | A lull in deciles 8–9, then a pile-up right before the finish |
| Biome/palette pairs | `jungle·INFERNO CORE`, `arctic·EMBER CIRCUIT`, `desert·DEEP SEA DRIFT` | Palette picked independently of the biome |

The contact sheets also showed:

* the eye leaving the tunnel bore, so the whole frame is wall;
* the camera passing *through* roadside buildings and crystals;
* a translucent overpass deck slab in front of the car;
* shots with a rate multiplier snapping back to the plain chase view
  after ~2 s and sitting there for the rest of their 7-second slot.

## The plan

### A. Code quality and the safety net

1. **Headless QA harness** (`tools/qa/`): contact sheet of every demo shot,
   single-shot capture, and a batch generation audit. Every later point is
   verified with it rather than by eye.
2. **Test hooks**: `DriveMode.demoPin(idx,p)` freezes one shot pose;
   `DriveMode.auditTrack(seed)` builds a seed exactly as `start()` does and
   returns pacing, feature spread and roadside-coherence metrics. Every
   feature emission is logged with its span (`dm._lastFeatLog`).
3. **Shot linter** `DriveMode.lintShots()`: samples every shot through the
   same guard the renderer uses. It reports non-finite values, poses outside
   the camera envelope, and per-frame jumps larger than a cut would allow.
4. **Fix the inverted feature control.** `_FEAT_META[k][0]` is documented (and
   exposed in the Algorithm Tool) as "sections per track", but the placement
   director used it as a 0–3 *intensity*. Features rated 5–7 (plunge, climb,
   wallride, airgap, flyover, junction, bridge…) took a −6 to −15 penalty, so
   the director avoided them and they were dumped at the end of the lap.
   Raising a feature's slider made it *rarer*. Fix: an explicit intensity per
   character, with the count used as a selection weight. A count of 0 now
   means "never".
5. **Dead branch in quiet-stretch dressing.** `dress()` tests `kind===3`
   twice, so the slalom treatment could never run. Fold this into point 16.

### B. The fake camera angles (attract mode)

6. **Sub-tick shot sampling.** Bodies are interpolated between 60 Hz physics
   ticks (`dm._alpha`), but the shot pose was sampled from the raw tick clock.
   On 120/144 Hz displays the camera stepped while the car glided. Sample
   the pose at `_demoClock + alpha·STEP`.
7. **One camera envelope for every cinematic source.** `_camEnvelope()`
   clamps yaw, zoom, lift, pitch, roll, Z-traverse and X-offset to validated
   limits, and turns any non-finite value into neutral. It is applied to
   demo shots, intro sweeps and debug views, which were each clamped ad hoc
   (or not at all).
8. **Guard on slot time, not on shot progress.** Rate-multiplied shots
   (up to 3.5×) reached `p=1` after 2 s. The guard's return-to-neutral ramp was
   keyed to `p`, so they snapped back to the chase view and idled for the
   rest of the slot, although the table says they "hold the end pose". The
   ramp now runs on slot time: fast moves finish early, hold, and ease out
   in the slot's last 8 %.
9. **Neutral base camera in demo.** Each demo track picked a random
   `setCamera()` distance, which silently changed height and FOV under every
   authored shot. The demo now runs at the home distance, so the shots frame
   what they were written to frame.
10. **Track changes on shot boundaries.** Demo tracks changed on a wall-clock
    `setInterval(21000)`, while shots run on the physics clock. Any dropped
    frame made the two drift, and tracks cut in mid-move. The engine now
    signals the shell every three shots; a watchdog interval remains as a
    fallback.
11. **Camera-occluder fade.** In cinematic poses, a prop or landscape item that
    is nearer than the car and covers the car's screen position fades to ~20 %.
    Anything projecting taller than 2.2 viewports (the eye is effectively
    inside it) is skipped. This is the standard 3D-game answer, and it needs
    no geometry changes.
12. **Enclosure-aware camera.** Inside or approaching a tunnel, tube or loop,
    the cinematic pose is eased toward a bore-safe sub-envelope (small yaw,
    offset and lift). The eye stays inside the bore instead of rendering a
    full-screen wall.
13. **Shot curation via the linter.** Any shot the linter flags is corrected
    by the envelope, not deleted, so the 146-shot vocabulary survives.

### C. Track generation

14. **Pacing without the end-of-lap dump.** Leftover must-place features are
    inserted into the largest quiet gaps of the finished layout instead of
    being appended before the finish line.
15. **Absurd set pieces** built only from curve + elevation primitives, so the
    scanline renderer draws them safely:
    *Cliff Drop* (blind crest into a sheer drop and a compression),
    *Roller Wave* (hills phase-locked to alternating bends),
    *Spiral Stair* (a constant tight turn climbing in terraces),
    *Blind Snap* (crest straight into a 90° snap),
    *Slingshot* (a long dive feeding a near-hairpin launch).
16. **Character-aware quiet-stretch dressing.** Every stretch longer than 35
    segments used to get the same chicane every 28 segments, which made
    tracks feel alike. Speed characters now get fast sweepers with crests,
    technical ones get chicanes, and elevation ones get rollers. The unreachable
    slalom treatment is restored.
17. **Telegraph → payoff.** Absurd and spectacle pieces are preceded by a short
    calm run-in with a small crest. A calm beat before the surprise is what
    makes it land.
18. **Uniqueness.** The audit tracks the feature sequence and curvature
    profile per seed, so the added vocabulary and the fixed director can be
    checked for spread rather than assumed.
19. **Intensity curve honoured to the finish.** Deciles 8–9 are no longer
    starved. Once the dump is gone, the director's own "strong finish" rule
    decides the ending.

### D. Logical roadside scenery

20. **Planting schemes.** Each side of each stretch (90–260 segments) gets
    a scheme: species (one or two tree forms), a hue centre (±8° jitter,
    not ±60°), a height band and a rhythm (avenue, grove, hedgerow or open).
    Every planting path draws from the scheme.
21. **Biome flora tables.** Tree forms per biome, for example desert → palm,
    acacia and dead; alpine → conifer and cypress; savanna → acacia and baobab;
    haunted → dead and weeping. The 12 forms were uniformly random before.
22. **Settlements, not scattered buildings.** Roadside buildings stand in
    contiguous settlement runs with one setback line, low buildings in front
    and tall ones behind. A building outside a settlement becomes landscape
    (a rock, landform or plant) instead of an orphan.
23. **Terrain-aware landforms.** Rocks and boulders gather in cuttings (steep
    grade) and on the outside of bends. Ponds, reeds and wet forms gather in
    valleys (local elevation minima).

### E. Biomes

24. **Palette ↔ biome affinity.** The track palette is chosen, deterministically
    from the seed, among themes compatible with the biome's temperature and
    brightness. No more lava palettes on glaciers.
25. **Altitude-aware ecotones.** The environment layer assigns zones by terrain:
    crests use the biome's sparse zone plus its high neighbour (forest → alpine,
    desert → mesa, jungle → forest…), and valleys use the lush zone plus its low
    neighbour (forest → wetland, savanna → wetland…). One track now climbs
    through recognisable bands.

## Review of the plan

* **Risk: layout changes.** Points 4, 14–17 and 20–25 change what a seed
  generates, so stored best times refer to a different layout. Preview and
  race still agree because both run the same generator. This is accepted as
  the cost of the brief ("improve the generation algorithm").
* **Risk: renderer regressions.** Points 6–13 only change *camera inputs* and
  *prop alpha*, never segment projection or ground fill, which have a long
  history of fragile fixes. This was a deliberate choice.
* **Rejected: a true 3D ground plane for demo shots.** It would fix yaw
  artefacts at the root, but it would rewrite the scanline renderer that every
  other system depends on. The envelope and occluder fade reach the same visible
  result safely.
* **Rejected: deleting "broken" shots.** The envelope fixes them in place. The
  attract loop keeps its variety.
* **Order:** tooling first (1–3), because every other point is verified with it.

## Results

All 25 points are implemented. The numbers come from `node tools/qa/audit.js 60`
on the same 60 seeds before and after the change.

| Metric (60 seeds) | Before | After |
|---|---|---|
| Tree species per 150-segment stretch | 7.05 | **1.63** |
| Tree hue spread inside a stretch | 36.6° | **8.6°** |
| Orphan buildings | 10.5 % | **0 %** |
| Longest stretch without a real corner (mean / worst) | 890 / 5114 segs | **484 / 1394** |
| Features per lap | 14.6 | **17.3** (≈2.2 absurd) |
| Emissions by lap decile | `119 100 102 101 111 89 83 47 27 99` | `105 110 106 94 106 110 111 108 99 90` |
| Features placed, then cut off the lap | many (positions up to 1.84× lap) | **0.03** per track |
| Must-place leftovers appended at the finish | not measured | **0.18** per track |
| Biome/palette | independent | chosen from the biome's 12 best matches |
| Share of track in an altitude ecotone | 0 % | **30 %** |
| Demo shots with non-finite values or zoom → 0 | 6 latent (108, 118, 119, 126, 127, 133) | **0** (`lint-shots.js`) |

The existing in-browser self-test (`ZS_selfTest()`) gives **45 passed, 1 failed**
on both the original and the new build. The one failure, "road width is
continuous", was already failing before this work. It improved from 58 steps to
35.

### Findings made during implementation (beyond the original 25)

* **Laps were cloned or truncated after composition.** The "track length follows
  the character" pass cut the finished lap short (dropping the planned finish
  and features the preview still listed) or extended it by *copying the start of
  the lap onto the end*. The length is now planned into the director's target
  (point 18), and the post-hoc resize is gone.
* **Six shots drove zoom to 0** (unbounded magnification) as their fade closed.
  The old guard hid this by accident. They are fixed at the source (point 13).
* **In-shot cuts** (shots 133 and 136 move in deliberate steps) left the smoothed
  ground and draw distance lagging for a dozen frames. Any pose discontinuity
  now resets them exactly like a shot change.

### Known, left as is

* `node debug.js` (the headless self-test entry) crashes with
  `document is not defined` on the original build as well. The in-browser
  `ZS_selfTest()` works and was used instead.
* Some set pieces paint large translucent blue decals on the road surface. They
  appear in the plain chase view too, so they are track decoration rather than a
  camera fault.
* Frame rates measured under headless software rendering (2–25 FPS) are not
  representative of a GPU browser. Before/after runs on the same seed were
  within noise once the container was idle.
