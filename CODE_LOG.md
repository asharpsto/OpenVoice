# CODE_LOG

Snapshot at every stage exit: what was built, what was deferred, what broke.

---

## Stage 1 — Terrain core (2026-09-04)

Deliverable (SPEC §12, day 1): mask format, load, render, destroy, query, broadphase.
Exit criteria: all terrain tests pass; blit + `texSubImage2D` under 4ms.

### Status: met

- **63 tests pass** (`npm test`), covering every terrain item in SPEC §10 plus the
  broadphase, the rim shade and determinism.
- **Destruction path: 0.58ms p50 / 0.90ms p99** at radius 80 on a 2048×1536 map
  (`npm run bench:blit`) — see *Measurements* for what that number does and does
  not include.

### Built

```
/src/terrain
  materials.ts   material IDs and names
  mask.ts        the mask; owns the 16×16 broadphase occupancy grid
  ingest.ts      RGBA → mask, long-edge cap, mode-filter downscale
  load.ts        fetch + decode a baked map in the browser
  destroy.ts     explosion blit, per-material radius, dirty rect
  patch.ts       RG8 texture patch + rim shade (chamfer distance transform)
  query.ts       point test, sub-pixel raycast, broadphase skipping
  validate.ts    map validation, spawn finding, island detection
  render.ts      PixiJS terrain view, dirty-rect texSubImage2D uploads
  rect.ts        integer rect helpers
/src/tune/terrain.ts    typed loader for tune/terrain.json
/src/core/rng.ts        seeded PRNG (nothing may call Math.random)
/src/dev/syntheticMap.ts stand-in map, dev only
/src/main.ts            stage 1 harness
/pipeline/bake.ts       photo + mask → map assets, validated
/tools/fixture-map.ts   synthetic photo/mask pair for exercising the baker
/tools/smoke/           headless-Chromium check of the WebGL path
/bench/blit.ts          destruction path against the 4ms budget
/tune/terrain.json      blast resistance, rim, raycast step, validation
```

### Decisions

- **Mask PNG encoding: material ID in the red channel**, G and B mirrored so the
  file is viewable. Exact, no palette to drift. Any value above 5 is rejected at
  ingest rather than guessed at — a mask that went through something lossy is a
  mask that will drop a monkey through a hedge.
- **Blast resistance divides the radius**: effective radius at a pixel is
  `radius / blastResistance[material]`. Resistance 2.4 (building) gives a crater
  0.42× the size; 0.45 (vegetation) gives 2.2×. Per pixel, no line of sight, as
  specified — which is what makes the hedge in front of a wall blow away while
  the wall chips.
- **Mask texture is RG8**: R the material ID, G the rim shade. One texture, one
  upload per crater.
- **Rim shade is computed at upload time, not stored.** A chamfer distance
  transform runs over the dirty rect only, which is why fresh craters get a
  carved edge and the photograph's own silhouette does not. It also means no
  second full-size buffer: the mask stays 3.0MB at 2048×1536, inside the 4MB
  budget.
- **Broadphase is a per-cell solid count, not a bit.** Destruction decrements it
  per pixel, so occupancy stays exact with no rebuild. It accelerates both
  raycasts and the blit.
- **WebGL is forced** (`preference: 'webgl'`). `texSubImage2D` is a WebGL call;
  Pixi would otherwise pick WebGPU where available.
- **Reachability is approximated** by connected components: the largest solid
  mass is the mainland, anything else is an island. True reachability needs the
  slope limit and jump height, which arrive with the controller in stage 3.

### Deferred, deliberately

- **Stylisation shader** (SPEC §11.1). A load-time step; the loader hands over a
  decoded photo with a clear place to insert it. Art is stage 7+.
- **Mask paint tool** (SPEC §5.2) and real maps — stage 2. The baker that
  consumes them is written and exercised end to end against a synthetic pair.
- **Tuning harness** — hot reload, sliders, write-back — stage 3 (SPEC §7).
  `tune/terrain.json` exists and is the only source of terrain numbers; terrain
  functions take tuning as a parameter so the harness can swap it live without
  touching call sites.
- **Fixed-timestep loop and event bus** (`/src/core`). Nothing to step until the
  physics arrives in stage 3; the harness runs on Pixi's ticker. Building a loop
  now would be guessing at the interface.
- **Camera** — stage 6. The harness scales the map to fit, so a 2048px map is
  drawn at about 0.5× on a laptop and the 4px rim reads as 2px. Worth
  re-checking the rim depth once there is a camera at 1:1.

### Measurements

`npm run bench:blit`, 2048×1536 map, 53.8% solid, rim depth 4px, 300 craters per
radius after warm-up:

| radius | mask blit p50/p99 | RG8 patch p50/p99 | total p99 |
|---|---|---|---|
| 20px | 0.077 / 0.120ms | 0.067 / 0.166ms | **0.25ms** |
| 40px | 0.213 / 0.310ms | 0.070 / 0.256ms | **0.52ms** |
| 80px | 0.457 / 0.791ms | 0.099 / 0.361ms | **0.90ms** |

Full-map patch at load: 29ms, 6.0MB — once per map, inside the 2s load budget.

**This is the CPU half.** The `texSubImage2D` call itself needs a GPU, so it is
measured in the browser: the harness overlay reports blit, upload and their p99
against the 4ms budget live. Headless Chromium renders on SwiftShader, so its
numbers are not indicative — **the budget still has to be confirmed on a real
mid-range Android**, which is a gate-1 job.

Two things made the difference and should not be undone:

1. **The blit walks broadphase cells, not the whole scan box.** Radius 80 was
   2.59ms p50 before, 0.46ms after (5.7×) — a large blast over a street is
   mostly sky, and sky is now rejected 256 pixels at a time.
2. **The patch builder reuses its scratch buffers.** Allocating the distance
   window per crater produced 8ms GC spikes; worst case is now 0.29ms.

### What broke on the way

- **Spawn finding only ever returned the topmost surface per column**, so the
  street under a bridge was never spawnable — exactly the layered-platform map
  in SPEC §5.1. Spacing is now enforced per level rather than per column.
- **A bridge deck with no ramp is correctly an island.** Found by a test fixture
  that was wrong, not by code that was: the first version of that fixture had a
  deck floating over the street with nothing joining them.
- The rim shading looked absent in the first screenshots. It was not — the
  harness draws a 2048px map at 0.5× on a 1024px viewport, halving a 4px rim.
  Confirmed by sampling the render: ground reads 116,106,96 and the pixel at the
  crater edge reads 65,59,54, which is the 0.6 rim strength.

### Notes for stage 2

- `pipeline/bake.ts` is ready: `npm run bake -- --photo p.png --mask m.png --id street --water <row>`.
  It refuses to write an unplayable map unless `--force`. `--water` is a row in
  the *source* image and is scaled with everything else.
- The harness loads a baked map with `?map=/maps/<id>/map.json`; without one it
  generates a stand-in.
- `tools/fixture-map.ts` writes a synthetic photo/mask pair, useful for testing
  the tool chain before real photographs exist.
- Validation thresholds live in `tune/terrain.json` under `validation`. SPEC §7
  does not list them; they are terrain configuration rather than feel, and
  putting them anywhere else would have meant magic numbers in code.

### Running it

```
npm install
npm test           # 63 terrain tests
npm run typecheck
npm run bench:blit # destruction path vs the 4ms budget
npm run smoke      # headless Chromium: shader links, uploads run, baked map loads
npm run dev        # the harness — tap to fire, [1/2/3] radius, [s] stress, [g] grid
```

### Note on this repository

Project Banana was built into the `asharpsto/OpenVoice` checkout, at the root
layout SPEC §4.3 specifies. No OpenVoice file was modified; the two projects sit
side by side. If Banana is meant to have its own repository, this tree moves
across unchanged.

---

## Stage 2 — Mask tool (2026-09-04)

Deliverable (SPEC §12, day 2): mask tool + first 2 maps baked.
Exit criteria: two validated maps loading in the game.

### Status: tool done and verified. Maps blocked — they need photographs.

The tool half is finished and driven end to end in a headless browser. The maps
half cannot be done here: SPEC §5.1 wants six to eight **hand-shot** maps chosen
for silhouette variety, and pillar 1 is "your street — a real place the players
recognise". Generating those would defeat the point of the feature. See *What is
needed to close stage 2*.

### Built

```
/tools/masktool
  index.html     the tool's page
  main.ts        canvas, pan/zoom, brush, undo, export
  ops.ts         threshold seed, flood fill, despeckle, brush stamping
/tools/smoke/masktool-smoke.ts   headless run of the whole tool
/tests/masktool.test.ts          20 tests over the mask operations
```

All six features SPEC §5.2 asks for:

1. **Auto first pass** — brightness + position threshold, both on sliders.
2. **Paint and erase** — circular brush, size 1–120px, material by selection,
   erase as material 0. Strokes interpolate, so a fast drag leaves no gaps.
3. **Flood fill** — 4-connected, scanline. Tolerance 0 fills by mask; above 0 it
   follows the photograph's colour, which is how a road gets filled in one click.
4. **View toggle** — photo / mask / overlay at 50%.
5. **Despeckle** — morphological close over the solid set, radius on a slider.
6. **Export** — mask PNG (material IDs in the red channel) plus the texture.

Plus two things not on the list that the tool is unusable without:

- **Undo** (12 levels). "Ten minutes painting each mask" is not achievable if a
  mis-click means starting again.
- **Check playability** — runs the stage-1 validator in the tool and reports
  coverage, spawn count and island spawns. Finding out a map is unplayable while
  you are still holding the brush beats finding out at bake time.

### Decisions

- **The threshold seed stays a seed.** It is a brightness-plus-position rule and
  nothing more. Growing it into segmentation is explicitly out (CLAUDE.md), and
  the measurements below are a good argument for why.
- **Painting happens at final resolution.** The photo is downscaled to the
  2048px cap on load, using the same box filter the baker uses, so what is
  painted is pixel-for-pixel what the game loads. Painting large and downscaling
  the mask afterwards would move edges through the mode filter.
- **Export verifies its own round-trip.** The mask is material IDs stored as
  pixel values, so it must survive PNG encode/decode byte for byte. The tool
  re-decodes what it just encoded and refuses to download if a single byte
  moved. A silently corrupted mask is terrain that stops matching what the
  painter drew, and it would not show up until a monkey fell through a wall.
- **Overlay colours are not the game palette.** SPEC §11.2 reserves those
  absolutely; a dev tool has no business spending them.

### What broke on the way

- **Morphological close thickened the silhouette near the map border.** Erosion
  was treating a window that hangs over the edge as satisfied, so dilate grew
  into the border and erode could not pull it back — a 3x3 block in a 5-row
  image came back 5 rows tall. Outside the map is empty, the same rule the mask
  itself follows, so a clipped window can never be full. Caught by a test
  asserting close leaves the outline where it found it.
- **The stand-in map's sky was unrealistically dim** — luma 153 against walls at
  143, with ±13 grain on top. The threshold seed scored 77% against ground
  truth, and the errors were exactly what the overlap predicts: 36.3% of sky
  misread (predicted 36.5%), 24.8% of walls misread (predicted 24.0%). The seed
  was correct; the fixture had accidentally reproduced the precise failure SPEC
  §5.2 describes — "overcast sky is light grey and so is a rendered wall".
  Real overcast sky sits near luma 190, so the stand-in was corrected to match
  and the seed now scores 100% on it.

  Worth keeping in mind: that 77% is what a brightness threshold does when sky
  and wall are ten luma apart. It is the number that justifies the tool.

### Measurements

Threshold seed against the mask its fixture was generated from, 900x600:

| sky vs wall luma | agreement |
|---|---|
| 153 vs 143, grain ±13 (unrealistic) | 77.0% |
| 192 vs 143, grain ±13 (realistic) | 100.0% |

A real photograph will land between the two and nearer the bottom — trees,
shadowed brick and bright render all break the rule. The seed is worth having
because it is free, not because it is right.

### What is needed to close stage 2

Photographs, and nothing else. For each map, one image:

1. Drop it on `npm run masktool` → `http://localhost:5173/tools/masktool/`
2. Threshold seed, then paint the materials in
3. Despeckle, Check playability, Export
4. `npm run bake -- --photo <id>-texture.png --mask <id>-mask.png --id <id> --water <row>`
5. `npm run dev` → `?map=/maps/<id>/map.json`

SPEC §5.1 picks maps on **silhouette variety**, not subject, because that is
what makes them play differently when there is only one weapon: a tall building
face, an open street, a hedge-and-fence garden, a car park, a bridge or
underpass, something cluttered.

Two validated maps close the stage; the remaining four to six are day 8.

### Running it

```
npm test              # 83 tests (63 terrain, 20 mask ops)
npm run masktool      # the tool, at /tools/masktool/
npm run smoke:masktool  # headless: seed, paint, fill, despeckle, export
```

---

## Stage 3 — Stepped controller + tuning harness (2026-09-04)

Deliverable (SPEC §12, day 3): stepped character controller + tuning harness.
Exit criteria: circle walks slopes, rests without jitter over 1000 frames, takes
knockback; sliders live, write-back working.

### Status: met

- **102 tests pass**, including the 1000-frame rest test and the slope limit.
- **Tuning verified against disk, not assumed**: `npm run smoke:tune` drives the
  overlay in a browser and checks both directions — a slider changing
  `tune/physics.json`, and an edit to that file reaching the running game.

### Built

```
/src/physics
  collider.ts    circle vs mask; broadphase reject, bottom-up row scan
  body.ts        position, velocity, grounded, rest state, impact speed
  controller.ts  the stepped controller (SPEC §6.1)
/src/core/loop.ts    fixed timestep with a bounded catch-up
/src/tune
  physics.ts registry.ts harness.ts channel.ts monkey.ts
/tools/vite-plugin-tune.ts   dev-server half: hot reload and write-back
/tune/physics.json /tune/monkey.json
/tests/controller.test.ts /tests/loop.test.ts
/tools/smoke/tune-smoke.ts
```

### Decisions

- **Grounded and airborne are different code paths, deliberately.** A grounded
  body walks (stepped, a pixel at a time) and then settles; it never integrates.
  That is what makes a standing body perfectly still — there is no arithmetic
  running that could drift it. The 1000-frame test asserts exact equality on
  both axes, not a tolerance.
- **Airborne collision response is axis-separated.** Reflect along the blocked
  axis, take friction off the other. No normal is sampled anywhere in the file,
  because a sampled normal is what makes bitmap controllers jitter (SPEC §6.1)
  — there is deliberately no code here that could do it even by accident.
- **Unsticking is bounded at two diameters.** A spawn puts a body's centre on
  the surface pixel, so half of it starts buried; that plus a pixel of overlap
  from a landing is the realistic range. A body inside a slab thicker than that
  is left exactly where it is rather than teleported somewhere arbitrary — the
  turn machine resolves that case (SPEC §6.6), and an unbounded search would
  cost a column scan every frame.
- **Hot reload must not reload the page.** Vite's default for a changed JSON
  module is a full reload, which throws away the match you were tuning against
  — most of the value of tuning live. The plugin claims the update via
  `handleHotUpdate` and pushes new values over its own channel instead. The
  smoke test plants a sentinel on `window` and fails if it disappears.
- **A slider can never leave unloadable tuning behind.** Every change is parsed
  before it is applied and before it is written; a value that fails validation
  is rolled back in the UI and reported, not applied. `maxSubStepPx` of 0 is
  the test case — it would make a projectile loop forever.
- **Slider ranges live in `registry.ts`, not the JSON.** They are UI metadata;
  §7 says the JSON holds values.

### What broke on the way

- **The overlay pulled `node:fs` into the browser.** The harness imported its
  channel constants from the Vite plugin, which imports `node:fs/promises` and
  `vite`. The whole page failed to start. Constants now live in
  `src/tune/channel.ts`, which both halves import.
- **Hot-reloaded values that are not on a slider's step grid.** A hand-edited
  `gravity: 777` snaps the slider thumb to 780. The live tuning and the numeric
  readout both stay 777, which is the correct behaviour — the thumb is the only
  thing that rounds — but it is worth knowing before someone reads a position
  off the panel and believes it.

### Notes

- Knockback in the dev harness is a placeholder radial impulse. The real curves
  — damage and knockback falling off **independently**, which is non-negotiable
  (SPEC §6.3) — are `weapon.json` and arrive with the bazooka in stage 4.
- `/src/feedback` (the Hardwicke module, §0.1) is still unbuilt. I have no
  access to a Hardwicke repository from this session to check whether the
  tuning harness already exists there, so it was written here, with the generic
  half (`harness.ts`, `channel.ts`, the Vite plugin) separated from the
  Banana-specific half (`registry.ts`) so it can be copied across.

### Running it

```
npm test              # 102 tests
npm run smoke:tune    # sliders live, write-back and hot reload against disk
npm run dev           # [←/→] walk · [space] jump · [tab] next body · [t] tuning
```

---

## Stage 4 — Banana bazooka + dumb AI (2026-09-04)

Deliverable (SPEC §12, day 4): banana bazooka, dumb AI, touch input decision.
Exit criteria: firing works, AI plays, both aim schemes built and one chosen.

### Status: built. **The choice is yours — gate 1 is a hard stop.**

Both aim schemes are built; §6.3 says decide by testing them, and CLAUDE.md says
do not proceed past a gate without human sign-off. So this stops here.

### Built

```
/src/weapon/projectile.ts   generic projectile (shared, §0.1), exact integration
/src/weapon/explosion.ts    damage and knockback on independent curves
/src/wind/wind.ts           per-turn wind
/src/ai/aim.ts              nearest target, angle search, Gaussian error
/tune/weapon.json /tune/wind.json /tune/ai.json
/tests/weapon.test.ts       11 tests, including self-propulsion
```

Also fixed two things flagged earlier and left undone:

- **The sky is no longer thrown away.** Empty pixels now draw the photograph
  dimmed and desaturated as a backdrop, with terrain at full strength on top.
  The mask still means exactly what it meant for collision; it just no longer
  means "paint the app background here". `backdrop` is a slider.
- **The stand-in map is the street generator**, not flat colour blocks. It was
  already written for the how-it-works demo and sitting unused, which was
  daft — judging whether the game is fun against flat blocks is its own kind of
  misleading.

### Decisions

- **Exact integration, not Euler.** Drag is linear, so a step has a closed form.
  Using it makes the shot land precisely where the preview said it would.
  Euler at 1/120s drifted 7.6px over a two-second flight, and a preview that
  disagrees with the shot teaches players to stop trusting it — which would
  undo pillar 2, the whole game being the reading of an arc.
- **Damage and knockback are separate curves with separate maxima, radii and
  falloff powers.** Non-negotiable per §6.3, and there is a test asserting a
  shot that does zero damage still throws a body hard.
- **The AI solves by sampling angles against the analytic path.** Drag makes a
  closed-form solve unpleasant, and sampling costs no simulation and stays
  robust to whatever tuning does to the arc later.
- **The arc stays a clean parabola.** A banana-shaped flight is a tempting joke
  that would wreck the pillar; the sprite spins instead.

### What broke on the way

- **The closed-form solution had a sign error** — expanded at small drag it gave
  −½at² instead of +½at². The shot flew true because the integrator was
  separate, but the **trajectory preview curved the wrong way and the AI aimed
  at nonsense**, both of which read the same function. Caught by the §10 test
  pinning the integrator to the analytic arc: drift was 3201px.
- **Self-propulsion does not work by firing straight down.** A blast directly
  beneath throws a body straight up, and it lands where it started, having
  crossed nothing. The manoeuvre is to fire into the ground on the *trailing*
  side. The test now models that, and the current tuning clears the 120px
  `selfPropelGapMin` with 62 health to spare.
- An aim-solver test was failing because the target was simply out of range at
  that power. Targets are now picked by flying a known shot, so a solution
  provably exists.

### Not done, deliberately

- **Turn machine, teams, win conditions** — stage 5. Health and damage are
  tracked in the harness so shots visibly matter; that is not the state machine
  and does not pretend to be.
- **Camera** — stage 6. The map is still fit to the window, so a 1600px map is
  drawn at whatever fits.
- **Sprites, sound, HUD** — stages 7 and 9. Gate 1 is explicitly meant to be
  judged on grey circles.

### Gate 1 — what to do

`npm run dev`, then play for twenty minutes. The question is only: **is firing
satisfying?** Not whether it looks good — it deliberately does not.

- Drag from a monkey and release to fire; `[m]` swaps to the corner widget.
  §6.3 says decide between them by testing, so try both and say which.
- `[i]` takes an AI shot, `[w]` rerolls the wind, `[t]` opens the sliders.
- If it is not fun, the answer is to tune, not to build stage 5. Everything
  that affects feel is on a slider and writes back to disk, so what you land on
  is kept.
