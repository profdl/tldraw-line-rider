# tldraw Line Rider

A [Line Rider](https://en.wikipedia.org/wiki/Line_Rider) clone built on top of
[tldraw](https://tldraw.dev) v5. Draw track lines on an infinite canvas, hit
**Play**, and watch a sled ride your track under a custom physics simulation.

## Stack

- **Vite + React + TypeScript**
- **tldraw v5** as the canvas / editor engine
- A hand-rolled **Verlet physics** sim (no physics-engine dependency)

> Working on the code? See [CLAUDE.md](CLAUDE.md) for architecture notes and
> gotchas, and [docs/tldraw/](docs/tldraw/) for offline tldraw v5 SDK docs.

## Run it

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # type-check + production build
```

## How it's wired

This is a **native-first** design: there is no custom shape or tool. Users draw
with tldraw's built-in pencil/geo/line tools and pick a color; we read every
shape's geometry and interpret its color as gameplay behavior.

```
src/
  App.tsx              Mounts <Tldraw>, renders the control panel and the rider
                       overlay (via components.InFrontOfTheCanvas). Toggles the
                       editor read-only while playing.
  App.css              Styling for the control panel and the sled.
  game/
    geometry.ts        Turns collidable native shapes on the current page into
                       page-space collision segments via getShapeGeometry /
                       getPointsFromDrawSegment. Maps shape color -> LineKind.
                       Also collects note shapes as scoring checkpoints.
    checkpoints.ts     Pure checkpoint hit-testing (point-in-box, scored once).
    physics.ts         The sim: a point-mass sled under gravity, colliding
                       against line segments (Verlet integration). Honors each
                       segment's kind (accelerate / oneway).
    physics.test.ts    Vitest unit tests for the sim.
    Rider.tsx          Snapshots segments on play, runs a fixed-timestep rAF
                       loop, and draws the sled as an overlay positioned via
                       pageToScreen.
```

### Line types (by shape color)

Each color maps to a gameplay `LineKind`. "Light-" variants reuse the same kind
at half strength (a weaker version of the same effect).

- **solid** — collidable track (black / grey)
- **accelerate** — adds a tangential boost along the line (red; light-red = weak)
- **brake** — tangential drag that slows the sled as it rides (orange)
- **bounce** — springy, high-restitution rebound (yellow)
- **sticky** — strong tangential grip/friction (violet; light-violet = weak)
- **ice** — frictionless surface, maximum glide (white)
- **oneway** — collidable only from the front; passes through from behind (blue / light-blue)
- **scenery** — decorative, non-collidable (green / light-green)

## Where to take it next

- **A real sled**: replace the single point mass with 2–4 linked points
  (constraint-solved) for a body that tumbles, matching classic Line Rider.
- **Scoring** *(done)*: drop **sticky-note shapes** as flags; the sled collects
  each the first time it passes through, and the panel shows a `collected/total`
  count. See [checkpoints.ts](src/game/checkpoints.ts) (pure hit-test) and
  `collectCheckpoints` in [geometry.ts](src/game/geometry.ts).
- **Camera follow** *(done)*: the rAF loop in [Rider.tsx](src/game/Rider.tsx)
  eases the viewport center toward the sled while playing (toggle with the 🎥
  button). Lerped, not snapped, and run with `history: 'ignore'`.
