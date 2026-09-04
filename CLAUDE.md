# CLAUDE.md — Project Banana

Turn-based 2D artillery game. Destructible terrain from photographs. Monkeys, one weapon (banana bazooka), hot-seat multiplayer, mobile-first browser.

Full spec: `SPEC.md`. Read the relevant section before implementing anything.

**Current stage: 4** — stages 1 and 3 complete; stage 2's maps need photographs. See `CODE_LOG.md`.

---

## Stack

TypeScript (strict) · Vite · PixiJS · Web Audio API · IndexedDB
**Custom physics — no Rapier, no Matter.js.** Terrain is a mutable bitmap; vector-collider libraries fight it. See SPEC §4.2.

---

## Non-negotiable conventions

**Mask format**
- One byte per pixel. `0` = empty.
- Materials: `1` building, `2` ground, `3` vegetation, `4` vehicle, `5` pole.
- Long edge capped at **2048px**. Downscale on ingest.
- **The mask is the collision.** No separate collision geometry exists in this project.

**Rendering**
- Mask updates to GPU use `texSubImage2D` on the dirty rect only. Never re-upload the full texture.
- Stylisation shader runs in-browser at load time, never in `/pipeline`.

**Physics**
- Character controller is **stepped**, not normal-based. See SPEC §6.1. Never resolve by pushing out along a sampled normal — it jitters.
- Collider is a circle regardless of sprite shape.
- Projectiles step along the trajectory at sub-pixel intervals. Never integrate in large steps.

**Tuning**
- Every value affecting feel lives in `/tune/*.json`, hot-reloaded, with a slider in the dev overlay and write-back to disk.
- **A magic number affecting feel is a bug.** No exceptions.

**Determinism**
- Same inputs from same state produce identical outcomes. This is a test property that makes physics bugs reproducible — it is not an architectural constraint. Don't contort design around it.

---

## Working agreement

- **One stage per session.** Stages and exit criteria in SPEC §12.
- **Tests first** for anything deterministic: mask ops, projectile maths, damage curves, turn state machine. Never for feel.
- Stop at each stage exit. Report what was built, what was deferred, what broke. Append to `CODE_LOG.md`.
- **Hard stop at gates** (end of day 4, end of day 6). These require a human to play the game. Do not proceed past a gate.

---

## Shared with the Hardwicke project

Three modules are built once and copied between projects. Check whether Hardwicke has already built them before writing your own:

- **Generic projectile system** — parcels there, bananas here. Same system, different parameters.
- **Tuning harness** — hot-reload JSON, slider overlay, write-back.
- **Feedback module** — love/hate hotkeys, pause-and-note, audio flow questions.

---

## Do not

- Do not add a second weapon. One weapon is a deliberate decision (SPEC §1.3).
- Do not add networking. Hot-seat only.
- Do not implement falling/collapsing terrain. Disconnected chunks float.
- Do not build auto-segmentation. Masks are hand-painted via `/tools/masktool` (SPEC §5.2).
- Do not add a physics library.
- Do not put tuning values in code.
- Do not proceed past a gate without human sign-off.
