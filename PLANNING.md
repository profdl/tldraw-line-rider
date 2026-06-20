# Planning — tldraw Line Rider

Living design/roadmap doc. Code-confirmed facts live in the README; this file
holds decisions and not-yet-built plans.

## Resolved decisions

### Which shapes are track (resolved)

Originally any non-scenery shape on the page collided, so text / images /
frames acted as invisible solid walls. **Resolved:** `collectSegments` now
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
| `grey`          | solid       | **Solid** — same as black; a neutral alias.                  |
| `red`           | accelerate  | **Accelerate** — tangential boost in the direction of travel.|
| `light-red`     | accelerate  | **Accelerate (weak)** — half-strength boost.                 |
| `orange`        | brake       | **Brake** — tangential drag, slows the sled.                 |
| `yellow`        | bounce      | **Bounce** — high restitution (springy trampoline).          |
| `green`         | scenery     | **Scenery** — decorative, non-collidable.                    |
| `light-green`   | scenery     | **Scenery** — non-collidable alias.                          |
| `blue`          | oneway      | **One-way** — collide from the front only.                   |
| `light-blue`    | oneway      | **One-way** — same; passes through from behind.              |
| `violet`        | sticky      | **Sticky** — strong tangential grip/friction.                |
| `light-violet`  | sticky      | **Sticky (weak)** — half-strength grip.                      |
| `white`         | ice         | **Ice** — zero surface friction, max glide.                  |

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

- The light-blue one-way is currently identical to blue. PLANNING originally
  floated an "opposite-facing" variant; revisit if a second one-way direction is
  wanted (would need a per-segment facing flag, not just `strength`).
