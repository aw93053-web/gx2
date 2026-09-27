# Gameplay, controls, World Tour and Super Racing update

This round covers six requests. Each section describes what was wrong, what changed, and how it was checked.

## 1. Bump / bounce: reach, impact, clarity

**What was wrong**
- The scan reached only 20 segments ahead, and the lock always took 1.3 s. At racing speed the player closed on the rival, and usually passed it, before the lock finished.
- The FX and HUD block sat inside `drawRival`, so it was drawn once per rival every frame. That meant 7× overdraw, including a 500-particle burst.

**What changed**

| Stage | Behaviour |
|---|---|
| Lookahead | 80 segments ahead (about 1.1 s at top speed) and 3 behind. A rival you have just passed is still a target. |
| Lock | 0.35 s alongside, rising to 0.75 s at the far edge. It runs on simulation time. |
| Homing strike | Releasing RB launches a lunge toward the target. The machine closes the gap in 0.26–0.64 s (scaled by range), steers onto the rival's flank and hits on contact. Cars in between are passed through. A long-range lock therefore still connects. |
| Impact | Hit-stop runs the physics at 5% for 110 ms, then slow motion eases from 22% back to full over 650 ms. There is a white-out, three shock rings, sparks, a sub-bass thump with a noise burst, 450 ms of rumble and a screen jolt. |
| Camera | Four beats through the real orbit axes (envelope and tunnel guard apply): the lunge (low, trailing, wide lens), a frozen side-on two-shot with a roll kick, a slow-motion swing up and behind as the rival drops away, and an eased return. In first person the strike plays from the cockpit. |
| Clarity | - Hint `RB ▸ BUMP (n IN RANGE)` whenever a target exists.<br>- While locking: a progress ring, rival name, distance, and an **ON RELEASE** panel (rival −86% speed · stun 2.8 s · −18% shield / you +22% slingshot · −5% shield).<br>- After the hit: a **BUMP LANDED** card with the actual numbers, the strike range and the position change (P8 → P7 ▲1).<br>- The struck rival shows orbiting sparks and a `STUNNED 2.1s` countdown. |

Other fixes:
- The slingshot is now measured against the speed before the lunge, and its ceiling holds through the slow motion.
- The rival is no longer teleported behind the player. It is knocked aside and ghosted for 1 s, so the pass happens visibly.

## 2. Controller map and camera views

| Button | Action |
|---|---|
| A | Accelerate |
| X | Brake |
| B | Turbo boost (still "back" in menus) |
| LT / RT | Lean left / right (analogue pull) |
| RB | Lock on: hold to lock, release to strike |
| LB | Next bump target |
| Y | Cycle views: **Chase** (debug viewpoint 1/37), **Close Chase** (4/37), **Cinematic** (5/37), **First Person** |

- The keyboard mirrors the pad: Z/C lean, E lock, R next target, V view. N keeps the heli, drone and cinema cameras.
- **First person** is a true driver's eye. The camera moves forward onto the machine at helmet height. It rolls with lean and bank and shakes slightly with speed. The cockpit is redrawn: a nose cone in the car's own paint, side pods, and a slim dash with speed, shield and turbo charges.
- It was added to the debug viewpoint list as 6/37.
- The chosen view persists between races.

## 3. World map progress plate

Passport, legends, streak, featured count and the latest rumour now sit inside the WON / UNLOCKED rectangle, as a second and third row. The separate strip over the map is gone. The tradition banner sits under the plate.

## 4. World Tour result flow

**Bug:** winning never unlocked anything. World Tour decides a win from `DriveDebug._state().place`, which did not exist, so every win was recorded as a loss. `_state()` now reports `place` and `podium`.

**Engine finish screen (Xbox layout)**
- **A: next race.** Opens the World Tour result, then the map.
- **X: race again.** World Tour restarts the settlement, so the rerun is recorded. Before, A and X restarted in-engine and the tour never saw the result.
- **B: title screen.**

**World Tour result screen:** the same A / X / B.
- X was never forwarded from the pad on the map screen; it is now.

**Unlock reveal on the map**
- A trail of small white dots runs from the settlement just won to each settlement the win opened.
- Each one lights up with a burst and a "NEW TRACK UNLOCKED" label.
- The first new settlement is pre-selected, and the player chooses where to go next.

**Progression:** a win in a fully-open municipality now opens the next municipality (or state) that still has locked settlements. It no longer opens nothing.

## 5. Generator uses the engine's new capabilities

A second engine-aware pass puts banking, materials and sky roads where they mean something:
- **Bridges, flyovers and multi-deck roads** are laid with steel grating.
- **Black ice** on cold tracks, just past tunnel exits and at the foot of long descents.
- **Dust drifts** at the entry of the tightest corners on dry tracks.
- **Surface runs start in braking zones**, 10–20 segments before a corner.
- **Speedway banking** on fast sweepers entered from a straight. The amount follows the curve.
- **Off-camber crests** on wild tracks. The bank leans away from the bend and pushes the car outward, with an "OFF-CAMBER!" warning.
- **Sky bridge:** the highest calm stretch of a mountainous track floats over open sky.

Measured over 60 seeds:

| Metric | Before | After |
|---|---|---|
| Tracks with surfaces | 39 | 54 |
| Tracks with sky roads | 15 | 22 |

Over 40 seeds, speedway banking appears on 30 tracks. The feature count and its spread across the lap are unchanged.

## 6. Super Racing random / edit tile

**Browse mode**
- A large preview.
- A **Track DNA** card: six headline dials (CURVES, HILLS, SPEED, CHAOS, SPECTACLE, DANGER), world chips, race chips and the track's signature features.
- Under the preview: its place in the browse history and a **your taste** fit bar.

**Track Lab (X)**
- Eight tabs, switched with LB/RB:
  - **QUICK:** macro dials that move a whole group of parameters, plus length, laps and rivals.
  - **WORLD:** biome, weather, time of day, palette, surface, snow class, storm, fog, vegetation, buildings, skyline and camera roll.
  - **SHAPE**, **PACING**, **ENGINE**, **LOOK & FX** and **RULES**.
  - **FEATURES:** every track type as a count chip; 0 = OFF.
- LT/RT adjust fast, Y shuffles the tab, and the live DNA updates under the preview.
- On keyboard, Q/E switch tabs, R shuffles and Shift+arrows adjust fast.
- The preset tile shows the same DNA card.

**Newly reachable**
- 17 feature types the generator already had: sky ramp, gravity well, sweeping arc, open run, downhill blast, flow chain, crest sweep, esses, canyon run, walled chicane, cliff drop, roller wave, spiral stair, blind snap, slingshot, mirror straight and mega elevation.
- Every `_feat_<kind>` override now reaches the generator.
- Palette, surface, time of day, snow class, storm and camera roll were never editable before.

## Verification

- In-browser self-test: 45 pass, 1 pre-existing failure ("road width is continuous").
- Shot linter: 0 non-finite camera values over 146 shots.
- Generation audit: no build errors over 60 seeds.
- Bump harness: locks at 50+ segments, and the strike lands at 27–45 segments in the chase and first-person views, with a +22% surge.
- World Tour end-to-end:
  - Map → race → forced win.
  - The podium reads `A — NEXT RACE X — RACE AGAIN B — TITLE SCREEN`.
  - The result screen follows, then the map with the dot reveal.
  - Unlocked goes 8 → 10, and the new settlement is selected.
- Super Racing: browse → Track Lab (every tab) → race. The palette override reaches the race. No page errors anywhere.

---

# Round 2: fixes and the Track Lab plan

## Fixes

1. **Game over YES/NO ignored the d-pad and stick.** `continueOpen()` lives in the shell and checked the engine's `race`, which the shell cannot see. The check threw and was swallowed, so the prompt was drawn but never counted as open. It now reads `DriveDebug._state()`. Tested: keyboard ←/→, d-pad and left stick all move the selection.
2. **PlayStation glyphs on an Xbox pad.** Microsoft reports "Xbox Wireless Controller", which contains Sony's generic "Wireless Controller", and the Sony pattern was tested first. Xbox is now matched first in both detectors.
3. **Rival times on the champion screen.** A winner finishes before anyone else, so every rival showed "—". The board now fills in real times as rivals finish. Until then it shows a projected time (≈), from remaining distance and current pace, and re-sorts as times firm up.
4. **World Tour text is 30% larger.** This covers the result/celebration text, rewards and unlock lines, the "NEW TRACK UNLOCKED" labels, settlement names on the map and the selected-town details.
5. **The BUMP LANDED card** is now a DOM overlay pinned to the top of the screen, in the `t-logo` fire style.
6. **Track-feature toasts removed:** special-section names, sideways surge, corkscrew rush, speed rush / tube boost, zigzag storm, off-camber, guide beam slam, speed-up arrows, jump / high road, junctions shifted, lost grip and tunnel hub.
7. **Rival lock-on alert.** The toast is replaced by two red down-arrows, one each side of the player's car, bobbing and swaying. Between them sits a small `t-logo` alert, "RIVAL LOCKED ON YOU / TURBO TO ESCAPE". The red screen frame stays.
8. **A landed bump costs 20% energy.** The lock preview and the card show this.
9. **Tunnel effects doubled.** 81% of tunnels now carry animated walls, up from 40.5%. One in five of those runs at **double intensity**: the frame is added onto itself (2× light), with 1.7× stroke width and 1.45× flow speed.
10. **The lock-on crosshair no longer lands on empty space.** It was placed by re-projecting the target's segment, which is stale or wrong when the rival is over a crest or past the draw distance. Now:
    - every rival records where it was actually drawn, and the crosshair follows that position, eased;
    - only rivals drawn in the last 3 frames can be locked;
    - if the target is briefly hidden, the crosshair holds its last position at reduced opacity.

## Super Racing Track Lab: 20-step plan

| # | Step | Status |
|---|---|---|
| 1 | Wider ranges in the lab: continuous settings from ½ × min to 2 × max, feature counts doubled, probabilities over the full 0–100%. The random roll keeps the old ranges. | done |
| 2 | Engine clamps widened so the new ranges matter: track length ×4 (was ×3), laps 1–12, rivals 0–7. | done |
| 3 | Hold-to-accelerate on ◀▶: the step grows ×1 → ×2 → ×5 → ×12 at 0.6 / 1.3 / 2.2 s, and repeats every 45 ms. | done |
| 4 | LT/RT fast adjust scaled to each setting's range (1/80 of range per step, 6 steps per tick). | done |
| 5 | New **TUNNELS** tab. | done |
| 6 | Animated-wall share (`_tunFxOdds`). | done |
| 7 | Intense-wall share (`_tunFxIntense`). | done |
| 8 | Force one of the 48 wall patterns (`_tunFxPattern`). | done |
| 9 | Force the wall palette (`_tunFxPalette`). | done |
| 10 | Wall flow speed (`_tunFxSpeed`). The tunnel bore counts (tunnel, pipe, vertical loop, boreholes, smoky bores) sit in the same tab. | done |
| 11 | Default marker on every bar. | done |
| 12 | Changed settings marked with a dot; each tab shows a count badge. | done |
| 13 | Readable values: %, ×n, OFF, names, AUTO. | done |
| 14 | Range and default shown under the description. | done |
| 15 | View resets the selected setting, L3 resets the tab (keyboard: Backspace / Delete). | done |
| 16 | Selected row highlighted with ◀ ▶ around the value. | done |
| 17 | Tab header with the tab's purpose, in its accent colour. | done |
| 18 | Two-line rows: full names (no truncation) with value, and a larger bar beneath. | done |
| 19 | Absurd feature types highlighted in the FEATURES grid. | done |
| 20 | Keyboard parity (Q/E tabs, R shuffle, Shift+←/→ fast, Backspace/Delete reset) and an updated key strip. | done |

**Review notes**
- Persisting lab edits across browsed tracks was considered and dropped. Edits belong to the track being tuned, and history browsing relies on that.
- The wider ranges apply only to lab edits, so random tracks do not get more extreme.
- Tunnel overrides are read only in races launched from Super Racing. World Tour clears the override set.

---

# Round 3

1. **Bump hit text is white `t-logo`.** The BUMP LANDED card uses the logo face and stroke with a white/steel gradient instead of fire. The random shout ("BODY SLAM!!" and so on) was a plain toast; it now opens the card with a pop-in.
2. **Track "loaded zoomed in and diagonal".**
   - **Cause:** the attract demo changes track every three shots, while the shot index runs on a global clock. A new track could therefore open part-way through shot 116, "INVERTED HANG", which rises overhead and rolls upside down. Caught mid-roll, the frame sits about 38° off and looks down at a zoomed road, which matches the screenshot.
   - **Fix:** the first shot of every demo track is now drawn from 26 calm establishing shots (no roll, modest lift, pitch and zoom). Shot 116 is now a gentle "HIGH DUTCH" tilt.
   - **Check:** a sweep of all 146 shots finds no remaining rolled overhead pose.
3. **Loop-back crossovers.** The old underpass was a dip with nothing crossing it. The new feature, which also replaces `underpass` in the palette, works like this:
   - the road runs straight, sweeps a banked 270°, and comes back across its own approach;
   - the self-crossing pass lifts the later pass onto a bridge on pillars, so the player sees the road they are about to take crossing overhead from far down the approach, then goes round and crosses back over the road they just used.

   Three fixes were needed to make it build reliably:
   - it is emitted segment by segment (the build's `addRoad` wrapper rescaled the sweep to ~130°);
   - its curvature is re-asserted before the crossing pass;
   - the crossing scan visits loop-backs first, and only pairs a loop with itself, so natural crossings can't use up the budget.
4. **Trees:**
   - Conifers, cypresses and pagodas are stacked tiers, each split into a lit and a shaded half.
   - Palms have a curved trunk and arched fronds, lit on one side.
   - Acacia and banyan have a flat, wide crown over a shaded band.
   - Bare trees are forked branches.
   - The round forms keep their lobes and gain an upper-left highlight and a lower-right terminator.
   - Every trunk is two-tone.
5. **Loop-de-loop.** A boosted run-up, a climb, an inverted crest and a dive, with the frame turning a full 360° through the loop, interpolated per segment so it never unwinds. Measured over 50 seeds, it appears on ~1 in 3 tracks.

**Super Racing:**
- FEATURES tab: counts for LOOP-DE-LOOP and LOOP-BACK CROSSOVER.
- ENGINE tab: LOOP-DE-LOOP CHANCE and CROSSOVER CHANCE.

## Round 6 fixes

1. **Deaths on a clean jump (seed 3171490621).**
   - **Cause:** a jump's airtime was a wall-clock budget, but the machine only moves on physics steps, and those are capped at 4 per frame with the backlog thrown away. On a slow or hitching frame rate (or during the bump slow-mo), the budget ran out while the machine was still over the hole, which counted as "fell into the void".
   - **Reproduced:** on this seed, driving straight off the ramp at full speed killed the machine in 2 of 12 trials.
   - **Fixes:**
     - Time the loop does not simulate in a frame is now added to every live airtime.
     - A jump launched at a hole also stays in the air until it has crossed that hole's far edge.
   - **Result:** 12 of 12 trials survive. Missing the landing off the side of the road still kills.
2. **HUD too large or cut off.** The HUD is drawn in CSS-pixel space, scaled with the window (0.62×–1.25×), so a lower internal render resolution no longer inflates it. The DOM corner logo follows the same scale.
3. **Track loads as a single flat colour.**
   - **Every frame:** the canvas state is reset (transform, alpha, blend, filter, shadow and any unbalanced save/clip).
   - **After a race starts:** the canvas is hard-reset twice, at 120 ms and 650 ms. This is the same thing opening the developer tools used to do.
   - **Watchdog:** every 0.5 s during a race it samples the frame. If the frame has been one flat colour for 1.5 s, it hard-resets the canvas.
4. **Stray autobahn signs.** Signs are no longer scattered by the deep-scenery and vegetation passes. Any sign further than 3 road widths from the road edge is skipped when drawn.
5. **Five new demo shots:**

   | # | Name | Camera |
   |---|---|---|
   | 146 | Cockpit ride | First-person camera; the machine is hidden. |
   | 147 | Heli follow | High, trailing chase camera. |
   | 148 | Drone weave | A low camera that sweeps from side to side. |
   | 149 | Crane dive | Drops from high above to road level. |
   | 150 | Bank rider | Rolls with the track banking and the loops. |
6. **Tunnel bore blinking red and white.**
   - **Cause:** "intense" animated tunnels (1 in 5 animated tunnels) doubled their light by adding the wall frame onto itself (additive blend). That saturated every bright near ring to pure white while the far rings kept the tunnel's hue. As the rings streamed past, the bore strobed between the hue (red on a red tunnel) and white.
   - **Fix:** intense walls now get their strength from more opaque, thicker strokes, with lightness capped. They keep their colour.
   - **Measured** by sampling every frame through the entrances and exits of 5 tunnels: up to 28% of the screen jumped to white between frames before the fix, and 0% after.
