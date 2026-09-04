# Project Banana — Build Specification (rev 2, post-review)

**Genre:** Turn-based 2D artillery, Worms lineage
**Terrain:** Destructible, from real photographs
**Characters:** Monkeys
**Weapon:** One. A banana bazooka.
**Platform:** Browser, mobile-first, hot-seat multiplayer
**Team:** One driver + Claude Code
**Calendar:** Gate 1 on day 4. Shippable in ~10.

---

## Revision note

Rev 1 specced six days and got several things wrong. Changes:

1. **Auto-segmentation is out for v1** (§5.2). It doesn't work reliably on British photographs and the failure mode is pinholed masks that break physics. A mask paint tool replaces it — less work to build than to make segmentation work, and far more reliable at the scale you actually have.
2. **The character controller is now specced properly** (§6.1). "Circle vs mask" was underspecified and the naive version jitters and sinks.
3. **A dumb AI moves to day 4** (§6.4). Without it every iteration needs two people in the room, which is a development bottleneck, not just a missing feature.
4. **Self-damage as mobility is load-bearing** (§6.3) and constrains the knockback curve. This wasn't stated and it should have been.
5. **Gate 2 added on day 6** (§12). Gate 1 asks whether firing is satisfying; nothing asked whether a *match* is interesting, which is a different question and the one that decides whether one weapon is enough.
6. **Mask resolution capped, texture uploads specified** (§5.3, §10). Both were unbounded.
7. **Schedule is 10 days, not 6.**

---

## 0. Working agreement

1. `CLAUDE.md` at repo root holds the non-negotiable conventions and current stage. Under 100 lines.
2. **One stage per session.** Stages in §12, each with hard exit criteria.
3. **Tests first for anything deterministic.** Never for feel.
4. **No tuning values in code.** JSON only (§7).
5. Snapshot at every stage exit. Append to `CODE_LOG.md`.

### 0.1 Shared with Hardwicke

Three modules built once, copied:

- **Generic projectile system** — the parcel throw and the banana are the same thing with different parameters
- **Tuning harness** — hot-reload JSON, slider overlay, write-back to disk
- **Feedback module** — love/hate hotkeys, pause-and-note, audio flow questions

Note it in both `CLAUDE.md` files so neither instance writes its own.

---

## 1. Product definition

### 1.1 Pitch

Photograph your street. It becomes the battlefield. Two teams of monkeys blow it apart with banana bazookas, one turn at a time, passing the phone around.

### 1.2 Pillars

1. **Your street.** A real place the players recognise.
2. **Readable arcs.** The whole game is judging a parabola. If the preview and wind display aren't crystal clear, nothing else matters.
3. **Satisfying destruction.** Chunky and consequential, every time.

### 1.3 Non-goals for v1

- One weapon. No arsenal, no inventory, no selection UI.
- No online multiplayer. Hot-seat only.
- No rope, jetpack, or teleport.
- No falling terrain — disconnected chunks float, as in Worms Armageddon.
- No in-app map capture (§12.2 — comes after v1).
- No terrain persistence between matches.

### 1.4 Target hardware

60fps on a mid-range Android phone in Chrome. Mobile is primary — turn-based play, touch aiming and passing one device around all point the same way.

---

## 2. Decisions requiring sign-off

| # | Decision | Why | Reverse cost |
|---|---|---|---|
| B1 | Mobile-first browser | Turn-based, touch, hot-seat | Medium |
| B2 | Hot-seat only, no netcode | Deletes the highest-risk component | Low |
| B3 | Bitmap mask terrain, not vector | Destruction is a blit | Low |
| B4 | Custom physics, not a library | §4.2 | Medium |
| B5 | **Hand-painted masks, not auto-segmentation** | §5.2 | Low |
| B6 | Floating terrain, no collapse | Matches Worms, avoids a rabbit hole | Low |
| B7 | Single weapon | Gate 2 decides whether that holds | Low |

---

## 3. Safety, privacy, licensing

Small, but not empty.

- **Own photography for v1.** No licensing question, no moderation surface, and you pick locations that play well.
- **Mapillary is CC-BY-SA** if you use it later. Derived map images inherit share-alike; your code doesn't. A fine outcome, but decide it deliberately.
- **If in-app map capture ships** (§12.2): process on-device, never upload, never share between devices, store only the processed mask and texture, one-tap delete. If map sharing is ever added, **moderation becomes a release gate at that moment**, not a later feature.
- **Ratings:** monkeys, bananas, cartoon explosions, no blood. Comfortably PEGI 7. Characters vanish comedically at zero health; no ragdoll, no injury depiction.
- **Ad-eligibility trap:** a cartoon monkey game reads as child-directed to ad networks, which triggers the strictest restrictions. Ship v1 with no monetisation; decide with retention data.
- **Telemetry:** session ID only, never image data. Consent prompt, privacy policy, retention, deletion route.

---

## 4. Architecture

### 4.1 Stack

| Layer | Choice | Note |
|---|---|---|
| Language | TypeScript, strict | |
| Build | Vite | |
| Render | PixiJS | 2D, WebGL |
| Physics | **Custom** | §4.2 |
| Audio | Web Audio API | Pitch shifting matters (§13.3) |
| Storage | IndexedDB | Settings, local maps |

No ML dependency, no camera pipeline, no physics library.

### 4.2 Why custom physics

Rapier and Matter assume vector colliders. Your terrain is a bitmap that changes every explosion, so you'd re-triangulate a collider constantly and fight the engine.

The physics here is small enough to own: characters are circles doing per-pixel terrain probes, projectiles are points with drag and wind. No joints, no stacking, no friction solver. Roughly 300 lines, deterministic, fully tunable.

**Determinism is a test property, not an architectural constraint.** There's no netcode and no replay in v1 — keep it because it makes physics bugs reproducible, but don't let it drive design decisions.

### 4.3 Modules

```
/src
  /core        Loop, fixed timestep, input, event bus
  /terrain     Mask, rendering, destruction, per-pixel queries
  /physics     Character controller, projectile integrator
  /monkey      Sprites, animation, health, state
  /weapon      Banana bazooka (imports generic projectile — §0.1)
  /ai          Dumb opponent (§6.4)
  /turn        Turn state machine, win conditions
  /wind        Wind state and display
  /camera      Pan, zoom, follow, shake
  /hud         Aim UI, power, health, timer, wind gauge
  /tune        JSON load, hot reload, sliders
  /feedback    From Hardwicke

/tools
  masktool/    Standalone mask painting tool (§5.2)

/pipeline
  bake.ts      Photo + mask → game-ready assets. Pure JS, no WebGL.
```

**Stylisation runs in the browser at load time, not in the pipeline.** Rev 1 put the shader in `/pipeline`, which means WebGL in Node via headless-gl — an annoying dependency for no benefit. Bake the mask offline in pure JS; stylise once on load.

---

## 5. Terrain

### 5.1 Sources

Six to eight hand-shot maps for v1. Choose on **silhouette variety**, not subject — that's what makes maps feel different when there's one weapon:

- A tall building face — vertical, cover-heavy
- An open street — long sightlines, wind matters most
- A hedge-and-fence garden — soft terrain, everything blows apart
- A car park — chain explosions
- A bridge or underpass — layered platforms
- Something cluttered — poles, bins, mixed materials

### 5.2 The mask tool — replaces auto-segmentation

**Why segmentation is out.** Rev 1 called sky thresholding "nearly trivial." On real British photographs it isn't: overcast sky is light grey and so is a rendered wall, so brightness thresholding fails outright. Worse, trees against sky produce thousands of sky-coloured pixels between branches, giving a mask riddled with pinholes. Projectiles tunnel through hedges; monkeys fall through them. Fixing it needs morphological open/close and it still isn't reliable.

For six hand-shot maps, **ten minutes painting each mask by hand beats making segmentation work** — less code, more reliable, done. Auto-segmentation only earns its place when in-app capture ships and volume rises.

**Build a standalone tool in `/tools/masktool`.** Hybrid, not pure manual:

1. **Auto first pass** — brightness + position threshold gives you roughly 80% for free
2. **Paint and erase** — brush with adjustable size, assign material by brush selection
3. **Flood fill** for large uniform regions
4. **View toggle** — photo / mask / overlay at 50%
5. **Despeckle** — one-click morphological close to kill pinholes
6. **Export** — mask PNG (material IDs) plus the source texture

Ship it as a dev tool. It never goes in the game bundle.

### 5.3 Mask format

**Conventions — these go in `CLAUDE.md` and must not drift:**

- **One byte per pixel.** `0` = empty. Otherwise a material ID.
- Material IDs: `1` building, `2` ground, `3` vegetation, `4` vehicle, `5` pole.
- **Long edge capped at 2048px.** Downscale on ingest. A phone photo is 4000×3000 — unbounded that's a 12MB mask and a 48MB texture on a mid-range Android.
- **The mask is the collision.** No separate collision geometry exists anywhere in this game.
- Rendering: non-zero region as an alpha channel over the stylised texture.

| Material | Blast resistance | Behaviour |
|---|---|---|
| Building | High | Small craters, holds up |
| Ground | Medium | Standard crater |
| Vegetation | Low | Blows apart dramatically |
| Vehicle | Low | **Chain-explodes**, damages nearby |
| Pole | Very low | Snaps, leaves a gap |

Free tactical depth: hide behind the wall, not the hedge.

### 5.4 Destruction

- Explosion blits a transparent circle into the mask, radius scaled by the material under each pixel.
- **Update the GPU texture with `texSubImage2D` on the dirty rect only.** Never re-upload the full texture — that's the difference between 4ms and 40ms, and the naive implementation is the obvious one.
- **Rim shading:** darken the first few pixels inside a fresh edge so craters read as carved rather than cut out. Cheap, and most of why destruction looks good.
- **No collapse.** Disconnected chunks float.

### 5.5 Collision queries

- **Point test:** direct mask lookup, O(1).
- **Projectile:** step along the trajectory at sub-pixel intervals, point-test each step. Never integrate in large steps or fast shots tunnel through thin terrain.
- **Broadphase:** 16×16 coarse occupancy grid marking cells containing any solid pixel. Skips empty sky instantly.

### 5.6 Map validation

Automated, rejects unplayable maps before load:

- Between 25% and 75% solid pixels
- At least 8 valid spawn points — flat-ish, solid beneath, empty above
- No spawn isolated on an unreachable island
- Water line below the lowest spawn

---

## 6. Systems

### 6.1 Character controller — specced properly

Rev 1 said "sample 16 points around the circumference." That detects contact but gives no penetration depth and no surface normal, so the monkey sinks, catches on edges and jitters. Use a **stepped controller** instead — the standard solution in this genre.

**Grounded horizontal movement:**

```
for each 1px step in the move direction:
    if solid at foot level:
        for h in 1..maxStepHeight:
            if clear when raised by h:
                raise by h, advance, break
        else:
            stop — slope too steep
    else:
        advance
```

`maxStepHeight` is the slope limit, in `physics.json`. Around 4–6px is a sensible start.

**Grounded vertical settling:** probe down up to `maxSnapDistance`. Ground found → snap to it, stay grounded. Not found → become airborne.

**Airborne:** ballistic integration with stepped terrain collision. On contact, apply bounce and friction from `physics.json`, then test for rest — velocity below threshold for N consecutive frames.

**Never** resolve by pushing out along a sampled normal. That's what causes the jitter.

**Collider is a circle** regardless of sprite shape. Radius in `monkey.json`.

### 6.2 Monkeys

- Health 100, damage from blast falloff
- Walk left/right, blocked above the slope limit
- Small jump
- Knockback from explosions, including your own (§6.3)
- Fall damage above a velocity threshold
- Water at map bottom is instant death
- Death at 0 health: comedic vanish, no ragdoll

Teams of 3 or 4. Two teams.

**Sprites:** flat fills, heavy dark outlines, no gradients. They must sit legibly on a posterised photograph, and heavy outlines are what make small sprites read against busy backgrounds.

**Team readability is a functional problem, not a cosmetic one.** Two teams of small monkeys on a street photo at phone size. Full-body colour tints get lost against green and grey. **Use accessories — helmet or bandana — in reserved saturated colours** (§13.2).

**Animation is where the charm lives.** Idle fidget, panic on an incoming shot, celebration on a hit, sulk on a miss, squash on landing, limbs swinging with velocity. Worms' charm was never in its graphics.

### 6.3 The banana bazooka

**Input:** touch and drag — direction sets angle, length sets power, release fires.

**Touch aim is an open question, not a settled decision.** Drag-to-aim and drag-to-pan can't both own the same gesture, and on a phone your thumb covers the monkey and the first part of the arc — exactly what you're trying to read. Worms on mobile used a separate aim widget for this reason. **Test both on day 4 and decide there:** direct drag from the monkey, versus a fixed corner widget with the map free to pan.

**Trajectory preview:** dotted arc including wind. Mandatory. Fade the dots with distance so it hints rather than solves.

**Flight:** point projectile, gravity, drag, constant wind for the turn. Keep it a **clean parabola** — a curved banana-shaped path is a tempting joke that would wreck pillar 2. Spin the sprite instead; the parabola is already banana-shaped.

**Explosion:**

- Blast radius scaled per material
- Damage falls off with distance
- **Knockback falls off separately from damage, independently tunable.** Non-negotiable — almost every memorable moment in this genre lives in the gap between the two curves.
- Screen shake proportional to proximity
- Chain-triggers vehicle material
- Yellow splat particles

**Self-damage is mobility, and it constrains tuning.** With floating terrain, one weapon and no rope, a monkey stranded on a disconnected chunk has exactly one way off: shoot the ground beneath itself and ride the knockback. In Worms that's an advanced technique; here it's **mandatory to avoid stalemates**.

So the knockback curve isn't purely a feel value. It has a hard requirement: a monkey shooting the ground at its feet must reliably clear a gap of at least *G* pixels while surviving the self-damage. Put `G` in `weapon.json` and **write a test for it.**

**Wind:** changes each turn, displayed prominently, affects the projectile only. In a single-weapon game it's the main source of turn-to-turn variety — make the range generous enough to matter.

### 6.4 The AI — day 4, not "later"

Rev 1 filed this under future work. That was wrong: hot-seat with no AI means **every iteration needs two people in the room**. That's a development bottleneck for the entire remaining build, and a dumb AI is about two hours.

**Dumb AI v1:**

1. Pick the nearest living enemy
2. Solve the ballistic angle for that target, accounting for current wind
3. Add Gaussian error to angle and power, scaled by a difficulty value
4. Fire

That's it. No pathing, no movement, no target selection strategy. It's good enough to test with and its error term is a difficulty dial.

Put `aimErrorSigma` in `tune/ai.json` so you can make it useless or lethal from the slider overlay.

### 6.5 Camera

- Pan, pinch zoom, follow the active monkey
- Auto-follow the projectile in flight, then return
- Shake on explosion
- **Frame both the shooter and the arc on fire** — the reason to have a camera module at all

Day 6, alongside the first full matches.

### 6.6 Turn system

```
TURN_START → MOVE (timed) → AIM → FIRING → PROJECTILE_FLIGHT
  → RESOLUTION → SETTLE_WAIT → [win check] → TURN_START
```

- Move phase timer, tunable, default 30s. Firing ends it immediately.
- `SETTLE_WAIT` blocks until all monkeys are at rest and no explosion is pending.
- **Settle timeout failure mode must be explicit:** a monkey oscillating in a crater bowl may never come to rest. When `settleTimeout` fires, **force-freeze all bodies and advance the turn.** Log it — repeated timeouts mean the rest threshold is wrong.
- Chain reactions resolve fully within one `RESOLUTION`.
- Deaths queue and resolve together, then the win check runs once.
- **Sudden death** after N rounds: rising water. More dramatic than health-drop and easy given the mask.

**Edge cases, each gets a test:**

- Active monkey dies from its own shot
- All monkeys on both teams die simultaneously → draw, not a crash
- Last two die in the same explosion
- A monkey dies during another's turn (chain, drowning)
- Projectile still airborne when the turn timer expires
- Monkey knocked into water during `SETTLE_WAIT`
- Vehicle chain kills the active monkey
- Monkey comes to rest inside newly-created terrain
- Monkey knocked off the map edge horizontally
- Settle timeout fires mid-chain

---

## 7. Tuning

Every value affecting feel lives in hot-reloadable JSON with a slider overlay and **write-back to disk**. Built in stage 3, before the weapon.

```
/tune
  physics.json    gravity, drag, terminal velocity, friction,
                  maxStepHeight, maxSnapDistance, rest threshold
  weapon.json     muzzle velocity range, projectile mass/drag,
                  blast radius, damage curve, knockback curve,
                  selfPropelGapMin (G, §6.3), shake
  wind.json       range, change rate, projectile influence
  monkey.json     health, walk speed, jump, fall damage, collider radius
  terrain.json    per-material blast resistance, rim shade depth
  turn.json       move timer, settleTimeout, sudden death round
  ai.json         aimErrorSigma, difficulty presets
```

---

## 8. Telemetry and feedback

Import the Hardwicke feedback module (§0.1). Game-specific capture:

- Shot log: angle, power, wind, distance to nearest enemy, damage dealt, self-damage
- **Miss distance distribution** — the best single signal for whether the arc is readable. A long tail means the preview or wind display isn't working.
- Turn duration, unused move timer
- Self-damage rate — high means blast radius or knockback punishes the shooter unfairly
- Deaths by cause: direct, fall, water, chain
- Match length in turns
- Terrain destroyed per match, as a percentage
- **Settle timeout occurrences** — should be near zero

---

## 9. Performance budgets

Mid-range Android, Chrome.

| Metric | Budget |
|---|---|
| Frame time p50 | < 12ms |
| Frame time p99 | < 25ms |
| Mask point query | O(1) |
| Explosion mask blit + `texSubImage2D` | < 4ms |
| Mask memory | ≤ 4MB (2048px cap) |
| Map load | < 2s |
| Total download | < 12MB |

---

## 10. QA

Nearly everything except feel is testable here, because the game is deterministic maths over a bitmap. Lean on it hard.

**Terrain:**
- Explosion at P clears exactly the expected pixels for the material distribution under it
- Point query matches the mask byte at every pixel
- A fast projectile does not tunnel through 2px terrain
- Map validation rejects all-sky, all-solid, no spawns, isolated spawn
- Mask ingest downscales anything over 2048px

**Physics:**
- Projectile at angle A, power P, wind W lands within 2px of the analytic prediction
- A monkey resting on terrain does not drift, sink or jitter over 1000 frames
- Stepped controller climbs a slope at the limit and refuses one above it
- Damage at distance D matches the falloff curve
- **Self-propulsion: a monkey firing at its own feet clears `selfPropelGapMin` and survives** (§6.3)
- Determinism: same inputs from same state, identical outcome

**Turn machine:**
- Every §6.6 edge case
- No reachable state where no player can act
- Simultaneous death produces a draw
- Settle timeout force-advances rather than hanging

---

## 11. Art and audio

### 11.1 Stylisation

Applied in-browser at load. One WebGL shader:

- Slight blur (stops noise becoming banding)
- Posterise to 6–8 levels per channel
- Sobel edge detect composited as dark outlines
- Saturation lift, slight contrast crush

**Monkeys must be drawn to match it** — flat fills, heavy outlines. Sprites in a different visual language will look pasted on, and you'll notice on day 7 when it's expensive.

### 11.2 Palette

Photographs supply most of the colour, so gameplay-critical elements must sit clearly above them. Street photos are overwhelmingly green, grey and brown — the reserved colours exploit that.

| Role | Hex | Use |
|---|---|---|
| UI accent | `#FF2E63` | **Reserved.** Aim line, active marker, health bars, all UI |
| Team A | `#00E5FF` | Accessory only |
| Team B | `#B14EFF` | Accessory only |
| Explosion | `#FFD23F` | Banana splat and blast flash only |
| Water | `#1B3A57` | Kill zone |

None of these occur naturally in a street photograph. **Reserve them absolutely** — they appear nowhere decorative.

### 11.3 Audio

**Monkey chatter is your personality layer and it's cheaper than the alternative.** Worms' identity was its voice clips — actor, script, localisation per market. Monkey noises need none of that, are funny by default, and pitch-shift infinitely. Record a dozen, fix a pitch per monkey so each has a consistent voice, and you get more character than a voice budget would buy.

Cues: turn start, taking damage, near miss, celebration, panic on an incoming shot, drowning.

Also:

- **Firing** — sharp, punchy, short
- **Banana whistle in flight, pitch tracking velocity.** Sells the arc better than any visual.
- **Explosion** — three size tiers, low thump plus splat
- **Material debris** — glass, foliage, metal, keyed to §5.3
- **Turn transition**, ticking timer under 10s
- **Wind ambience** — volume tracks wind strength, a constant audible cue for the thing that most affects your shot

---

## 12. Plan

| Day | Deliverable | Exit criteria |
|---|---|---|
| **1** | Terrain core: mask format, load, render, destroy, query, broadphase | All terrain tests pass. Blit + `texSubImage2D` under 4ms. |
| **2** | Mask tool + first 2 maps baked | Two validated maps loading in the game |
| **3** | Stepped character controller + tuning harness | Circle walks slopes, rests without jitter over 1000 frames, takes knockback. Sliders live, write-back working. |
| **4** | Banana bazooka + dumb AI + touch input decision | Firing works. AI plays. Both aim schemes built and one chosen. |
| **4 end** | **GATE 1 — is firing satisfying?** | Grey circles, one map, no art. Play 20 min. **If it isn't fun here, stop and tune.** |
| **5** | Turn system, teams, win conditions, sudden death | Every §6.6 edge case tested and passing |
| **6** | Camera + three full matches playable | Arc and shooter framed on fire; matches complete without hangs |
| **6 end** | **GATE 2 — is a match interesting?** | Play three full matches. **Does anyone want a fourth?** If no, the grenade moves from §12.2 to now. |
| **7** | Monkey sprites, animation, team accessories | Teams distinguishable at a glance on every map at phone size |
| **8** | Remaining maps, wind display, map validation in CI | 6–8 maps, all validated |
| **9** | HUD, audio, feedback module | Arcs readable, wind legible, chatter in |
| **10** | Polish, perf pass, ship candidate | Budgets met, legals and privacy policy in |

**Gate 1 is the project.** One weapon means nowhere to hide. Test with grey circles — no monkeys, no art, no HUD. It's a better test without the distraction, and failing on day 4 costs four days rather than ten.

**Gate 2 asks a different question and it matters just as much.** Firing can be satisfying while a twenty-minute match is dull. With one weapon this is a live risk — you're essentially Pocket Tanks with a single shell. Finding out on day 6 leaves time to add the grenade; finding out on day 10 doesn't.

Ten days is achievable. Twelve wouldn't surprise me — days 5 and 7 are the likeliest to overrun.

### 12.1 Cut lines

1. Wind
2. Vehicle chain explosions
3. Sudden death
4. Maps down to 4
5. Fall damage
6. Idle animations (keep reactions, cut fidgets)

**Never cut:** trajectory preview, tuning harness, independent damage/knockback curves, the self-propulsion test, gate 1, gate 2.

### 12.2 After v1

1. **Grenade** — bouncy, timed, different tactical shape. Half a day. Promote immediately if gate 2 fails.
2. **In-app map capture** — the second half of the hook. Needs §3's on-device rules and, eventually, real segmentation.
3. Smarter AI — movement, target selection, actual difficulty tiers.
4. Online play — at which point map sharing moderation becomes a release gate.

---

## 13. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Firing isn't satisfying | Medium | **Fatal** | Gate 1 day 4, grey circles, independent curves |
| One weapon can't sustain a match | **Medium** | High | Gate 2 day 6. Grenade is half a day. |
| Turn state machine edge cases eat day 5 | **High** | Medium | Every case tested. Budget the full day. |
| Touch aim conflicts with pan | **High** | Medium | Build both on day 4, decide by testing |
| Character controller jitters | Medium | High | Stepped controller (§6.1), 1000-frame rest test |
| Stalemate — monkey stranded, can't self-propel | Medium | High | `selfPropelGapMin` test (§6.3) |
| Teams not distinguishable on busy maps | Medium | High | Accessories not tints; check at phone size on every map |
| Monkeys look pasted onto photos | Medium | Medium | Draw to match the filter; check on a real map on day 7 |
| Mask memory on mid-range Android | Low | Medium | 2048px cap, dirty-rect uploads |
