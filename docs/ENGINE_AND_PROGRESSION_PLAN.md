# Engine Update, World Tour Progression, Seeds and Feedback

This plan covers the five requests, in the order they were asked:

1. A 20-point update of the pseudo-3D engine.
2. A World Tour progression system.
3. New track types enabled by the engine update.
4. Whether the seed should be larger than 32 bits.
5. A review of the Trash / Best Courses feedback.

Every point is implemented. The "Measured" notes come from the headless harness in `tools/qa/` and the in-browser self-test.

---

## Part 1 — Pseudo-3D engine: 20-point plan

**Where the time went (measured before any change).** A race frame issued about 1,500 path fills and 400–800 rectangle fills on the 2D canvas. 81 % of CPU time was native raster and command submission; very little was JavaScript. Almost all of those calls came from one place: the per-segment road loop (ground bands, deck, rumble, lanes, fog).

The engine's problem is the *number of draw calls*, not the maths.

### GPU where it pays

1. **GPU batch rasteriser.** A Canvas2D-compatible shim is swapped in for `ctx` during the segment loop. Flat-colour `fill()`/`fillRect()` calls go into one vertex buffer and are drawn by **one WebGL call and one blit**. The drawing code itself is unchanged.
   *Measured:* in a normal race frame, 100 % of road-pass fills were batched: ~500 fills become 1 draw call (≈3,000–12,000 vertices), with 0 pass-throughs.
2. **Order-preserving pass-through.** Anything the GPU path doesn't cover (arcs, strokes, images, text, radial gradients, other blend modes, non-rectangular clips) flushes the batch and is forwarded unchanged. Draw order is always exact.
3. **Shader clipping and gradients.** Rectangular clips are evaluated per pixel in user space, so they survive the frame's roll and shake transform. Two-stop linear gradients become per-vertex colours.
4. **CSS colour cache.** Hex, rgb(a) and hsl(a) strings are parsed once. Anything else falls back to the browser's own parser.
5. **Pixel equivalence test** (`DriveMode.renderCompare()`). The same frame is rendered through 2D and through the batch, with a 2D-vs-2D noise baseline.
   *Measured:* on every test frame, batch-vs-2D difference ≤ the frame-to-frame noise of 2D itself.
6. **GPU tiering.** The unmasked renderer string is read. Software rasterisers (SwiftShader, llvmpipe, Basic Render) keep the 2D path, because there batching costs more than it saves. The headless test machine is correctly detected as SwiftShader.
7. **Live calibration.** On real GPUs the loop is timed with batching on and off (40 frames each), the faster mode is kept, and the contest re-runs every ~40 s. The game never assumes; it measures.
8. **Flush-bound bail-out.** If a track needs more than 60 flushes per frame for 45 frames, the batch steps aside.

### New drawing capabilities

9. **Banked turns.** A scanline road can't roll its cross-section without tearing. But the camera is bolted to a car that *is* on the bank, so from inside, the road stays level and the horizon tilts. A banked segment rolls the camera (eased, up to ~21°), draws a raised red/white apron on the outside edge, and physics reduces the outward push and cornering load.
10. **Road surface materials.** Ice, dirt, sand, metal grating, glass, lava crust and grass. Each has its own deck colour, grip multiplier and rolling drag.
11. **Sky highway.** Segments with no ground: the band beneath is open sky, deepening toward the bottom of the screen, with cloud layers. The deck gets a cyan edge glow. Scenery, landscape and roadside fire are excluded.
12. **Driving viewpoints.** `V` cycles **Chase → First person → Heli → Drone → Cinema**. The three new cameras drive the orbit axes through the same safety stack as the demo: envelope, tunnel guard, occluder fade and cut reset. They are eased so switching views glides.

### Robustness

13. **Non-finite projection guard.** A NaN or Infinity from anywhere upstream marks the point as behind the camera. It can never reach the rasteriser.
14. **Frame profiler.** `DriveMode.engine().perf` reports world ms, loop ms, frame ms, adaptive quality and resolution rung. It shows what the governor and calibration decide on.
15. **Road-bounds verifier fixed.** `_verifyRoadBounds` read an undefined variable `s`, so the player half of the "hard guarantee" threw on every physics step and was silently skipped.
16. **Dead theme controls fixed.** Several overrides were written but never read, so these controls did nothing:
    - Super Racing's **Biome** and **Weather** selectors (`_forceBiome`, `_rainOdds`, `_snowOdds`, `_sandOdds`);
    - several presets (`_forceNight`, `_snowClass`, `_stormForce`).

    `makeTheme` now honours them, plus `_forceTheme`, `_forceSurface` and `_forceFeat`.
17. **Clean World Tour builds.** World Tour races used to inherit whatever generator overrides the previous Super Racing / Algorithm Tool race left behind, so a town's track depended on what you played before. They now start clean.
18. **Seed mixing** (see part 4). Every generator stream starts from a well-mixed state.
19. **Deterministic generation** (see part 5). A seed builds the same track regardless of history.
20. **Engine capability registry.** `ENGINE_CAPS` lists the batch, banking, surfaces, sky highway, viewpoints, camera axes and cinematic safety layers. It is exposed through `DriveMode.engine()`, so tooling and the generator can query what the engine can draw.

### Review of part 1

- **Rejected: a full WebGL renderer.** It would rewrite ~3,000 lines of segment drawing that every other system depends on. The shim gets the batching win with the existing code.
- **Rejected: real road-surface roll.** The FLAT-DECK sanitiser exists because rolled decks tore. Camera-roll banking is how an on-board camera actually sees a bank, and it is artefact-free.
- **Rejected: batching sprites.** Props, trees and buildings are already cached bitmaps drawn with one `drawImage` each; the win was in the road pass.
- **Honest limitation:** GPU speed-ups can't be measured on this machine, which has no GPU (SwiftShader). That is why the engine calibrates itself on the player's machine rather than shipping a guess.

---

## Part 2 — World Tour progression

The problem with 81,742 towns is **sameness, not size**. The count stays the same; the world gets *places*, and the player gets reasons to find them.

| System | What it does | Measured |
|---|---|---|
| **Traditions** | ~40 % of municipalities keep one of 24 local traditions: GLACIER MILE, SKYWAY, BANKED BOWL, NEON NIGHTS, DUST DEVILS, CANYON KINGS, RAINBOW RUN, STORM CHASERS, GOLDEN HOUR, MIDNIGHT RUN, FROZEN LAKES, LAVA FIELDS, CORKSCREW VALLEY, TUNNEL TOWN, CHROME CITY, GHOST TOWN, AURORA ROAD, JUNGLE RALLY, SAND SEA, ABSURDIA, SPEED TEMPLE, TECHNICAL TRIALS, ISLAND HOPPERS, FOG VALLEY. Every town in the municipality carries it: biome, palette, surface, time of day, weather and signature features. | 3,612 of 9,116 municipalities (39.6 %); every tradition in ≥116 municipalities |
| **Legends** | 1 town in ~211 is an absurd, maximal track in a legendary palette ("LEGEND · …"). Hidden on the map (a brief twinkle) until revealed. | 380 legends in 81,742 towns |
| **Passport** | Winning in a tradition's municipality stamps it. Stamp milestones (3/6/10/15/20/24) pay 5k–250k credits and unlock Tour Stock and titles. | — |
| **Streaks** | Consecutive wins raise a credit multiplier to ×2.0; a loss resets it (with a "streak lost" note after 3+). | — |
| **Featured towns** | Three unlocked towns a day pay double and drop a Mystery Crate. They are marked on the map with a bobbing gold ★ ×2. | — |
| **Rumours** | A third of wins (and every legend) reveal something nearby: a hidden legend's town, or an unstamped tradition in the same state. The rumour shows on the map. | — |
| **Tour Stock** | A new **TOUR PASSPORT** shop tab (LB/RB). It shows the stamp grid (traditions stay "?" until a visit or rumour reveals them), career stats, the next milestone, and stock that grows with the passport: Turbo Canister, Credit Magnet, Legend Compass (3 stamps), Mystery Crate (6), Golden Ticket (10). | Purchases verified in the UI |

**Animation and feedback** (victory screen):
- the credit total rolls up and bursts into coins;
- streak flames grow under the title;
- a passport stamp slams down with an ease-out-back overshoot, a shockwave ring, a screen jolt and confetti in the tradition's colour;
- a conquered legend lights rotating golden rays;
- milestones burst confetti;
- rumours type themselves out.

On the map, tradition municipalities show a coloured ring and a banner naming the tradition. Revealed legends get a rotating rainbow star, and featured towns a gold star.

### Review of part 2

- **Kept deterministic.** Which town is which is a pure function of its id, like the rest of the World Tour; only progress is saved.
- **Kept the count.** No track is added or removed. Variety comes from giving places an identity.
- **Kept the economy honest.** Every bonus goes through the existing credit system, which was designed so that upgrades never outpace the CPU scaling.

---

## Part 3 — New track types from the engine update

| Type | Engine feature | Generator |
|---|---|---|
| **Banked Oval** | banking (9) | 2–3 long banked constant-radius turns, taken flat out |
| **Banked corners** | banking (9) | a share of every track's ordinary long corners are banked |
| **Sky Highway** | void deck (11) | the road climbs off the ground and runs as a glass or grating ribbon over open sky |
| **Ice Rink** | surfaces (10) | sweeping bends on ice (42 % grip) |
| **Dirt Rally** | surfaces (10) | kinks and crests on loose dirt |
| **Biome surfaces** | surfaces (10) | stretches of the biome's own ground: ice in the cold, sand/dirt in dry country, grass, lava crust, city metal |

*Measured over 60 seeds:* on average 10 % of a lap is banked, 12 % is on a special surface and 3 % is sky highway (up to 42 %, 50 % and 30 % respectively).

**Super Racing edit tile.** A new **ENGINE** section (column 2): `bankOdds`, `bankAmount`, `surfaceOdds`, `surfaceShare`, `skyHighwayOdds`, and counts for `bankedoval`, `skyhighway`, `icerink` and `dirtrally`. The columns now scroll and keep the selected row in view; the new section had pushed column 2 past the bottom of the tile. The **Biome** and **Weather** selectors now actually work (part 1, point 16).

---

## Part 4 — Should the seed be larger than 32 bits?

**No. 32 bits is enough; the seed was the wrong place to look.**

- **Collisions.** Random 32-bit hashes reach a 50 % chance of one collision at about 77,000 seeds, which is close to the World Tour's 81,742. So this was checked directly: **all 81,742 World Tour seeds are distinct (0 collisions)**. Grand Prix and Super Racing use far fewer.
- **Variety.** Variety is bounded by the generator's *vocabulary*, not the seed width. That is 12 characters × 128 archetypes × 7 intensity curves × 7 placement styles × ~100 scene profiles × 25 scene modes × 20 biomes × ~12 palettes each, plus continuous parameters and ~100 feature types. A 64-bit seed would add more ways to say the same things, not new things. New vocabulary (parts 1–3) is what adds variety.
- **The real defect was mixing.** The RNG was a raw xorshift32 seeded directly with the seed. Its first outputs are almost linear in the seed, so small or structured seeds all rolled near-zero opening draws: 1, 2, 3, the `1000+i*7919` magic-car seeds, and counter-based seeds. Seeds 1, 2 and 3 all drew ≈0.0001 first, so they got the same turn bias, hill amplitude and character. The seed now passes through the MurmurHash3 finaliser (a bijection, so every seed still gives a distinct stream), and neighbouring seeds give unrelated tracks.

---

## Part 5 — The good/bad feedback system

### Review of the old implementation

- **It barely learned.** Archetype, profile and scene mode were re-weighted only after the *same exact value* had been trashed or liked twice: 1 of 128 archetypes, 1 of ~100 profiles. Most feedback never had any effect.
- **It broke determinism.** It changed the generator itself. `trashPick` re-weighted choices and `_AO()` pulled every continuous parameter toward liked averages. So the same seed built a **different track** as the history grew, silently changing saved Best Courses, Grand Prix rounds and World Tour towns.
- **Dead code.** `trashNudge`, `likeNudge`, `trashWeight` and `likeWeight` were no longer connected to anything.

### The redesign: learn which seeds to offer, not how to build them

- **Generation is deterministic again.** Feedback never touches the generator.
- **A small model.** Each seed has cheap traits: character, biome, palette family, weather and the opening parameter roll. The roll is shared with the build (`_rollTP`), so traits and track can't disagree. Commit = good, Trash = bad trains a class-balanced logistic regression. The whole existing history trains it retroactively, because every entry is re-read from its seed.
- **Screening.** The Super Racing random tile, its 100-track roster and the attract demo draw several candidate seeds and offer the one the model rates highest. 20 % of the time they explore at random, so the model keeps meeting new things. With little history it stays at 50 % and changes nothing.
- **Feedback you can see.** After Commit or Trash a toast summarises what was learned (e.g. "❤ COOL PALETTE · TUNDRA ✖ NEON · LUNAR"). The random tile shows a **FIT %**.

*Measured* with a synthetic player who likes snowy biomes and dislikes neon/city/lunar (14 of each), on held-out seeds: liked-type seeds score **73 %**, disliked-type **32 %**, others **38 %**. The same seed builds the identical track with and without history.

---

## Results and verification

- In-browser self-test (`ZS_selfTest()`): unchanged from before this work. The one pre-existing failure ("road width is continuous") remains.
- Generation audit: no build errors over 60 seeds; features are still spread evenly across the lap.
- Shot linter: 0 non-finite camera values.
- No page errors in: attract demo, Super Racing edit tile, a race driven with keyboard input, viewpoint cycling, the World Tour map, the victory celebration and the Passport tab.
