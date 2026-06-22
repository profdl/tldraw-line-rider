# CLAUDE.md

Guidance for working in this repo. Keep it short and true to the code — if a
fact here drifts from the source, fix the source of truth (the code / README)
and update this file.

## What this is

A [Line Rider](https://en.wikipedia.org/wiki/Line_Rider) clone on **tldraw v5**:
draw track on the canvas, hit Play, watch a snail on a constraint-solved sled rig
ride it under a hand-rolled Verlet physics sim — upright and tracking the slope,
ragdolling on a hard crash. **Vite + React 19 + TypeScript**, no physics-engine
dependency.

## Commands

```bash
npm run dev    # vite dev server -> http://localhost:5173
npm run build  # tsc -b + vite build (run this to type-check)
npm test       # vitest run (physics unit tests)
npm run lint   # eslint
```

## Architecture

Read [README.md](README.md) for the file-by-file map; it's accurate. The short
version:

- [src/App.tsx](src/App.tsx) — mounts `<Tldraw>`, control panel, mounts `Rider`
  via `components.InFrontOfTheCanvas`. Toggles `isReadonly` while playing. The
  `components` object is a **module-level constant** (stable identity) so the
  overlay never remounts; gameplay state flows through atoms (see state.ts), not
  props.
- [src/game/state.ts](src/game/state.ts) — the shared gameplay atoms
  (`playing`/`follow`/`startPoint`/`showCollisions` inputs, `stats`/`score`
  outputs). `showCollisions` is a debug toggle that makes `Rider` draw the actual
  collision geometry (each shape's segments + the sled rig's contact circles).
  Atoms, not React state/props, so `App`'s `components` object stays referentially stable —
  threading these through props would remount `Rider` mid-ride and snap the sled
  to the start. App mirrors them with `useValue`; Rider polls/writes them in its
  rAF loop.
- [src/game/geometry.ts](src/game/geometry.ts) — turns collidable native page
  shapes into page-space collision segments; maps shape **color → `LineKind`**.
  Also collects `note` shapes as scoring checkpoints (oriented boxes, so a
  rotated note's catch region matches its footprint, not its inflated AABB).
- [src/game/checkpoints.ts](src/game/checkpoints.ts) — pure checkpoint hit-test
  (point-in-oriented-box, scored once per run). **Pure & framework-free.**
- [src/game/physics.ts](src/game/physics.ts) — the sim. The rider is a **sled
  rig** (`makeBody`/`stepBody`): a runner base (`BACK`<->`FRONT`) plus a mast held
  upright by a spring (`applyUpright`), so it rides upright and **tracks the
  slope** (`bodyAngle`) like classic Line Rider instead of tumbling — until a hard
  hit latches `body.crashed` (see `shouldCrash`) and the spring switches off so it
  ragdolls. `step()` is the single-point primitive the rig reuses, so both share
  one collision path (`resolveCollisions`). `PHYSICS` holds all tunables. **Pure &
  framework-free** — keep it that way so the unit tests stay simple. It reports
  surface contacts for audio by *pushing* `ContactEvent`s into an optional sink
  (`step`/`stepBody`'s last arg); omit the sink and behavior is byte-identical, so
  it makes no sound itself.
- [src/game/audio.ts](src/game/audio.ts) — surface sounds, voiced with the
  Salamander Grand piano via `@tonejs/piano` (on Tone.js). **Pure of
  React/tldraw**; the rAF loop is its only caller, through the same
  `AudioEngine` interface as before (`resume`/`impact`/`setRide`/`setMuted`/
  `dispose`), so swapping the synth didn't touch `Rider`. A piano is struck, not
  a drone, so surfaces are sonified as **notes**: `impact` strikes a note on
  contact-enter; `setRide` retriggers a soft note on a speed-scaled cadence while
  riding. Each `LineKind` owns a register + scale (`KIND_NOTES`); speed climbs
  the scale. Samples **stream from the library's CDN (tambien.github.io) on first
  play** and the browser caches them; `load()` is async and all sound is skipped
  until it resolves. All tunables in the `AUDIO` object.
- [src/game/SnailArt.tsx](src/game/SnailArt.tsx) — the snail character SVG,
  normalized to a belly-centered, +x-facing local frame the rig places each frame.
- [src/game/Rider.tsx](src/game/Rider.tsx) — fixed-timestep rAF loop; draws the
  snail (`SnailArt`) as an SVG group, writing its transform (position from
  `bodyCenter`, rotation from `bodyAngle`, scale from zoom) imperatively each
  frame (no per-frame React render). Owns the audio engine: passes a reused
  contact sink into `stepBody`, does enter-detection (diffs this substep's
  contact keys vs. last) to fire impacts, and drives the ride voices.

## Core design contract: native-first

There is **no custom shape and no custom tool**. Users draw with tldraw's
built-in pencil/geo/line tools and pick a color; we read each shape's geometry
and interpret its color as gameplay behavior. Preserve this — prefer reading
native shapes over inventing custom records.

## Gotchas (things that will bite you)

- **Position the overlay with `editor.pageToViewport`, not `pageToScreen`.** The
  sled lives in `components.InFrontOfTheCanvas`, which tldraw mounts inside the
  editor *container* (CSS `inset: 0` on `.lr-sled-svg`). `pageToViewport` returns
  container-relative coords; `pageToScreen` returns window-relative ones and
  drifts by the container's screen offset whenever the editor isn't flush to the
  window. See the comment in `Rider.tsx`.
- **Keep the `components` object referentially stable.** It's a module-level
  const in App.tsx. tldraw remounts a `components` slot when the object's
  identity changes, so threading volatile state (play/follow/start/stats) through
  it would remount `Rider` and reset its rAF loop mid-ride. That state lives in
  atoms (state.ts) instead; the overlay reads/writes them, App mirrors with
  `useValue`.
- **Pass the shape *id* (not the snapshot object) to geometry/transform reads,
  and read them reactively.** tldraw's `getShapeGeometry` / `getShapePageTransform`
  are reactive computeds that invalidate **automatically** when a shape's props
  change (epoch-based). The freshness bug we hit — stale geometry after dragging a
  shape — was caused by passing the *enumerated snapshot object* to these calls;
  passing `shape.id` makes the cache resolve against the live record and fixes it.
  We batch the per-collect reads in `editor.run(..., { history: 'ignore' })` so
  they don't interleave with concurrent reactions, but the transaction does **not**
  force a cache recompute — invalidation is automatic. Prefer the reactive
  `makeSegmentsComputed` / `makeCheckpointsComputed` views (read `.get()`) over
  re-walking the page each frame: they only recompute when shapes change. See
  `collectSegments` / `makeSegmentsComputed` in geometry.ts.
- **Draw (pencil) shapes hold multiple strokes** separated by pen-lifts. Decode
  each stroke with `getPointsFromDrawSegment` and push it separately — never
  bridge across strokes or you draw phantom collision lines.
- **Collision is swept, not proximity-only.** `resolveCollisions` resolves each
  point against a segment via `sweptContact`, which tests the point's THIS-STEP
  motion (`prev`→`pos`) against the line and orients the contact normal toward
  the side the point came from. This is what stops a fast point tunneling through
  a thin line, and stops the "ejected into the inside of a box" bug (a one-sided
  push-out using `pos - closestPoint` sends a point that landed just past a line
  deeper through it). A consequence: collision no longer depends on a shape's
  outline winding, so rotating/transforming a geo shape can't flip which side is
  solid.
- **Tunneling threshold (still keep it).** Swept collision catches a single
  thin-line cross, but stacked thin lines or huge per-step jumps can still slip
  through. Any new behavior that raises speed should stay under
  `~2 * riderRadius / FIXED_DT`; `accelerateMaxSpeed` is the existing cap — copy
  that pattern rather than relying on the swept test alone.
- **New physics tunables go in the `PHYSICS` object**, not as inline literals.
- **Only `COLLIDABLE_TYPES` shapes are track.** `collectSegments` allowlists
  `draw`/`line`/`geo`/`arrow`; text, images, frames, etc. are skipped so they
  don't act as invisible walls. To make a new shape type ridable, add it there.

## Adding a line behavior (color → kind)

The kind→behavior split already exists. To add one:
1. extend the `LineKind` union in physics.ts,
2. add color rows to `COLOR_TO_KIND` in geometry.ts,
3. add the per-kind branch in the collision block in `step()`,
4. add a `physics.test.ts` case proving the effect vs. plain solid,
5. add a `DEBUG_KIND_COLOR` entry in Rider.tsx and a `KIND_NOTES` entry in
   audio.ts. Both are typed `Record<LineKind, …>`, so the compiler (and a failing
   `npm run build`) will tell you if you forget — but the audio one is a runtime
   lookup, so don't skip it. Optionally add a `LEGEND` row in App.tsx (UI only).

The full color→behavior roadmap (all 13 tldraw colors) lives in
[PLANNING.md](PLANNING.md).

## tldraw v5 reference

Offline copies of tldraw's LLM doc exports (pinned at download time) live in
[docs/tldraw/](docs/tldraw/):

- `llms.txt` — the index. **Start here** to find the right SDK feature, then
  read its section.
- `llms-docs.txt` — full SDK feature guides (shapes, geometry, camera,
  coordinates, components, `editor.run`, etc.).

When unsure about a tldraw API, consult these before guessing. They're a
snapshot — for anything version-sensitive, confirm against the installed
`tldraw` package version (`^5.1.1`).
