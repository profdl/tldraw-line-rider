# tldraw Line Rider

A [Line Rider](https://en.wikipedia.org/wiki/Line_Rider) clone built on top of
[tldraw](https://tldraw.dev) v5. Draw track lines on an infinite canvas, hit
**Play**, and watch a sled ride your track under a custom physics simulation.

## Stack

- **Vite + React + TypeScript**
- **tldraw v5** as the canvas / editor engine
- A hand-rolled **Verlet physics** sim (no physics-engine dependency)

## Run it

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # type-check + production build
```

## How it's wired

```
src/
  App.tsx              Mounts <Tldraw>, registers the custom shape + tool,
                       renders the game UI panel and the rider overlay.
  App.css              Styling for the control panel.
  game/
    physics.ts         The sim: a point-mass sled under gravity, colliding
                       against line segments (Verlet integration).
    LineShape.tsx      Custom 'line-track' tldraw shape (one segment per shape).
                       Registered into tldraw's TLGlobalShapePropsMap so the
                       editor's generic APIs recognize the type.
    LineTool.ts        Custom StateNode: drag-to-draw a track line.
    Rider.tsx          Reads all 'line-track' shapes as physics segments, runs
                       a fixed-timestep rAF loop, and draws the sled as an
                       overlay (InFrontOfTheCanvas) positioned via pageToScreen.
```

### Line types

- **solid** — collidable track (black)
- **accelerate** — currently collidable like solid (red); hook for a boost line
- **scenery** — decorative, non-collidable (green)

## Where to take it next

- **Accelerate lines**: in `physics.ts`, tag segments with their `kind` and add
  a tangential impulse along `accelerate` segments during collision resolution.
- **A real sled**: replace the single point mass with 2–4 linked points
  (constraint-solved) for a body that tumbles, matching classic Line Rider.
- **Scoring**: `Rider.tsx` already reports distance + speed via `onStats`; add
  flag/checkpoint shapes and award points when the sled passes them.
- **Camera follow**: in the rAF loop, call `editor.centerOnPoint(riderPos)` (or
  `setCamera`) to keep the sled in view.
- **Persistence**: pass a `persistenceKey` to `<Tldraw>` to auto-save tracks.
