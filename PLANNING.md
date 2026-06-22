# Planning — tldraw Line Rider

Living design/roadmap doc. Code-confirmed facts live in the README; this file
holds decisions and not-yet-built plans.

## Resolved decisions

### Which shapes are track (resolved)

Originally any non-scenery shape on the page collided, so text / images /
frames acted as invisible solid walls. **Resolved:** `collectSegmentsNow` now
gates on a `COLLIDABLE_TYPES` allowlist (`draw`, `line`, `geo`, `arrow`) in
[src/game/geometry.ts](src/game/geometry.ts); every other shape type is treated
as scenery (non-collidable). An allowlist (not a denylist) keeps any future
tldraw shape type non-collidable by default. Color still selects behavior
*within* those collidable types; a colorless collidable shape defaults to solid.

## Color → behavior: all 13 tldraw colors (shipped)

tldraw v5's default palette (`TLDefaultColorStyle`) has 13 colors. Every one now
maps to a gameplay role in `COLOR_TO_KIND` ([geometry.ts](src/game/geometry.ts)).
Lighter shades reuse their base color's kind at `strength: 0.5` — the "same kind,
tuned constant" approach — so the palette stays learnable and the switch in
`step()` stays small.

| Color           | Kind        | Behavior                                                     |
|-----------------|-------------|--------------------------------------------------------------|
| `black`         | solid       | **Solid** — basic collidable track (the default line).       |
| `grey`          | ice         | **Ice** — zero surface friction, max glide (white is invisible in light mode). |
| `red`           | accelerate  | **Accelerate** — tangential boost in the direction of travel.|
| `light-red`     | accelerate  | **Accelerate (weak)** — half-strength boost.                 |
| `orange`        | brake       | **Brake** — tangential drag, slows the sled.                 |
| `yellow`        | bounce      | **Bounce** — high restitution (springy trampoline).          |
| `green`         | scenery     | **Scenery** — decorative, non-collidable.                    |
| `light-green`   | scenery     | **Scenery** — non-collidable alias.                          |
| `blue`          | oneway      | **One-way** — collide from the front only.                   |
| `light-blue`    | oneway      | **One-way (flipped)** — blocks from below instead of above.  |
| `violet`        | sticky      | **Sticky** — strong tangential grip/friction.                |
| `light-violet`  | sticky      | **Sticky (weak)** — half-strength grip.                      |
| `white`         | ice         | **Ice** — alias of grey; unusable in light mode (invisible). |

Per-kind tunables (`brakeDrag`, `bounceRestitution`, `stickyFriction`,
`iceFriction`) live in the `PHYSICS` object; `strength` scales them per segment.

### Implementation notes

- **Where it lands:** the kind→behavior split already exists. `COLOR_TO_KIND`
  in [geometry.ts](src/game/geometry.ts) maps color → `LineKind`; `step` in
  [physics.ts](src/game/physics.ts) switches on `seg.kind`. New behaviors mean
  (1) extend the `LineKind` union in physics.ts, (2) add the color rows to
  `COLOR_TO_KIND`, (3) add the per-kind branch in the collision block.
- **Tunables:** new behaviors should get named constants in the `PHYSICS` object
  (e.g. `brakeDrag`, `bounceRestitution`, `iceFriction`) rather than literals,
  matching the existing `accelerateBoost` / `accelerateMaxSpeed` pattern.
- **Tunneling guard:** any behavior that raises speed (bounce, ice) must respect
  the `~2*riderRadius / FIXED_DT` tunneling threshold — cap speed like
  `accelerateMaxSpeed` does, or the sled shoots through thin lines.
- **Tests:** each new kind needs a `physics.test.ts` case proving its effect
  vs. plain solid (the accelerate/oneway tests are the template).
- **Weak vs. strong variants** are the same `LineKind` with a different constant,
  *or* distinct kinds — decide per behavior when implementing; prefer one kind +
  a magnitude field only if the math is otherwise identical.

### Remaining follow-ups

The color→behavior roadmap is fully shipped. Light-blue is now a flipped
one-way (blocks from below) via the per-segment `flip` flag, so blue and
light-blue give both gate directions.

Open ideas, none blocking:

- A visual hint of a one-way line's facing (e.g. an arrow) so players can tell
  blue from light-blue at a glance without the legend.

## Session follow-ups (2026-06-20)

Four reported issues. Status and decisions below.

### 1. Color behaviors felt like they weren't working — *fixed (tuning + a real bounce bug)* ✅

Diagnosis: the color→kind pipeline was wired correctly (sticky was visibly
working in-game), but two things hid the others:

- **Bounce had a real bug on the multi-point body.** The single-point `step()`
  bounce test passed, but the playing sled is a 4-point body and never rebounded.
  Only the bottom 1–2 corners contact a line, so per-point restitution reflected
  just those while the constraint solve averaged the rebound back to ~zero.
  **Fix:** bounce is now a whole-body effect (`stepBody`): sample the
  center-of-mass normal velocity before collisions, then correct it to an
  *absolute* target `-restitution * vnBefore` after, propagated to every point.
  Per-point bounce restitution is suppressed in the body path (`suppressBounce`)
  so it isn't double-counted. Setting an absolute target (not adding an impulse)
  was required — adding on top of residual COM velocity gained energy and the
  bounces grew without bound. Covered by a new body-level bounce test.
- **The other kinds were tuned too subtly to read.** Widened the gaps in
  `PHYSICS`: `surfaceFriction` 0.0015→0.02 (so ice/sticky contrast shows),
  `brakeDrag` 0.08→0.2, `stickyFriction` 0.25→0.45, `accelerateBoost`
  1200→2400, `accelerateMaxSpeed` 1000→1300 (still under the 1440 px/s tunneling
  threshold for `riderRadius:6` at `FIXED_DT`). The direction-based physics tests
  still hold.

### 2. Player character looked like a flat blue square — *fixed (polish)* ✅

Kept the constraint quad (decision: minimal change, not a full sled+rider
figure) but restyled it: rounded joins/caps, a soft drop-shadow to lift it off
the track, and a brighter lead-point dot so its heading/rotation reads. Styles
in `App.css` (`.lr-sled-body` / `.lr-sled-dot`).

### 3. Reset button + start-position marker — *done* ✅

- **Reset button** (`↺`) in the panel: stops any in-progress run (restoring
  editing) and re-seats the sled at the start point. It bumps a new
  `resetNonceAtom` (a counter, so repeated resets to the same start still
  register) which the rider watches alongside `startPointAtom` to rebuild its
  body. Clears the stats readout.
- **Start marker**: a dashed target ring + crosshair pinned to the spawn point
  (page space, via `pageToViewport` like the sled) drawn in the Rider overlay.
  Visible while stopped, hidden during a run.

### 4. Drag the player to move the start position — *planned, not yet built* ⏳

Goal: select + drag the sled/start marker to set the spawn point, instead of
only the "set start here" button. Design constraints to respect when building:

- The overlay (`Rider`) lives in `components.InFrontOfTheCanvas` with
  `pointer-events: none` and is **not** a tldraw shape — so it can't be selected
  with the native select tool. Options:
  1. Make the start marker an interactive overlay element (`pointer-events:
     auto` on the `<g>`) with its own pointer handlers that convert a drag in
     viewport space back to page space (`editor.screenToPage` /
     `viewportToPage`) and write `startPointAtom`. Keeps the native-first
     contract for *track* shapes; the marker is pure UI chrome. **Preferred.**
  2. Represent the start as a real native shape and read its position — heavier,
     pollutes the page with a non-track shape, and risks it being treated as
     scenery/collidable. Avoid.
- Only allow the drag while stopped (start is meaningless mid-run).
- Snap nothing; free placement. The sled re-seats immediately on change (the
  rider already rebuilds its body when `startPointAtom` changes).

## Surface sounds (shipped)

Give each surface an audible character so a player can *hear* what they're
riding. Built as designed below; the build-order checklist at the end is done.
Source of truth is the code: contact reporting in
[physics.ts](src/game/physics.ts) (`ContactEvent`), the synth in
[audio.ts](src/game/audio.ts) (`createAudioEngine` + `AUDIO`), the glue in
[Rider.tsx](src/game/Rider.tsx), and the mute toggle (`mutedAtom` in
[state.ts](src/game/state.ts) + the 🔊 button in [App.tsx](src/App.tsx)). Sound
recipes in `KIND_VOICE` / `AUDIO` are tune-by-ear starting points.

### What plays, and when

- **Sound key = kind + shape type.** The gameplay **kind** (solid / accelerate /
  brake / bounce / sticky / ice / oneway) picks the base sound *character*
  (timbre); the native **shape type** (`draw` / `line` / `geo` / `arrow`)
  modulates it (a pitch offset / waveform tweak). This keeps each kind
  recognizable while adding variety, and avoids hand-designing all ~28
  (kind × shape) combos. Mirrors the color→behavior contract: kind is the
  primary axis, shape is a secondary tuning knob.
- **Two trigger modes per surface:**
  - **Impact (one-shot):** fires the instant the sled *newly* enters contact
    with a surface of a given (kind, shape) — a tick / clack / boing. Must be
    debounced so it doesn't retrigger every substep while the sled rides the
    same surface (see "contact-enter detection").
  - **Sustained (ride):** a continuous tone that plays the whole time the sled
    is in contact, so a long line hums / scrapes. Volume and/or pitch scale with
    the sled's speed (`bodyVelocity`) — a fast ride is louder / higher. Stops
    when contact ends.
- **Scenery is silent.** Green / light-green is non-collidable (`collectSegmentsNow`
  skips it), so the sled never contacts it and it makes no sound. Falls out of
  "sound on contact only" — no special-casing.

### How audio is produced

- **Web Audio synthesis, no asset files.** Generate tones / noise procedurally
  via the Web Audio API (oscillators + noise buffers + gain / filter nodes).
  Fits the repo's "no extra deps, nothing to license/source" ethos and stays
  trivially tunable per kind. No binary audio assets enter the repo.
- **Per-kind sound recipe** (one synth voice per kind; shape applies an offset):

  | Kind        | Character (starting point — tune by ear)                  |
  |-------------|-----------------------------------------------------------|
  | solid       | soft filtered-noise scrape; low ride hum                   |
  | accelerate  | rising-pitch tone; ride pitch climbs with speed           |
  | brake       | downward "grinding" low-passed noise                      |
  | bounce      | short "boing" (pitched sine, fast decay) on each impact    |
  | sticky      | dull, damped low thud; muffled ride                       |
  | ice         | bright, airy high-frequency glide; clean sine ride        |
  | oneway      | same as solid (a solid that only blocks one side)         |

  Shape-type offset: e.g. `draw` = base, `line` = +N semitones, `geo` = −N,
  `arrow` = different waveform — small, consistent deltas so the kind still reads.

### Where it lands (architecture — respects the purity contract)

`physics.ts` is **pure & framework-free** and its unit tests rely on that, so it
must **not** call the Web Audio API. The split:

1. **physics.ts emits contact events, plays nothing.** `resolveCollisions`
   already computes, per point per segment, the contact normal, the segment's
   `kind` / `strength`, and the normal / tangential velocities — everything a
   sound needs. Add an *optional* output sink: `stepBody` (and `step`) accept an
   optional `contacts` accumulator that `resolveCollisions` pushes into when a
   point is in contact — `{ kind, strength, shape, speed }`. When the sink is
   omitted (the default, and what the tests pass), behavior is byte-identical to
   today. Physics *reports* contacts; it doesn't make noise, and it stays
   stateless.
   - Segments don't carry their source shape type today. **Decision:** thread it
     on. Add optional `shape?: TLShape['type']` to `Segment` / `TrackSegment` and
     set it in `makeSeg` (geometry.ts has the shape in scope). The contact event
     carries it through. `strength` is already on the segment.
   - **Contact-enter detection lives where the sound does (Rider), not in
     physics.** Physics reports "in contact this substep"; Rider diffs against
     the previous substep's contact set to find *enters*. Keeps physics
     stateless.

2. **A new `src/game/audio.ts` owns Web Audio.** Framework-free (no React), so
   it's testable in isolation like checkpoints.ts:
   - `createAudioEngine(): AudioEngine` — lazily builds the `AudioContext` and
     per-kind voice graph. Created / resumed on first **Play** (already a user
     gesture in `togglePlay`), satisfying the browser autoplay-gesture rule.
   - `engine.impact(kind, shape, speed)` — one-shot for a contact-enter.
   - `engine.setRide(contacts)` — given the set of currently-contacted
     (kind, shape, speed) this frame, drive sustained voices: ramp up voices that
     just started, ramp down ones that ended, set gain / pitch from speed.
     Idempotent per frame.
   - `engine.setMuted(bool)` / `engine.dispose()`.
   - All tunables (base freqs per kind, shape semitone offsets, attack / decay,
     speed→gain curve) live in an `AUDIO` constants object, mirroring the
     `PHYSICS` pattern — no inline literals.

3. **Rider.tsx is the glue.** In the rAF loop:
   - Build the engine once (ref); resume it when a run begins.
   - Pass a reused `contacts` array into `stepBody` each substep; after the
     substep, diff this frame's contact set vs. last frame's to find enters →
     `engine.impact(...)`; pass the live set to `engine.setRide(...)`.
   - On stop / pause, `engine.setRide([])` to silence sustained voices.
   - No per-frame React render — same imperative discipline as the SVG writes.

4. **A mute toggle in the control panel.** Add `mutedAtom` to state.ts (mirrors
   the other gameplay atoms; keeps `components` stable). App adds a 🔊 / 🔇 button
   next to Follow, `useValue`-mirrored; Rider reads `mutedAtom.get()` in its loop
   and calls `engine.setMuted`. On by default; reuse the `lr-active` styling.

### Tunneling / perf notes

- Sound emission adds **no new motion** and no speed — it can't worsen the
  `~2*riderRadius / FIXED_DT` tunneling threshold (it only reads velocity).
- Reuse one `contacts` array across substeps (clear, don't reallocate) so the
  120 Hz loop stays allocation-free, matching the loop's GC-quiet style.
- Impacts fire on enter only (debounced); sustained voice count is bounded by
  the few distinct (kind, shape) a sled can touch at once (realistically 1–2),
  so the Web Audio graph stays tiny.

### Build order

1. Add `shape?` to `Segment` / `TrackSegment` + set it in `makeSeg` (geometry.ts).
2. Add the optional contact sink to `resolveCollisions` / `stepBody` / `step`
   (physics.ts), default-off so existing tests are untouched. Add `physics.test.ts`
   cases: (a) omitting the sink ⇒ identical behavior, (b) riding a segment
   populates the sink with the right kind / shape / speed.
3. Build `src/game/audio.ts` (`createAudioEngine` + `AUDIO` constants). No React.
4. Wire it into Rider.tsx (engine ref, enter-diff, impact / setRide calls).
5. Add `mutedAtom` (state.ts) + mute button (App.tsx) + read in Rider.
6. Manual pass: ride each color, confirm distinct impact + sustained sound, speed
   scaling, mute, and silence on scenery / when stopped.
