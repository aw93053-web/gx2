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
